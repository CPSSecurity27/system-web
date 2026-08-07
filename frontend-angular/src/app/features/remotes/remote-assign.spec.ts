import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HomesService } from '../../core/api/homes.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { RemotesService } from '../../core/api/remotes.service';
import { AuthService } from '../../core/auth/auth.service';
import { Home, HomeMember, Remote } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';
import { RemoteAssign } from './remote-assign';

function barrio(id: number, orgId: number, orgName: string): Neighborhood {
  return {
    id,
    name: `Barrio ${id}`,
    status: 'ACTIVE',
    organizationId: orgId,
    organization: { id: orgId, name: orgName, subtype: 'MUNICIPAL' },
  } as Neighborhood;
}

function casa(id = 3): Home {
  return {
    id,
    address: 'Belgrano 123',
    contactPhone: null,
    defaultDeviceId: null,
    status: 'ACTIVE',
    latitude: -31.42,
    longitude: -64.18,
    neighborhoodId: 1,
  };
}

function miembro(userId: number, nombre: string, rol: 'TITULAR' | 'FAMILIAR'): HomeMember {
  return {
    id: userId,
    homeId: 3,
    userId,
    role: rol,
    status: 'ACTIVE',
    activated: true,
    user: { id: userId, name: nombre },
  } as HomeMember;
}

function control(id = 7): Remote {
  return { id, serial: `CR-00000${id}`, model: { buttons: 4 } } as Remote;
}

describe('RemoteAssign', () => {
  let fixture: ComponentFixture<RemoteAssign>;
  let componente: RemoteAssign;
  let remotes: {
    inventory: ReturnType<typeof vi.fn>;
    assign: ReturnType<typeof vi.fn>;
  };
  let homes: { list: ReturnType<typeof vi.fn>; members: ReturnType<typeof vi.fn> };
  let neighborhoods: { list: ReturnType<typeof vi.fn> };

  async function montar(barrios: Neighborhood[]): Promise<void> {
    neighborhoods.list.mockReturnValue(of(barrios));
    remotes.inventory.mockReturnValue(of([control()]));
    homes.list.mockReturnValue(of([casa()]));
    homes.members.mockReturnValue(
      of([miembro(11, 'Juan Pérez', 'TITULAR'), miembro(12, 'Pedro Pérez', 'FAMILIAR')]),
    );
    fixture = TestBed.createComponent(RemoteAssign);
    componente = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    remotes = { inventory: vi.fn(), assign: vi.fn() };
    homes = { list: vi.fn(), members: vi.fn() };
    neighborhoods = { list: vi.fn() };
    TestBed.configureTestingModule({
      imports: [RemoteAssign],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: RemotesService, useValue: remotes },
        { provide: HomesService, useValue: homes },
        { provide: NeighborhoodsService, useValue: neighborhoods },
        { provide: AuthService, useValue: {} },
      ],
    });
  });

  it('los clientes salen de los barrios, no de la lista de cuentas', async () => {
    await montar([
      barrio(1, 5, 'Municipalidad de Córdoba'),
      barrio(2, 5, 'Municipalidad de Córdoba'),
      barrio(3, 9, 'Consorcio Los Aromos'),
    ]);
    // Uno por organización, sin repetir: un cliente sin barrios no puede
    // recibir un control, así que no se ofrece.
    expect(componente['organizaciones']().map((o) => o.id)).toEqual([9, 5]);
  });

  it('con un solo cliente a la vista, ese paso se resuelve solo', async () => {
    await montar([barrio(1, 5, 'Municipalidad de Córdoba')]);
    expect(componente['orgId']()).toBe(5);
  });

  it('cada paso limpia los de abajo', async () => {
    await montar([
      barrio(1, 5, 'Muni'),
      barrio(2, 9, 'Consorcio'),
    ]);

    componente['elegirCliente'](5);
    componente['elegirBarrio'](1);
    componente['elegirCasa'](3);
    expect(componente['casaId']()).toBe(3);

    // Cambiar de cliente no puede dejar una casa de otro barrio elegida.
    componente['elegirCliente'](9);
    expect(componente['barrioId']()).toBeNull();
    expect(componente['casaId']()).toBeNull();
    expect(componente['vecinoId']()).toBeNull();
  });

  it('con un solo miembro activo, el portador se elige solo', async () => {
    await montar([barrio(1, 5, 'Muni')]);
    // Después de montar: `montar` fija sus propios mocks.
    homes.members.mockReturnValue(of([miembro(11, 'Juan Pérez', 'TITULAR')]));

    componente['elegirBarrio'](1);
    componente['elegirCasa'](3);
    await fixture.whenStable();

    expect(componente['vecinoId']()).toBe(11);
  });

  it('no deja asignar hasta tener casa, vecino y control', async () => {
    await montar([barrio(1, 5, 'Muni')]);
    componente['elegirBarrio'](1);
    componente['elegirCasa'](3);
    await fixture.whenStable();

    // Ya hay casa y vecino (dos miembros: hay que elegir).
    componente['vecinoId'].set(12);
    expect(componente['puedeAsignar']()).toBe(false); // falta el control

    componente['controlId'].set(7);
    expect(componente['puedeAsignar']()).toBe(true);
  });

  it('asigna con casa Y portador, y lo dice con nombre y dirección', async () => {
    await montar([barrio(1, 5, 'Muni')]);
    remotes.assign.mockReturnValue(of(control()));

    componente['elegirBarrio'](1);
    componente['elegirCasa'](3);
    await fixture.whenStable();
    componente['vecinoId'].set(12);
    componente['controlId'].set(7);

    componente['asignar']();
    await fixture.whenStable();

    expect(remotes.assign).toHaveBeenCalledWith(7, 3, 12);
    expect(componente['aviso']()).toContain('Belgrano 123');
    expect(componente['aviso']()).toContain('Pedro Pérez');
  });

  it('avisa que asignar todavía no carga los códigos en las alarmas', async () => {
    await montar([barrio(1, 5, 'Muni')]);
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('no carga los códigos');
  });

  it('después de asignar, el recorrido hasta la casa se conserva', async () => {
    await montar([barrio(1, 5, 'Muni')]);
    remotes.assign.mockReturnValue(of(control()));

    componente['elegirBarrio'](1);
    componente['elegirCasa'](3);
    await fixture.whenStable();
    componente['vecinoId'].set(12);
    componente['controlId'].set(7);
    componente['asignar']();
    await fixture.whenStable();

    // Entregar tres a la misma familia no puede obligar a repetir los pasos.
    expect(componente['casaId']()).toBe(3);
    expect(componente['vecinoId']()).toBe(12);
    expect(componente['controlId']()).toBeNull();
  });
});
