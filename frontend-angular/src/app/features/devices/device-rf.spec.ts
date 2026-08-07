import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DevicesService } from '../../core/api/devices.service';
import { EstadoRf } from '../../core/models/api.models';
import { DeviceRfTab } from './device-rf';

function control(id: number) {
  return {
    remoteId: id,
    serial: `CR-00000${id}`,
    direccion: 'Mza A Casa 5',
    portador: 'Juana Pérez',
    dni: '30111222',
  };
}

function estadoRf(cambios: Partial<EstadoRf> = {}): EstadoRf {
  return {
    sinAlarma: [],
    capacidad: { tope: 126, ocupados: 1 },
    alDia: 0,
    pendientes: [control(1)],
    bajas: [],
    salteados: [],
    tanda: null,
    puedeSincronizar: true,
    impedimento: null,
    ...cambios,
  };
}

describe('DeviceRfTab', () => {
  let fixture: ComponentFixture<DeviceRfTab>;
  let componente: DeviceRfTab;
  let devices: {
    baseRf: ReturnType<typeof vi.fn>;
    sincronizarRf: ReturnType<typeof vi.fn>;
  };

  async function montar(estado: EstadoRf = estadoRf()): Promise<void> {
    devices.baseRf.mockReturnValue(of(estado));
    fixture = TestBed.createComponent(DeviceRfTab);
    fixture.componentRef.setInput('deviceId', 7);
    componente = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const html = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const boton = () =>
    (fixture.nativeElement as HTMLElement).querySelector('button.btn-primary') as HTMLButtonElement;

  beforeEach(() => {
    devices = { baseRf: vi.fn(), sincronizarRf: vi.fn() };
    TestBed.configureTestingModule({
      imports: [DeviceRfTab],
      providers: [
        provideZonelessChangeDetection(),
        // La tarjeta linkea a la ficha de la vivienda para arreglarle la alarma
        // preferida: sin router, RouterLink no resuelve ActivatedRoute.
        provideRouter([]),
        { provide: DevicesService, useValue: devices },
      ],
    });
  });

  it('dice lo que está en juego: un código que el equipo no tiene no dispara', async () => {
    await montar();
    // No es decoración: es la única pantalla donde se entiende por qué un
    // llavero entregado puede no hacer nada.
    expect(html()).toContain('no dispara nada');
  });

  it('muestra el resumen y la capacidad real del chip', async () => {
    await montar(
      estadoRf({
        alDia: 40,
        pendientes: [control(1), control(2)],
        bajas: [{ dni: '30999888', serial: 'CR-000009', motivo: 'volvió al stock' }],
        capacidad: { tope: 126, ocupados: 42 },
      }),
    );

    expect(html()).toContain('42 de 126');
    expect(html()).toContain('al día');
    expect(html()).toContain('volvió al stock');
  });

  it('los que no se pueden cargar salen con la explicación del backend', async () => {
    await montar(
      estadoRf({
        pendientes: [],
        salteados: [
          {
            ...control(3),
            motivo: 'POSICIONES_CON_HUECO',
            explicacion: 'Le falta una posición del medio.',
          },
        ],
      }),
    );

    // La regla es del firmware: la web no la reescribe por su cuenta.
    expect(html()).toContain('Le falta una posición del medio.');
  });

  it('sin nada que mandar el botón no se puede apretar', async () => {
    await montar(estadoRf({ pendientes: [], bajas: [], alDia: 3 }));

    expect(html()).toContain('exactamente los controles que le corresponden');
    expect(boton().disabled).toBe(true);
  });

  it('sin permiso el botón se apaga y se dice por qué', async () => {
    await montar(
      estadoRf({
        puedeSincronizar: false,
        impedimento: 'Tu rol no configura equipos',
      }),
    );

    expect(boton().disabled).toBe(true);
    expect(html()).toContain('Tu rol no configura equipos');
  });

  it('avisa cuánto va a tardar, porque no se puede apurar', async () => {
    await montar(
      estadoRf({
        pendientes: Array.from({ length: 12 }, (_, i) => control(i + 1)),
      }),
    );

    // 12 controles = 3 lotes. El equipo barre su memoria en cada alta.
    expect(componente.estimado()).toEqual({ lotes: 3, segundos: 8 });
    expect(html()).toContain('3 lotes');
  });

  it('con una tanda en curso no se manda otra y se explica la espera', async () => {
    await montar(
      estadoRf({
        tanda: {
          batchId: 'b1',
          total: 3,
          hechos: 1,
          estado: 'en_curso',
          detalle: null,
          empezada: '2026-08-05T10:00:00Z',
        },
      }),
    );

    expect(boton().disabled).toBe(true);
    expect(html()).toContain('1 de 3 lotes');
    // Honestidad sobre el equipo dormido: si no, parece que se colgó.
    expect(html()).toContain('cuando despierte');
  });

  it('una tanda cortada muestra lo que dijo el equipo, traducido', async () => {
    await montar(
      estadoRf({
        tanda: {
          batchId: 'b1',
          total: 3,
          hechos: 1,
          estado: 'con_error',
          detalle: 'la memoria del equipo está llena (ee_status 2)',
          empezada: '2026-08-05T10:00:00Z',
        },
      }),
    );

    expect(html()).toContain('memoria del equipo está llena');
    expect(html()).toContain('no se mandó');
  });

  it('sincronizar deja el estado que devuelve el backend, sin volver a pedirlo', async () => {
    await montar();
    const enCurso = estadoRf({
      pendientes: [],
      tanda: {
        batchId: 'b1',
        total: 1,
        hechos: 0,
        estado: 'en_curso',
        detalle: null,
        empezada: '2026-08-05T10:00:00Z',
      },
    });
    devices.sincronizarRf.mockReturnValue(of(enCurso));

    componente.sincronizar();
    await fixture.whenStable();

    expect(devices.sincronizarRf).toHaveBeenCalledWith(7);
    expect(devices.baseRf).toHaveBeenCalledTimes(1);
    expect(componente.enCurso()).toBe(true);
  });

  /**
   * El aviso que faltaba: un control asignado cuya vivienda no eligió alarma
   * preferida no le toca a NINGÚN equipo. Sin esto la pantalla mostraba cero
   * pendientes, indistinguible de "todo al día" — y hacía perder una hora
   * buscando por qué el control recién asignado no aparecía (2026-08-06).
   */
  it('avisa de los controles que no le tocan a ningún equipo', async () => {
    await montar(
      estadoRf({
        pendientes: [],
        sinAlarma: [{ remoteId: 1, serial: 'CR-000001', homeId: 4, direccion: 'casa de mati' }],
      }),
    );

    expect(html()).toContain('no se va');
    expect(html()).toContain('CR-000001');
    expect(html()).toContain('casa de mati');
    // Y el camino para arreglarlo, no solo el diagnóstico.
    expect(html()).toContain('elegirle una alarma');
  });

  it('el conflicto del backend se muestra tal cual', async () => {
    await montar();
    devices.sincronizarRf.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: { message: 'Ya hay una sincronización en curso para este equipo' },
          }),
      ),
    );

    componente.sincronizar();
    await fixture.whenStable();

    expect(componente.error()).toContain('en curso');
  });
});
