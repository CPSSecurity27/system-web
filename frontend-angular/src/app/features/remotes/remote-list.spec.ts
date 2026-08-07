import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DevicesService } from '../../core/api/devices.service';
import { HomesService } from '../../core/api/homes.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { RemotesService } from '../../core/api/remotes.service';
import { AuthService } from '../../core/auth/auth.service';
import { Device, Paginated, Remote } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';
import { RemoteList } from './remote-list';

/**
 * Una fila del listado: viene con la vivienda, el barrio y el cliente YA
 * resueltos. Ese es el punto del endpoint nuevo — la pantalla no baja las
 * viviendas para traducir `homeId -> dirección`.
 */
function control(cambios: Partial<Remote> = {}): Remote {
  return {
    id: 7,
    serial: 'CR-000001',
    modelId: 1,
    manufacturedAt: null,
    name: null,
    status: 'ACTIVE',
    homeId: 3,
    organizationId: null,
    assignedToUserId: 11,
    assignedToUser: { id: 11, name: 'Juana Pérez', dni: '30111222' },
    deviceId: null,
    home: {
      id: 3,
      address: 'Mza A Casa 5',
      neighborhoodId: 2,
      defaultDeviceId: 9,
      neighborhood: {
        id: 2,
        name: 'Los Aromos',
        organizationId: 5,
        organization: { id: 5, name: 'Municipalidad de Córdoba', subtype: 'MUNICIPAL' },
      },
    },
    ...cambios,
  } as Remote;
}

function pagina(items: Remote[], total = items.length): Paginated<Remote> {
  return { items, total, limit: 50, offset: 0 };
}

function barrio(id: number, name: string, orgId: number, orgName: string): Neighborhood {
  return {
    id,
    name,
    organizationId: orgId,
    organization: { id: orgId, name: orgName },
  } as Neighborhood;
}

describe('RemoteList', () => {
  let fixture: ComponentFixture<RemoteList>;
  let componente: RemoteList;
  let remotes: {
    list: ReturnType<typeof vi.fn>;
    reassign: ReturnType<typeof vi.fn>;
    devolver: ReturnType<typeof vi.fn>;
  };
  let homes: { get: ReturnType<typeof vi.fn>; members: ReturnType<typeof vi.fn> };
  let neighborhoods: { list: ReturnType<typeof vi.fn> };
  let devices: { list: ReturnType<typeof vi.fn> };
  let homeIdEnLaUrl: string | null;

  async function montar(
    page: Paginated<Remote> = pagina([control()]),
    barrios: Neighborhood[] = [
      barrio(2, 'Los Aromos', 5, 'Municipalidad de Córdoba'),
      barrio(4, 'La Cañada', 6, 'Consorcio Del Bosque'),
    ],
  ): Promise<void> {
    remotes.list.mockReturnValue(of(page));
    neighborhoods.list.mockReturnValue(of(barrios));
    fixture = TestBed.createComponent(RemoteList);
    componente = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** Los argumentos con los que se pidió la última página. */
  const ultimaConsulta = (): Record<string, unknown> =>
    remotes.list.mock.calls[remotes.list.mock.calls.length - 1][0] as Record<string, unknown>;

  beforeEach(() => {
    homeIdEnLaUrl = null;
    remotes = { list: vi.fn(), reassign: vi.fn(), devolver: vi.fn() };
    homes = { get: vi.fn(), members: vi.fn() };
    neighborhoods = { list: vi.fn() };
    devices = { list: vi.fn() };

    TestBed.configureTestingModule({
      imports: [RemoteList],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: RemotesService, useValue: remotes },
        { provide: HomesService, useValue: homes },
        { provide: NeighborhoodsService, useValue: neighborhoods },
        { provide: DevicesService, useValue: devices },
        {
          provide: AuthService,
          useValue: { isManager: signal(true), isTitular: signal(false), isCps: signal(true) },
        },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: { get: () => homeIdEnLaUrl } } },
        },
      ],
    });
  });

  it('la fila trae dirección, barrio, portador y DNI sin bajar las viviendas', async () => {
    await montar();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(html).toContain('CR-000001');
    expect(html).toContain('Mza A Casa 5');
    expect(html).toContain('Los Aromos');
    expect(html).toContain('Juana Pérez');
    expect(html).toContain('30111222');
    // El punto de todo: con 12.000 controles no se baja la lista de viviendas.
    expect(homes.get).not.toHaveBeenCalled();
  });

  it('los códigos RF no viven más acá: se graban y se revelan en Fábrica', async () => {
    await montar();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).not.toContain('códigos');
    expect(html).not.toContain('Revelar');
  });

  // ── Filtros ────────────────────────────────────────────────────────

  it('cambiar de cliente se lleva puestos el barrio y la alarma', async () => {
    await montar();
    devices.list.mockReturnValue(of([{ id: 9, name: 'Poste 3' } as Device]));

    componente['onBarrio'](2);
    componente['onAlarma'](9);
    expect(componente['fAlarma']()).toBe(9);

    // El barrio elegido puede no ser de este cliente, y la alarma cuelga del
    // barrio: los dos se caen juntos.
    componente['onCliente'](6);
    expect(componente['fBarrio']()).toBeNull();
    expect(componente['fAlarma']()).toBeNull();
    expect(componente['alarmas']()).toEqual([]);
  });

  it('el cliente elegido recorta la lista de barrios', async () => {
    await montar();
    expect(componente['barriosDelCliente']().length).toBe(2);

    componente['onCliente'](5);
    expect(componente['barriosDelCliente']().map((b) => b.id)).toEqual([2]);
  });

  it('las alarmas se piden POR BARRIO, no todas juntas', async () => {
    await montar();
    devices.list.mockReturnValue(of([{ id: 9, name: 'Poste 3' } as Device]));

    // Sin barrio no hay lista que ofrecer: serían miles de postes.
    expect(devices.list).not.toHaveBeenCalled();

    componente['onBarrio'](2);
    expect(devices.list).toHaveBeenCalledWith(2);
  });

  it('todos los filtros viajan al servidor y vuelven a la primera página', async () => {
    await montar(pagina([control()], 300));
    componente['next']();
    expect(componente['offset']()).toBe(50);

    componente['onCliente'](5);
    expect(componente['offset']()).toBe(0);
    expect(ultimaConsulta()).toMatchObject({ organizationId: 5, limit: 50, offset: 0 });

    componente['onEstado']('LOST');
    expect(ultimaConsulta()).toMatchObject({ status: 'LOST' });
  });

  it('tipear no dispara un request por tecla', async () => {
    await montar();
    const antes = remotes.list.mock.calls.length;

    componente['onSearch']('30.111');
    componente['onSearch']('30.111.222');

    // El debounce todavía no cumplió: la búsqueda no salió.
    expect(remotes.list.mock.calls.length).toBe(antes);
    expect(componente['search']()).toBe('30.111.222');
  });

  it('la búsqueda va tal cual: el DNI con puntos lo normaliza el backend', async () => {
    await montar();
    componente['search'].set('30.111.222');
    componente['load']();

    expect(ultimaConsulta()).toMatchObject({ q: '30.111.222' });
  });

  it('?homeId= recorta la lista, lo dice, y se puede quitar', async () => {
    homeIdEnLaUrl = '3';
    homes.get.mockReturnValue(of({ id: 3, address: 'Mza A Casa 5' }));
    await montar();

    expect(ultimaConsulta()).toMatchObject({ homeId: 3 });
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Solo Mza A Casa 5');

    componente['quitarCasa']();
    expect(componente['fCasa']()).toBeNull();
    expect(ultimaConsulta()['homeId']).toBeUndefined();
  });

  // ── Acciones de la fila ────────────────────────────────────────────

  it('abrir una fila carga los miembros de ESA vivienda, no de todas', async () => {
    await montar();
    homes.members.mockReturnValue(
      of([
        { id: 1, userId: 11, role: 'TITULAR', status: 'ACTIVE', user: { name: 'Juana Pérez' } },
        { id: 2, userId: 12, role: 'FAMILIAR', status: 'CLOSED', user: { name: 'Ex vecino' } },
      ]),
    );

    componente['abrir'](control());

    expect(homes.members).toHaveBeenCalledWith(3);
    // Los que ya no viven ahí no pueden llevar el control.
    expect(componente['miembros']().map((m) => m.userId)).toEqual([11]);
    // Arranca con el portador actual seleccionado.
    expect(componente['portadorElegido']()).toBe(11);
  });

  it('sin portador manda null: el control queda en la casa', async () => {
    await montar();
    homes.members.mockReturnValue(of([]));
    remotes.reassign.mockReturnValue(of(control()));

    componente['abrir'](control());
    componente['portadorElegido'].set('');
    componente['guardarPortador'](control());

    expect(remotes.reassign).toHaveBeenCalledWith(7, null);
  });

  it('devolver avisa que los códigos SIGUEN grabados en el barrio', async () => {
    await montar();
    homes.members.mockReturnValue(of([]));

    componente['abrir'](control());
    componente['pedirDevolucion'](control());
    fixture.detectChanges();

    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('siguen grabados');

    remotes.devolver.mockReturnValue(of({}));
    componente['devolver'](control());
    expect(remotes.devolver).toHaveBeenCalledWith(7);
  });

  it('sin resultados lo dice en vez de mostrar una tabla vacía', async () => {
    await montar(pagina([]));
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'No hay controles entregados',
    );
  });
});
