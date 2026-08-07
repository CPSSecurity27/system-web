import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountsService } from '../../core/api/accounts.service';
import { RemotesService } from '../../core/api/remotes.service';
import { AuthService } from '../../core/auth/auth.service';
import { Account, Remote } from '../../core/models/api.models';
import { RemoteInventory } from './remote-inventory';

function control(cambios: Partial<Remote> = {}): Remote {
  return {
    id: 7,
    serial: 'CR-000001',
    modelId: 1,
    model: {
      id: 1,
      code: 'CR4',
      name: 'Control de 4 botones',
      buttons: 4,
      active: true,
      notes: null,
    },
    manufacturedAt: null,
    name: null,
    status: 'INVENTORY',
    homeId: null,
    organizationId: null,
    assignedToUserId: null,
    deviceId: null,
    ...cambios,
  } as Remote;
}

function cuenta(): Account {
  return { id: 5, name: 'Municipalidad de Córdoba', type: 'ORGANIZATION' } as Account;
}

describe('RemoteInventory', () => {
  let fixture: ComponentFixture<RemoteInventory>;
  let componente: RemoteInventory;
  let remotes: {
    inventory: ReturnType<typeof vi.fn>;
    entregarLote: ReturnType<typeof vi.fn>;
    adoptar: ReturnType<typeof vi.fn>;
  };
  let accounts: { list: ReturnType<typeof vi.fn> };

  async function montar(
    stock: Remote[] = [control()],
    esCps = true,
  ): Promise<void> {
    remotes.inventory.mockReturnValue(of(stock));
    accounts.list.mockReturnValue(of([cuenta()]));
    TestBed.overrideProvider(AuthService, {
      useValue: { isCps: signal(esCps) },
    });
    fixture = TestBed.createComponent(RemoteInventory);
    componente = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    remotes = {
      inventory: vi.fn(),
      entregarLote: vi.fn(),
      adoptar: vi.fn(),
    };
    accounts = { list: vi.fn() };
    TestBed.configureTestingModule({
      imports: [RemoteInventory],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: RemotesService, useValue: remotes },
        { provide: AccountsService, useValue: accounts },
        { provide: AuthService, useValue: { isCps: signal(true) } },
      ],
    });
  });

  it('muestra el stock con su modelo', async () => {
    await montar();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('CR-000001');
    expect(html).toContain('4 botones');
  });

  it('acá NO se entrega a una vivienda: eso es Operar', async () => {
    await montar();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    // El recorrido municipio → barrio → casa → vecino no entra en esta pantalla.
    expect(html).toContain('Asignar un control');
    expect(html).not.toContain('Entregar a la vivienda');
  });

  // ── Entrega de lote ───────────────────────────────────────────────

  it('sin destino o sin controles marcados no se entrega nada', async () => {
    await montar();
    expect(componente['puedeEntregar']()).toBe(false);

    componente['alternar'](7);
    expect(componente['puedeEntregar']()).toBe(false); // falta el cliente

    componente['destino'].set(5);
    expect(componente['puedeEntregar']()).toBe(true);
  });

  it('el lote va con todos los marcados y explica qué NO hace', async () => {
    await montar([control(), control({ id: 8, serial: 'CR-000002' })]);
    remotes.entregarLote.mockReturnValue(of({ delivered: 2 }));

    componente['alternar'](7);
    componente['alternar'](8);
    componente['destino'].set(5);
    componente['entregarLote']();
    await fixture.whenStable();

    expect(remotes.entregarLote).toHaveBeenCalledWith([7, 8], 5);
    // Entregar no es asignar: el aviso lo dice para que nadie lo suponga.
    expect(componente['aviso']()).toContain('Operar');
  });

  it('marcar todos alcanza solo a lo que está a la vista', async () => {
    await montar([control(), control({ id: 8, serial: 'CR-000002' })]);
    componente['search'].set('000002');
    componente['alternarTodos']();

    expect([...componente['elegidos']()]).toEqual([8]);
  });

  it('una organización no ve la entrega de lotes', async () => {
    await montar([control()], false);
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).not.toContain('Entregar un lote');
    // Pero sí puede sumar a su stock con el código.
    expect(html).toContain('Sumar uno con su código');
  });

  // ── Adopción ──────────────────────────────────────────────────────

  it('adoptar necesita serial Y código', async () => {
    await montar();
    componente['adoptSerial'].set('CR-000001');
    expect(componente['puedeAdoptar']()).toBe(false);

    componente['adoptCodigo'].set('K7M2PQ');
    expect(componente['puedeAdoptar']()).toBe(true);
  });

  it('adoptar suma el control al stock propio', async () => {
    await montar();
    remotes.adoptar.mockReturnValue(of(control({ organizationId: 5 })));

    componente['adoptSerial'].set(' CR-000001 ');
    componente['adoptCodigo'].set(' K7M2PQ ');
    componente['adoptar']();
    await fixture.whenStable();

    // Se recortan los espacios: se copia de una etiqueta chica.
    expect(remotes.adoptar).toHaveBeenCalledWith('CR-000001', 'K7M2PQ');
    expect(componente['aviso']()).toContain('CR-000001');
  });

  it('un código equivocado se muestra tal cual lo explica el backend', async () => {
    await montar();
    remotes.adoptar.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 404,
            error: { message: 'No hay ningún control con ese serial y código' },
          }),
      ),
    );

    componente['adoptSerial'].set('CR-000001');
    componente['adoptCodigo'].set('XXXXXX');
    componente['adoptar']();
    await fixture.whenStable();

    expect(componente['error']()).toContain('serial y código');
  });

  it('sin stock lo dice y explica cómo entra uno', async () => {
    await montar([]);
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('No hay controles en stock');
    expect(html).toContain('Listo');
  });
});
