import {
  DeviceMilestoneSource,
  DeviceStage,
  DeviceType,
} from '../../common/enums';
import { Device } from '../entities/device.entity';
import { deviceStage, toDeviceView } from './device-view';

/**
 * La etapa y el bloque del portal: lo que la pantalla de fábrica muestra y lo
 * que se imprime en la etiqueta.
 */
function equipo(parcial: Partial<Device> = {}): Device {
  return {
    id: 1,
    serial: 'AV-A842E38FCA6C',
    mac: 'A842E38FCA6C',
    type: DeviceType.COMMUNITY_ALARM,
    claimCode: 'K7M2QX',
    createdAt: new Date('2026-08-04T10:00:00Z'),
    mqttProvisionedAt: new Date('2026-08-04T10:00:01Z'),
    labeledAt: null,
    firstConnectionAt: null,
    firstConnectionSource: null,
    testedAt: null,
    readyAt: null,
    portalAdminEnc: 'blob-admin',
    portalCpsEnc: 'blob-cps',
    portalDerivedAt: new Date('2026-08-04T10:00:01Z'),
    boardModel: null,
    boardSeq: null,
    ...parcial,
  } as Device;
}

describe('deviceStage', () => {
  it('un equipo recién fabricado arranca en MANUFACTURED', () => {
    expect(deviceStage(equipo())).toBe(DeviceStage.MANUFACTURED);
  });

  it('MANUFACTURED es el piso: si el equipo existe, se fabricó', () => {
    // El alta atómica no deja nacer un equipo sin credencial, así que no hay
    // etapa anterior a esta.
    expect(deviceStage(equipo({ mqttProvisionedAt: null }))).toBe(
      DeviceStage.MANUFACTURED,
    );
  });

  it('revocar la credencial NO devuelve el equipo a una etapa anterior', () => {
    // Es estado de la credencial, no etapa de puesta en marcha. Mezclarlos
    // hacía que un equipo revocado apareciera como "creado".
    const revocado = equipo({ mqttProvisionedAt: null });
    expect(deviceStage(revocado)).toBe(DeviceStage.MANUFACTURED);
  });

  it('etiquetar NO mueve la etapa', () => {
    // Imprimir la etiqueta es una tarea de fábrica, no un avance en la puesta
    // en marcha. Cuando sí contaba, un equipo YA CONECTADO podía "retroceder"
    // a etiquetado solo por el orden en que se hicieron las cosas.
    expect(deviceStage(equipo({ labeledAt: new Date() }))).toBe(
      DeviceStage.MANUFACTURED,
    );
  });

  it('la primera conexión lo mueve a CONNECTED', () => {
    const conectado = equipo({
      firstConnectionAt: new Date(),
      firstConnectionSource: DeviceMilestoneSource.OBSERVED,
    });
    expect(deviceStage(conectado)).toBe(DeviceStage.CONNECTED);
  });

  it('la prueba funcional lo mueve a TESTED', () => {
    const probado = equipo({
      firstConnectionAt: new Date(),
      firstConnectionSource: DeviceMilestoneSource.OBSERVED,
      testedAt: new Date(),
    });
    expect(deviceStage(probado)).toBe(DeviceStage.TESTED);
  });

  it('el visto bueno gana sobre todo lo demás', () => {
    const listo = equipo({
      firstConnectionAt: new Date(),
      firstConnectionSource: DeviceMilestoneSource.OBSERVED,
      testedAt: new Date(),
      readyAt: new Date(),
    });
    expect(deviceStage(listo)).toBe(DeviceStage.READY);
  });

  it('no exige que los hitos anteriores estén cumplidos', () => {
    // Informa hasta dónde llegó; el detalle fino lo da `milestones`. Un equipo
    // aprobado sin haber conectado nunca es raro, pero decir que está en
    // MANUFACTURED sería peor que decir la verdad.
    const salteado = equipo({ firstConnectionAt: null, readyAt: new Date() });
    expect(deviceStage(salteado)).toBe(DeviceStage.READY);
  });
});

describe('bloque del portal', () => {
  it('compone SSID y QR a partir de la MAC, sin guardar nada', () => {
    const { portal } = toDeviceView(equipo());

    expect(portal).not.toBeNull();
    expect(portal!.ssid).toBe('AlarmaVecinal-A842E38FCA6C');
    // AP abierto: T:nopass y sin campo P:. Con T:WPA varios teléfonos fallan.
    expect(portal!.qrWifi).toBe('WIFI:S:AlarmaVecinal-A842E38FCA6C;T:nopass;;');
    expect(portal!.url).toBe('http://192.168.4.1');
  });

  it('el QR de la app lleva marca de versión, serial y claim code', () => {
    // Las etiquetas se pegan a un poste y no vuelven: cuando el formato cambie,
    // la app tiene que poder distinguir una vieja de una nueva.
    const { portal } = toDeviceView(equipo());
    expect(portal!.qrApp).toBe('CPS1|AV-A842E38FCA6C|K7M2QX');
  });

  it('un equipo ya instalado no tiene claim code y el QR lo refleja', () => {
    const { portal } = toDeviceView(equipo({ claimCode: null }));
    expect(portal!.qrApp).toBe('CPS1|AV-A842E38FCA6C|');
  });

  it('sin descifrador la password va en null', () => {
    // Es el caso de los LISTADOS: una lista de 200 equipos no puede ser un
    // volcado de 200 passwords.
    const { portal } = toDeviceView(equipo());
    expect(portal!.password).toBeNull();
  });

  it('con descifrador devuelve la password de admin', () => {
    const { portal } = toDeviceView(equipo(), [], (blob) =>
      blob === 'blob-admin' ? '2B0C49' : null,
    );
    expect(portal!.password).toBe('2B0C49');
  });

  it('NUNCA expone la password de cps', () => {
    // El firmware es explícito: jamás se imprime. Va por su propio endpoint,
    // con otro permiso y audit_log.
    const vista = toDeviceView(equipo(), [], () => 'lo-que-sea');
    expect(JSON.stringify(vista.portal)).not.toContain('cps');
  });

  it('los tipos que no son alarma comunitaria no tienen portal', () => {
    const { portal } = toDeviceView(equipo({ type: DeviceType.SIREN }));
    expect(portal).toBeNull();
  });

  it('sin MAC no hay portal que mostrar', () => {
    const { portal } = toDeviceView(equipo({ mac: null }));
    expect(portal).toBeNull();
  });
});
