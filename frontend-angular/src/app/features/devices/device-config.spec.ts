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
      modulos: { ds3231: true, eeprom: true, supervisor: true, rf: true },
      tiempos: { send_tele_s: 300 },
      hora: { tz_offset_s: -10800 },
      mante: { on: false },
      red_avanzada: { roam_rssi: -70, roam_delta: 10, roam_cooldown_s: 120 },
      id: { fw: '6.0.1' },
    },
    redes: [{ ssid: 'MuniWiFi', prio: 1, tienePassword: true }],
    cfgVEspejo: '5',
    cfgVPendiente: null,
    detalle: null,
    espejoActualizadoEn: '2026-08-04T12:00:00.000Z',
    ultimoScan: null,
    puedeEditar: true,
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
    };
    TestBed.configureTestingModule({
      imports: [DeviceConfigTab],
      providers: [
        provideZonelessChangeDetection(),
        { provide: DevicesService, useValue: devices },
      ],
    });
  });

  it('sin espejo bloquea la edición y ofrece pedir la configuración', async () => {
    await montar(
      configBase({ estado: 'SIN_ESPEJO', configuracion: null, redes: [] }),
    );
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
      { campo: 'tiempos.send_tele_s', de: '300', a: '600' },
    ]);
  });

  it('elegir una red del scan autocompleta el SSID sin pisar el resto', async () => {
    await montar(
      configBase({
        ultimoScan: {
          redes: [
            { ssid: 'Vecino', rssi: -70, seg: true, ch: 6, guardada: false },
          ],
          recibidoEn: new Date().toISOString(),
        },
      }),
    );

    componente.agregarRed();
    componente.elegirDelScan(1, 'Vecino');

    expect(componente.redes()[1].ssid).toBe('Vecino');
    expect(componente.redes()[0].ssid).toBe('MuniWiFi');
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
