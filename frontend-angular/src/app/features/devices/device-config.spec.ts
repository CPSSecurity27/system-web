import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DevicesService } from '../../core/api/devices.service';
import { DeviceConfig, DeviceState } from '../../core/models/api.models';
import { DeviceConfigTab } from './device-config';

/** Un espejo típico: una red, los cuatro módulos y la telemetría por default. */
function configBase(cambios: Partial<DeviceConfig> = {}): DeviceConfig {
  return {
    deviceId: 1,
    estado: 'VERIFICADO',
    configuracion: {
      cfg_v: 5,
      modulos: {
        ds3231: true,
        eeprom: true,
        supervisor: true,
        rf: true,
        eeprom_slot: 0,
      },
      tiempos: { send_tele_s: 300 },
      hora: { tz_offset_s: -10800 },
      mante: { on: false },
      alarma: {
        autooff: {
          suspicious: 120,
          alert: 300,
          emergency: 600,
          fire: 600,
          medical: 600,
          silent: 600,
          panic: 900,
        },
      },
      red_avanzada: { roam_rssi: -70, roam_delta: 10, roam_cooldown_s: 120 },
      rf: { total_codigos: 12, gen: 3 },
      cal: { bat: { m: 1.02, b: -0.1 } },
      id: { fw: '6.0.1' },
    },
    redes: [{ ssid: 'MuniWiFi', prio: 1, tienePassword: true, bloqueada: false }],
    cfgVEspejo: '5',
    cfgVPendiente: null,
    detalle: null,
    espejoActualizadoEn: '2026-08-04T12:00:00.000Z',
    ultimoScan: null,
    puedeEditar: true,
    puedeVerPasswords: false,
    ...cambios,
  };
}

function estadoVivo(cambios: Partial<DeviceState> = {}): DeviceState {
  return {
    deviceId: 1,
    online: true,
    alarmStatus: 'off',
    powerMode: 'ACTIVE_240',
    vbat: '12.60',
    vpanel: '18.30',
    vfuente: '13.80',
    cfgV: '5',
    rfGen: '0',
    fw: '6.0.1',
    ssid: 'MuniWiFi',
    ip: '192.168.1.7',
    rssi: -61,
    recon: 3,
    pingFail: 0,
    tele: null,
    lastSeen: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    sleepUntil: null,
    tsDevice: null,
    tsq: 0,
    updatedAt: new Date().toISOString(),
    ...cambios,
  };
}

describe('DeviceConfigTab', () => {
  let fixture: ComponentFixture<DeviceConfigTab>;
  let componente: DeviceConfigTab;
  let devices: {
    config: ReturnType<typeof vi.fn>;
    publicarConfig: ReturnType<typeof vi.fn>;
    pedirScan: ReturnType<typeof vi.fn>;
    pedirRefresh: ReturnType<typeof vi.fn>;
    revelarWifi: ReturnType<typeof vi.fn>;
    fuentesDeConfig: ReturnType<typeof vi.fn>;
  };

  async function montar(
    config: DeviceConfig,
    vivo: DeviceState | null = estadoVivo(),
  ): Promise<void> {
    devices.config.mockReturnValue(of(config));
    fixture = TestBed.createComponent(DeviceConfigTab);
    fixture.componentRef.setInput('deviceId', 1);
    fixture.componentRef.setInput('estadoVivo', vivo);
    componente = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    devices = {
      config: vi.fn(),
      publicarConfig: vi.fn(),
      pedirScan: vi.fn(),
      pedirRefresh: vi.fn(),
      revelarWifi: vi.fn(),
      fuentesDeConfig: vi.fn().mockReturnValue(of([])),
    };
    TestBed.configureTestingModule({
      imports: [DeviceConfigTab],
      providers: [provideZonelessChangeDetection(), { provide: DevicesService, useValue: devices }],
    });
  });

  it('sin espejo bloquea la edición y ofrece pedir la configuración', async () => {
    await montar(configBase({ estado: 'SIN_ESPEJO', configuracion: null, redes: [] }));
    expect(componente.bloqueado()).toBe(true);

    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('nunca reportó');
  });

  it('sin permiso de edición, el formulario queda de solo lectura', async () => {
    await montar(configBase({ puedeEditar: false }));
    expect(componente.bloqueado()).toBe(true);
  });

  it('no manda al backend los campos que no cambiaron', async () => {
    await montar(configBase());
    componente.borrador.update((b) => ({
      ...b,
      tiempos: { send_tele_s: 600 },
    }));

    const patch = componente.patch();
    expect(patch).toEqual({ tiempos: { send_tele_s: 600 } });
    // Y nada más: el panel acepta 1024 bytes, cada sección de más los gasta.
    expect(Object.keys(patch)).toEqual(['tiempos']);
  });

  it('sin cambios, el patch queda vacío y no se puede guardar', async () => {
    await montar(configBase());
    expect(componente.patch()).toEqual({});
    expect(componente.hayCambios()).toBe(false);
  });

  it('muestra el diff de lo que cambia, con el valor viejo y el nuevo', async () => {
    await montar(configBase());
    componente.borrador.update((b) => ({
      ...b,
      tiempos: { send_tele_s: 600 },
    }));

    const cambios = componente.cambios();
    expect(cambios).toEqual([
      {
        campo: 'tiempos.send_tele_s',
        etiqueta: 'Telemetría cada (s)',
        de: '300',
        a: '600',
      },
    ]);
  });

  // ── Auto-apagado por modo ─────────────────────────────────────────

  it('el auto-apagado se edita modo por modo y viaja en la sección alarma', async () => {
    await montar(configBase());
    componente.cambiarEscalar('alarma.autooff.fire', 900);

    expect(componente.patch()).toEqual({
      alarma: {
        autooff: {
          suspicious: 120,
          alert: 300,
          emergency: 600,
          fire: 900,
          medical: 600,
          silent: 600,
          panic: 900,
        },
      },
    });
  });

  it('cambiar un modo no pisa a los otros seis', async () => {
    await montar(configBase());
    componente.cambiarEscalar('alarma.autooff.panic', 1800);
    componente.cambiarEscalar('alarma.autooff.medical', 300);

    expect(componente.valor('alarma.autooff.panic')).toBe(1800);
    expect(componente.valor('alarma.autooff.medical')).toBe(300);
    expect(componente.valor('alarma.autooff.fire')).toBe(600);
    expect(componente.cambios()).toHaveLength(2);
  });

  it('el diff del auto-apagado se lee en castellano, no en JSON', async () => {
    await montar(configBase());
    componente.cambiarEscalar('alarma.autooff.fire', 900);
    expect(componente.cambios()[0].etiqueta).toContain('Incendio');
  });

  it('los 7 modos se muestran con su slug del firmware', async () => {
    await montar(configBase());
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    for (const modo of componente.modosAutooff) {
      expect(html).toContain(modo.slug);
    }
  });

  // ── Huso horario: se edita en horas, viaja en segundos ────────────

  it('el huso se muestra en horas', async () => {
    await montar(configBase());
    expect(componente.tzHoras()).toBe(-3);
  });

  it('cambiar el huso en horas lo manda en segundos', async () => {
    await montar(configBase());
    componente.cambiarTzHoras(-4);

    expect(componente.valor('hora.tz_offset_s')).toBe(-14400);
    expect(componente.patch()).toEqual({ hora: { tz_offset_s: -14400 } });
  });

  // ── Slot de eeprom ────────────────────────────────────────────────

  it('el slot de eeprom viaja con el resto de los módulos', async () => {
    await montar(configBase());
    componente.cambiarEscalar('modulos.eeprom_slot', 1);

    expect(componente.patch()).toEqual({
      modulos: {
        ds3231: true,
        eeprom: true,
        supervisor: true,
        rf: true,
        eeprom_slot: 1,
      },
    });
  });

  // ── Lo que no se edita ────────────────────────────────────────────

  it('muestra la base RF y la calibración sin dejar tocarlas', async () => {
    await montar(configBase());
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('12 códigos');
    expect(html).toContain('generación 3');
    expect(html).toContain('6.0.1');
  });

  it('rf, cal e id nunca entran en el patch', async () => {
    await montar(configBase());
    componente.cambiarEscalar('tiempos.send_tele_s', 600);
    expect(Object.keys(componente.patch())).toEqual(['tiempos']);
  });

  // ── Contraseñas y redes bloqueadas ────────────────────────────────

  it('sin permiso de CPS no hay botón para ver contraseñas', async () => {
    await montar(configBase());
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).not.toContain('Ver contraseñas');
  });

  it('siendo CPS, el botón revela las contraseñas del espejo', async () => {
    await montar(configBase({ puedeVerPasswords: true }));
    devices.revelarWifi.mockReturnValue(of([{ ssid: 'MuniWiFi', psw: 'clave-real' }]));

    componente.revelarWifi();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(componente.passwordRevelada('MuniWiFi')).toBe('clave-real');
    expect((fixture.nativeElement as HTMLElement).textContent ?? '').toContain('clave-real');
  });

  it('una red bloqueada por el equipo se marca y se explica', async () => {
    await montar(
      configBase({
        redes: [{ ssid: 'MuniWiFi', prio: 1, tienePassword: true, bloqueada: true }],
      }),
    );
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('bloqueada por el equipo');
    expect(html).toContain('lista negra');
  });

  // ── Copiar de otro poste ──────────────────────────────────────────

  it('copiar trae los valores del otro equipo pero NO su identidad', async () => {
    await montar(configBase());
    devices.config.mockReturnValue(
      of(
        configBase({
          deviceId: 9,
          configuracion: {
            ...configBase().configuracion,
            tiempos: { send_tele_s: 900 },
            central: { alias: 'Poste 40', ubicacion: 'Otra esquina', grupo: 'X' },
            id: { fw: '5.9.9' },
          },
          redes: [{ ssid: 'OtroWiFi', prio: 1, tienePassword: true, bloqueada: false }],
        }),
      ),
    );

    componente.copiarDe(9);
    await fixture.whenStable();

    expect(componente.valor('tiempos.send_tele_s')).toBe(900);
    // El alias y la ubicación son de cada poste: copiarlos dejaría dos equipos
    // llamándose igual adentro del firmware.
    expect(componente.valor('central.alias')).toBeUndefined();
    expect(componente.valor('id.fw')).toBe('6.0.1');
  });

  it('copiar trae los SSID pero deja las contraseñas vacías', async () => {
    await montar(configBase());
    devices.config.mockReturnValue(
      of(
        configBase({
          deviceId: 9,
          redes: [{ ssid: 'OtroWiFi', prio: 1, tienePassword: true, bloqueada: false }],
        }),
      ),
    );

    componente.copiarDe(9);
    await fixture.whenStable();

    expect(componente.redes()[0].ssid).toBe('OtroWiFi');
    expect(componente.redes()[0].psw).toBe('');
    // Y se dice, porque si no el técnico guarda y el poste no conecta.
    expect(componente.aviso()).toContain('contraseñas');
  });

  it('copiar NO guarda nada: solo deja los cambios listos para revisar', async () => {
    await montar(configBase());
    devices.config.mockReturnValue(
      of(configBase({ deviceId: 9, configuracion: { tiempos: { send_tele_s: 900 } } })),
    );

    componente.copiarDe(9);
    await fixture.whenStable();

    expect(devices.publicarConfig).not.toHaveBeenCalled();
    expect(componente.hayCambios()).toBe(true);
  });

  // ── Vuelta a fábrica ──────────────────────────────────────────────

  it('tras un factory avisa que lo que se ve no es lo que corre', async () => {
    await montar(configBase({ estado: 'DESACTUALIZADA', cfgVPendiente: '5' }));

    expect(componente.desactualizada()).toBe(true);
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('valores de fábrica');
    expect(html).not.toContain('verificado contra el equipo');
    // Se puede publicar igual: es la forma de devolverle su configuración.
    expect(componente.bloqueado()).toBe(false);
  });

  it('sumar una red del scan la agrega sin pisar las que ya están', async () => {
    await montar(
      configBase({
        ultimoScan: {
          redes: [{ ssid: 'Vecino', rssi: -70, seg: true, ch: 6, guardada: false }],
          recibidoEn: new Date().toISOString(),
        },
      }),
    );

    componente.sumarDelScan('Vecino');

    expect(componente.redes()[1].ssid).toBe('Vecino');
    expect(componente.redes()[0].ssid).toBe('MuniWiFi');
  });

  /**
   * La lista de redes vistas se dibujaba ADENTRO del `@for` de las cargadas, o
   * sea que se repetía entera debajo de cada fila: con 2 cargadas y 8 vistas
   * eran 16 links corridos. Visto en producción el 2026-08-06.
   */
  it('las redes vistas van una sola vez, sin las que ya están cargadas', async () => {
    await montar(
      configBase({
        ultimoScan: {
          redes: [
            { ssid: 'Debil', rssi: -88, seg: true, ch: 1, guardada: false },
            { ssid: 'MuniWiFi', rssi: -50, seg: true, ch: 6, guardada: true },
            { ssid: 'Vecino', rssi: -65, seg: true, ch: 11, guardada: false },
          ],
          recibidoEn: new Date().toISOString(),
        },
      }),
    );

    // MuniWiFi ya está cargada: no se ofrece de nuevo.
    expect(componente.redesVistas().map((r) => r.ssid)).toEqual(['Vecino', 'Debil']);

    // Y aparece UNA vez en la pantalla, no una por cada red configurada.
    const html = (fixture.nativeElement as HTMLElement).innerHTML;
    expect(html.split('Vecino').length - 1).toBe(1);
  });

  it('el dBm se traduce: -65 no le dice nada a nadie', () => {
    // Los cortes importan sobre un poste en la calle: por debajo de -80 el
    // enlace existe pero se cae solo.
    const c = TestBed.createComponent(DeviceConfigTab).componentInstance;
    expect(c.calidad(-55).texto).toBe('excelente');
    expect(c.calidad(-65).texto).toBe('buena');
    expect(c.calidad(-75).texto).toBe('regular');
    expect(c.calidad(-88).texto).toBe('débil');
  });

  it('el botón de scan se deshabilita con el panel offline', async () => {
    await montar(configBase(), estadoVivo({ online: false }));
    expect(componente.puedeEscanear()).toBe(false);
  });

  it('el botón de scan se deshabilita con el panel durmiendo', async () => {
    await montar(
      configBase(),
      estadoVivo({
        online: false,
        sleepUntil: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    expect(componente.puedeEscanear()).toBe(false);
    expect(componente.motivoSinScan()).toContain('duerme');
  });

  it('con estado FALLIDA muestra el detalle y deja republicar', async () => {
    await montar(
      configBase({
        estado: 'FALLIDA',
        detalle: 'no entró en el buffer del panel',
        cfgVPendiente: '6',
      }),
    );
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('no entró en el buffer del panel');
    expect(componente.bloqueado()).toBe(false);
  });

  it('apagar un módulo exige confirmación nombrando la consecuencia', async () => {
    await montar(configBase());
    componente.borrador.update((b) => ({
      ...b,
      modulos: { ...(b['modulos'] as object), rf: false },
    }));

    const avisos = componente.avisosDeApagado();
    expect(avisos.length).toBe(1);
    expect(avisos[0]).toContain('controles remotos');
  });

  it('guardar publica el patch y refresca desde la respuesta', async () => {
    await montar(configBase());
    const despues = configBase({ estado: 'PENDIENTE', cfgVPendiente: '6' });
    devices.publicarConfig.mockReturnValue(of(despues));

    componente.borrador.update((b) => ({
      ...b,
      tiempos: { send_tele_s: 600 },
    }));
    componente.guardar();
    await fixture.whenStable();

    expect(devices.publicarConfig).toHaveBeenCalledWith(1, {
      tiempos: { send_tele_s: 600 },
    });
    expect(componente.config()?.estado).toBe('PENDIENTE');
  });

  it('un error del backend se muestra y no deja el formulario colgado', async () => {
    await montar(configBase());
    devices.publicarConfig.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { message: ['send_tele_s: 1 está fuera de rango (30 a 86400)'] },
          }),
      ),
    );

    componente.borrador.update((b) => ({
      ...b,
      tiempos: { send_tele_s: 1 },
    }));
    componente.guardar();
    await fixture.whenStable();

    expect(componente.error()).toContain('send_tele_s');
    expect(componente.guardando()).toBe(false);
  });
});
