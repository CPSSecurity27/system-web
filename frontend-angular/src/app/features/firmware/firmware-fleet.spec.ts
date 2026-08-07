import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';

import { FirmwareService } from '../../core/api/firmware.service';
import { EquipoFirmware } from '../../core/models/api.models';
import { FirmwareFleet } from './firmware-fleet';

function equipo(cambios: Partial<EquipoFirmware> = {}): EquipoFirmware {
  return {
    deviceId: 1,
    serial: 'AV-000000000001',
    nombre: 'Zona A',
    barrioId: 1,
    barrio: 'Barrio Test',
    cuenta: 'Muni Test',
    fw: 'new_0_6_0',
    estado: 'al_dia',
    online: true,
    durmiendoHasta: null,
    modoEnergia: 'ACTIVE_240',
    otaEnCurso: null,
    progreso: null,
    confirmacion: null,
    ...cambios,
  };
}

describe('FirmwareFleet', () => {
  let fixture: ComponentFixture<FirmwareFleet>;
  let componente: FirmwareFleet;
  let api: { flota: ReturnType<typeof vi.fn>; actualizar: ReturnType<typeof vi.fn> };

  function montar(equipos: EquipoFirmware[], publicada: string | null = 'new_0_7_0') {
    api = {
      flota: vi.fn().mockReturnValue(of({ publicada, equipos })),
      actualizar: vi.fn().mockReturnValue(of([])),
    };

    TestBed.configureTestingModule({
      imports: [FirmwareFleet],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: FirmwareService, useValue: api },
      ],
    });

    fixture = TestBed.createComponent(FirmwareFleet);
    componente = fixture.componentInstance;
    fixture.detectChanges();
  }

  // ── La comparación ───────────────────────────────────────────────

  it('cuenta atrasados, al día y sin datos por separado', () => {
    montar([
      equipo({ deviceId: 1, fw: 'new_0_7_0', estado: 'al_dia' }),
      equipo({ deviceId: 2, fw: 'new_0_6_0', estado: 'atrasado' }),
      equipo({ deviceId: 3, fw: null, estado: 'desconocido' }),
    ]);

    expect(componente['alDia']()).toBe(1);
    expect(componente['atrasados']()).toBe(1);
    expect(componente['desconocidos']()).toBe(1);
  });

  it('los desactualizados van primero: es a lo que se vino', () => {
    montar([
      equipo({ deviceId: 1, estado: 'al_dia' }),
      equipo({ deviceId: 2, estado: 'desconocido' }),
      equipo({ deviceId: 3, estado: 'atrasado' }),
    ]);

    expect(componente['ordenados']().map((e) => e.deviceId)).toEqual([3, 2, 1]);
  });

  // ── La selección ─────────────────────────────────────────────────

  it('"elegir los desactualizados" NO agarra los que nunca conectaron', () => {
    // Un equipo sin `fw` no está atrasado: no sabemos qué tiene. Meterlo en la
    // bolsa haría que la pantalla proponga actualizar postes que ni siquiera
    // existen todavía en el broker.
    montar([
      equipo({ deviceId: 1, estado: 'atrasado' }),
      equipo({ deviceId: 2, estado: 'desconocido' }),
      equipo({ deviceId: 3, estado: 'al_dia' }),
    ]);

    componente['elegirAtrasados']();

    expect([...componente['elegidos']()]).toEqual([1]);
  });

  it('tildar y destildar el mismo equipo lo deja afuera', () => {
    montar([equipo({ deviceId: 7 })]);

    componente['alternar'](7);
    expect(componente['estaElegido'](7)).toBe(true);

    componente['alternar'](7);
    expect(componente['estaElegido'](7)).toBe(false);
  });

  // ── La ventana de energía ────────────────────────────────────────

  it('avisa cuántos de los elegidos van a rebotar por energía', () => {
    // El firmware rechaza el OTA fuera del modo activo: no lo encola ni lo
    // difiere, contesta error. Mandar veinte sabiendo que quince rebotan no
    // debería ser una sorpresa.
    montar([
      equipo({ deviceId: 1, modoEnergia: 'ACTIVE_240' }),
      equipo({ deviceId: 2, modoEnergia: 'MODEM_SLEEP' }),
      equipo({ deviceId: 3, modoEnergia: 'HIBERNACION' }),
    ]);

    componente['alternar'](1);
    componente['alternar'](2);
    componente['alternar'](3);

    expect(componente['elegidosSinEnergia']()).toBe(2);
  });

  it('un equipo sin modo de energía conocido no cuenta como sin energía', () => {
    montar([equipo({ deviceId: 1, modoEnergia: null })]);
    componente['alternar'](1);
    expect(componente['elegidosSinEnergia']()).toBe(0);
  });

  it('sabe distinguir dormido de desconectado', () => {
    const dentroDeUnRato = new Date(Date.now() + 3_600_000).toISOString();
    montar([
      equipo({ deviceId: 1, online: false, durmiendoHasta: dentroDeUnRato }),
      equipo({ deviceId: 2, online: false, durmiendoHasta: null }),
    ]);

    const [dormido, caido] = componente['equipos']();
    expect(componente['durmiendo'](dormido)).toBe(true);
    expect(componente['durmiendo'](caido)).toBe(false);
  });

  // ── Mandar ───────────────────────────────────────────────────────

  it('manda un pedido por equipo, con los ids elegidos', () => {
    montar([equipo({ deviceId: 4 }), equipo({ deviceId: 9 })]);

    componente['alternar'](4);
    componente['alternar'](9);
    componente['confirmar']();

    expect(api.actualizar).toHaveBeenCalledWith([4, 9]);
  });

  it('muestra los que rebotaron con su motivo, no un "listo" global', () => {
    montar([equipo({ deviceId: 1 }), equipo({ deviceId: 2 })]);
    api.actualizar.mockReturnValue(
      of([
        { deviceId: 1, serial: 'AV-1', encolado: true, cid: 'cmd-1', motivo: null },
        {
          deviceId: 2,
          serial: 'AV-2',
          encolado: false,
          cid: null,
          motivo: 'energia insuficiente',
        },
      ]),
    );

    componente['alternar'](1);
    componente['alternar'](2);
    componente['confirmar']();

    expect(componente['encolados']()).toBe(1);
    expect(componente['rebotados']()).toHaveLength(1);
    expect(componente['rebotados']()[0].motivo).toBe('energia insuficiente');
  });

  it('después de mandar limpia la selección para no repetir sin querer', () => {
    montar([equipo({ deviceId: 1 })]);
    componente['alternar'](1);
    componente['confirmar']();
    expect(componente['cuantosElegidos']()).toBe(0);
  });

  it('un error de red se muestra y no deja el botón girando', () => {
    montar([equipo({ deviceId: 1 })]);
    api.actualizar.mockReturnValue(throwError(() => new Error('sin conexión')));

    componente['alternar'](1);
    componente['confirmar']();

    expect(componente['error']()).toBeTruthy();
    expect(componente['mandando']()).toBe(false);
  });

  // ── El progreso del propio equipo ────────────────────────────────

  const reinicio = (recibidoEn = new Date().toISOString()) => ({
    estado: 6,
    estadoTexto: 'instalada, reiniciando',
    resultado: 0,
    motivo: null,
    fw: 'new_0_6_0',
    enCurso: false,
    esperandoReinicio: true,
    fallo: false,
    recibidoEn,
  });

  it('deja de sondear cuando el backend ya resolvió la confirmación', () => {
    // "instalada, reiniciando" es el ÚLTIMO mensaje que manda el equipo: el
    // self-test no publica nada. Si el sondeo esperara otro, sondearía para
    // siempre.
    montar([
      equipo({
        deviceId: 1,
        progreso: reinicio(),
        confirmacion: { estado: 'arranco', detalle: 'Arrancó con la nueva.' },
      }),
    ]);

    expect(componente['hayEnVuelo']()).toBe(false);
  });

  it('tampoco sondea cuando la confirmación dice que NO aplicó', () => {
    // Revirtió: también está resuelto, aunque sea un mal final.
    montar([
      equipo({
        deviceId: 1,
        progreso: reinicio(),
        confirmacion: { estado: 'no_aplico', detalle: 'Sigue con la anterior.' },
      }),
    ]);

    expect(componente['hayEnVuelo']()).toBe(false);
  });

  it('sigue mirando al que reinició mientras la confirmación esté pendiente', () => {
    montar([
      equipo({
        deviceId: 1,
        progreso: reinicio(),
        confirmacion: { estado: 'reiniciando', detalle: 'Todavía no volvió.' },
      }),
    ]);

    expect(componente['hayEnVuelo']()).toBe(true);
  });

  it('pero no para siempre: a los 15 minutos deja de esperarlo', () => {
    // El self-test tiene 10 minutos para conseguir internet. Pasado eso el
    // bootloader ya revirtió y refrescar no va a cambiar nada.
    const hace20Min = new Date(Date.now() - 20 * 60_000).toISOString();
    montar([
      equipo({
        deviceId: 1,
        progreso: reinicio(hace20Min),
        confirmacion: { estado: 'reiniciando', detalle: 'Todavía no volvió.' },
      }),
    ]);

    expect(componente['hayEnVuelo']()).toBe(false);
  });

  it('sigue sondeando mientras el equipo esté descargando, no solo con el pedido abierto', () => {
    // El pedido se cierra con el ack ("acepté") y recién ahí empieza lo que
    // tarda. Mirando solo la cola, el sondeo se apagaba justo cuando había algo
    // interesante que ver.
    montar([
      equipo({
        deviceId: 1,
        otaEnCurso: null,
        progreso: {
          estado: 4,
          estadoTexto: 'descargando',
          resultado: 0,
          motivo: null,
          fw: 'new_0_6_0',
          enCurso: true,
          esperandoReinicio: false,
          fallo: false,
          recibidoEn: new Date().toISOString(),
        },
      }),
    ]);

    expect(componente['hayEnVuelo']()).toBe(true);
  });

  it('un equipo quieto y sin pedido no hace sondear', () => {
    montar([equipo({ deviceId: 1, otaEnCurso: null, progreso: null })]);
    expect(componente['hayEnVuelo']()).toBe(false);
  });

  // ── Sin nada publicado ───────────────────────────────────────────

  it('sin versión publicada, nada está atrasado', () => {
    // No hay contra qué comparar; pintar la flota de rojo sería ruido.
    montar(
      [equipo({ deviceId: 1, fw: 'new_0_6_0', estado: 'desconocido' })],
      null,
    );

    expect(componente['publicada']()).toBeNull();
    expect(componente['atrasados']()).toBe(0);
  });
});
