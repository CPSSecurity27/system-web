import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DevicesService } from '../../core/api/devices.service';
import {
  ColaComandos,
  Comando,
  Device,
  DeviceState,
} from '../../core/models/api.models';
import { DeviceActionsTab } from './device-actions';

const SERIAL = 'AV-A842E38FCA6C';

function equipo(): Device {
  return {
    id: 1,
    serial: SERIAL,
    mac: 'A842E38FCA6C',
    name: 'Poste 12',
    type: 'COMMUNITY_ALARM',
    status: 'OPERATIONAL',
    neighborhoodId: 4,
  } as unknown as Device;
}

function comando(cambios: Partial<Comando> = {}): Comando {
  return {
    cid: 'cmd-abc',
    tipo: 'estado',
    payload: {},
    estado: 'pending',
    detalle: null,
    creadoEn: new Date().toISOString(),
    enviadoEn: null,
    confirmadoEn: null,
    pedidoPor: 'Ana Admin',
    cancelable: true,
    ...cambios,
  };
}

function cola(cambios: Partial<ColaComandos> = {}): ColaComandos {
  return {
    comandos: [comando()],
    puedeOperar: true,
    puedeDisparar: true,
    // El OTA tiene su propio permiso desde que quedó restringido a CPS.
    puedeActualizar: true,
    ...cambios,
  };
}

function vivo(cambios: Partial<DeviceState> = {}): DeviceState {
  return {
    deviceId: 1,
    online: true,
    sleepUntil: null,
    ...cambios,
  } as unknown as DeviceState;
}

describe('DeviceActionsTab', () => {
  let fixture: ComponentFixture<DeviceActionsTab>;
  let componente: DeviceActionsTab;
  let devices: {
    comandos: ReturnType<typeof vi.fn>;
    mandarComando: ReturnType<typeof vi.fn>;
    cancelarComando: ReturnType<typeof vi.fn>;
    dispararAlarma: ReturnType<typeof vi.fn>;
  };

  async function montar(
    respuesta: ColaComandos = cola(),
    estado: DeviceState | null = vivo(),
  ): Promise<void> {
    devices.comandos.mockReturnValue(of(respuesta));
    fixture = TestBed.createComponent(DeviceActionsTab);
    fixture.componentRef.setInput('deviceId', 1);
    fixture.componentRef.setInput('device', equipo());
    fixture.componentRef.setInput('estadoVivo', estado);
    componente = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    devices = {
      comandos: vi.fn(),
      mandarComando: vi.fn(),
      cancelarComando: vi.fn(),
      dispararAlarma: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [DeviceActionsTab],
      providers: [
        provideZonelessChangeDetection(),
        { provide: DevicesService, useValue: devices },
      ],
    });
  });

  it('los permisos salen del backend, no de la sesión', async () => {
    await montar(cola({ puedeOperar: false, puedeDisparar: true }));
    expect(componente.puedeOperar()).toBe(false);
    expect(componente.puedeDisparar()).toBe(true);
  });

  it('sin ningún permiso lo dice y no ofrece nada', async () => {
    await montar(cola({ puedeOperar: false, puedeDisparar: false }));
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('no mandarle nada');
  });

  // ── Los que no tienen consecuencia van derecho ────────────────────

  it('un comando de diagnóstico se manda sin preguntar', async () => {
    await montar();
    devices.mandarComando.mockReturnValue(of(cola()));

    componente.pedir(componente.diagnostico[0]);
    await fixture.whenStable();

    expect(devices.mandarComando).toHaveBeenCalledWith(1, 'estado', {}, undefined);
    expect(componente.confirmando()).toBeNull();
  });

  // ── Los destructivos piden confirmación ───────────────────────────

  it('reiniciar abre la confirmación en vez de mandar', async () => {
    await montar();
    const restart = componente.mantenimiento.find((a) => a.tipo === 'restart')!;

    componente.pedir(restart);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(devices.mandarComando).not.toHaveBeenCalled();
    expect(componente.confirmando()?.tipo).toBe('restart');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'una alarma menos',
    );
  });

  it('volver a fábrica exige escribir el serial exacto', async () => {
    await montar();
    const factory = componente.mantenimiento.find((a) => a.tipo === 'factory')!;
    componente.pedir(factory);

    expect(componente.confirmacionValida()).toBe(false);

    componente.serialTipeado.set('AV-OTROEQUIPO12');
    expect(componente.confirmacionValida()).toBe(false);

    componente.serialTipeado.set(SERIAL);
    expect(componente.confirmacionValida()).toBe(true);
  });

  it('el aviso de fábrica dice que los controles NO se borran', async () => {
    await montar();
    componente.pedir(
      componente.mantenimiento.find((a) => a.tipo === 'factory')!,
    );
    await fixture.whenStable();
    fixture.detectChanges();

    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('NO se borran');
    expect(html).toContain('SIN FORMA DE CONECTARSE');
  });

  it('confirmar un factory manda el serial tipeado', async () => {
    await montar();
    devices.mandarComando.mockReturnValue(of(cola()));

    componente.pedir(
      componente.mantenimiento.find((a) => a.tipo === 'factory')!,
    );
    componente.serialTipeado.set(SERIAL);
    componente.confirmar();
    await fixture.whenStable();

    expect(devices.mandarComando).toHaveBeenCalledWith(1, 'factory', {}, SERIAL);
  });

  // ── OTA ───────────────────────────────────────────────────────────

  it('el OTA sin URL usa el origen que el equipo ya tiene', async () => {
    await montar();
    devices.mandarComando.mockReturnValue(of(cola()));

    componente.pedir(componente.mantenimiento.find((a) => a.tipo === 'ota')!);
    componente.confirmar();
    await fixture.whenStable();

    expect(devices.mandarComando).toHaveBeenCalledWith(
      1,
      'ota',
      { fuente: 'auto' },
      undefined,
    );
  });

  it('el OTA con URL la manda como origen manual', async () => {
    await montar();
    devices.mandarComando.mockReturnValue(of(cola()));

    componente.pedir(componente.mantenimiento.find((a) => a.tipo === 'ota')!);
    componente.otaUrl.set('https://firmware.cps.ar/aloy/6.0.2');
    componente.confirmar();
    await fixture.whenStable();

    expect(devices.mandarComando).toHaveBeenCalledWith(
      1,
      'ota',
      { fuente: 'url', base: 'https://firmware.cps.ar/aloy/6.0.2' },
      undefined,
    );
  });

  // ── Disparo remoto ────────────────────────────────────────────────

  it('disparar manda el slug del firmware, no la etiqueta', async () => {
    await montar();
    devices.dispararAlarma.mockReturnValue(of(cola()));

    componente.disparar('fire');
    await fixture.whenStable();

    expect(devices.dispararAlarma).toHaveBeenCalledWith(1, 'fire');
    expect(componente.aviso()).toContain('dispare');
  });

  it('apagar dice que apaga, no que dispara', async () => {
    await montar();
    devices.dispararAlarma.mockReturnValue(of(cola()));

    componente.disparar('off');
    await fixture.whenStable();

    expect(componente.aviso()).toContain('apague');
  });

  // ── El equipo dormido no bloquea: avisa ───────────────────────────

  it('con el equipo durmiendo avisa que el pedido espera', async () => {
    await montar(
      cola(),
      vivo({
        online: false,
        sleepUntil: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    expect(componente.demora()).toContain('duerme');
    // Pero se puede mandar igual: queda en cola.
    expect(componente.puedeOperar()).toBe(true);
  });

  it('con el equipo offline avisa, sin impedir', async () => {
    await montar(cola(), vivo({ online: false }));
    expect(componente.demora()).toContain('desconectado');
  });

  // ── La cola ───────────────────────────────────────────────────────

  it('muestra qué se pidió, quién y en qué quedó', async () => {
    await montar(
      cola({
        comandos: [
          comando({ tipo: 'restart', estado: 'sent', cancelable: false }),
        ],
      }),
    );
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('restart');
    expect(html).toContain('enviado');
    expect(html).toContain('Ana Admin');
  });

  it('un comando ya enviado no ofrece cancelar', async () => {
    await montar(
      cola({ comandos: [comando({ estado: 'sent', cancelable: false })] }),
    );
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).not.toContain('Cancelar');
  });

  it('cancelar refresca la cola desde la respuesta', async () => {
    await montar();
    devices.cancelarComando.mockReturnValue(
      of(cola({ comandos: [comando({ estado: 'cancelled', cancelable: false })] })),
    );

    componente.cancelarComando('cmd-abc');
    await fixture.whenStable();

    expect(componente.cola()[0].estado).toBe('cancelled');
  });

  it('un error del backend se muestra y no rompe la pantalla', async () => {
    await montar();
    devices.mandarComando.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: { message: 'Este equipo todavía no está instalado' },
          }),
      ),
    );

    componente.pedir(componente.diagnostico[0]);
    await fixture.whenStable();

    expect(componente.error()).toContain('no está instalado');
  });
});
