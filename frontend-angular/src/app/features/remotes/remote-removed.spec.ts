import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemotesService } from '../../core/api/remotes.service';
import { ResultadoBusqueda } from '../../core/models/api.models';
import { RemoteRemoved } from './remote-removed';

function removido(cambios: Partial<ResultadoBusqueda> = {}): ResultadoBusqueda {
  return {
    id: 7,
    serial: 'CR-000001',
    status: 'INVENTORY',
    homeId: null,
    modelo: {
      id: 1,
      code: 'CR4',
      name: 'Control de 4 botones',
      buttons: 4,
      active: true,
      notes: null,
    },
    coincidePor: 'serial',
    readyAt: null,
    removedAt: new Date().toISOString(),
    position: null,
    boton: null,
    ...cambios,
  };
}

describe('RemoteRemoved', () => {
  let fixture: ComponentFixture<RemoteRemoved>;
  let componente: RemoteRemoved;
  let remotes: {
    removidos: ReturnType<typeof vi.fn>;
    restaurar: ReturnType<typeof vi.fn>;
    borrarDefinitivo: ReturnType<typeof vi.fn>;
  };

  async function montar(items: ResultadoBusqueda[] = [removido()]): Promise<void> {
    remotes.removidos.mockReturnValue(of(items));
    fixture = TestBed.createComponent(RemoteRemoved);
    componente = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    remotes = {
      removidos: vi.fn(),
      restaurar: vi.fn(),
      borrarDefinitivo: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [RemoteRemoved],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: RemotesService, useValue: remotes },
      ],
    });
  });

  it('avisa que remover NO deja el control sin efecto', async () => {
    await montar();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    // Es el hueco que en alarmas se cierra revocando la credencial del broker.
    expect(html).toContain('no lo deja sin efecto');
    expect(html).toContain('sigue disparando');
  });

  it('dar de alta lo saca de la lista y explica que vuelve sin visto bueno', async () => {
    await montar();
    remotes.restaurar.mockReturnValue(of(removido({ removedAt: null })));

    componente['reactivar'](componente['items']()[0]);
    await fixture.whenStable();

    expect(remotes.restaurar).toHaveBeenCalledWith(7);
    expect(componente['items']()).toHaveLength(0);
    expect(componente['aviso']()).toContain('SIN el visto bueno');
  });

  // ── Borrado definitivo ────────────────────────────────────────────

  it('borrar pide confirmación primero, en la fila', async () => {
    await montar();
    componente['pedirConfirmacion'](componente['items']()[0]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(remotes.borrarDefinitivo).not.toHaveBeenCalled();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    // El confirm() del navegador no puede decir qué serial se borra.
    expect(html).toContain('CR-000001');
    expect(html).toContain('No se puede deshacer');
  });

  it('al confirmar, avisa que los códigos vuelven a estar disponibles', async () => {
    await montar();
    remotes.borrarDefinitivo.mockReturnValue(
      of({ mensaje: 'Se borró CR-000001 definitivamente.' }),
    );

    componente['pedirConfirmacion'](componente['items']()[0]);
    componente['borrar'](componente['items']()[0]);
    await fixture.whenStable();

    expect(componente['items']()).toHaveLength(0);
    expect(componente['aviso']()).toContain('vuelven a estar disponibles');
  });

  it('un control con eventos no se borra y se muestra el motivo', async () => {
    await montar();
    remotes.borrarDefinitivo.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: {
              message:
                'No se puede borrar CR-000001: tiene eventos registrados, y los eventos no se borran nunca.',
            },
          }),
      ),
    );

    componente['borrar'](componente['items']()[0]);
    await fixture.whenStable();

    expect(componente['error']()).toContain('eventos');
    // Sigue en la lista: no se borró nada.
    expect(componente['items']()).toHaveLength(1);
  });

  it('el buscador filtra por serial', async () => {
    await montar([removido(), removido({ id: 8, serial: 'CR-000002' })]);
    componente['search'].set('000002');
    expect(componente['filtered']()).toHaveLength(1);
    expect(componente['filtered']()[0].serial).toBe('CR-000002');
  });

  it('sin removidos lo dice, en vez de una tabla vacía', async () => {
    await montar([]);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'No hay controles removidos',
    );
  });
});
