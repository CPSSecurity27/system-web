import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HomesService } from '../../core/api/homes.service';
import { AuthService } from '../../core/auth/auth.service';
import { Home } from '../../core/models/api.models';
import { HomeMembers } from './home-members';

const CASA = 7;

function casa(cambios: Partial<Home> = {}): Home {
  return {
    id: CASA,
    address: 'Mza A Casa 5',
    contactPhone: null,
    defaultDeviceId: 3,
    status: 'ACTIVE',
    latitude: -31.42,
    longitude: -64.18,
    neighborhoodId: 2,
    ...cambios,
  };
}

/**
 * Se prueba la CLASE, no el render: el template monta Leaflet y en jsdom eso es
 * pelear con el DOM para verificar reglas que no viven ahí. Con el template
 * vacío, `puedeEditarUbicacion` y el guardado se ejercitan tal cual son.
 */
describe('HomeMembers — dónde está la casa', () => {
  let homes: {
    get: ReturnType<typeof vi.fn>;
    members: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  let auth: { isManager: ReturnType<typeof signal<boolean>>; user: ReturnType<typeof signal> };

  function montar(): HomeMembers {
    TestBed.overrideComponent(HomeMembers, { set: { template: '' } });
    const fixture = TestBed.createComponent(HomeMembers);
    return fixture.componentInstance;
  }

  function configurar(opciones: {
    esManager?: boolean;
    membresias?: { homeId: number; role: string }[];
  }) {
    homes = {
      get: vi.fn().mockReturnValue(of(casa())),
      members: vi.fn().mockReturnValue(of([])),
      update: vi.fn(),
    };
    auth = {
      isManager: signal(opciones.esManager ?? false),
      user: signal({ id: 1, name: 'Quien sea', homeMemberships: opciones.membresias ?? [] }),
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: HomesService, useValue: homes },
        { provide: AuthService, useValue: auth },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => String(CASA) } } },
        },
      ],
    });
  }

  beforeEach(() => configurar({}));

  // ── Quién puede corregir el pin ────────────────────────────────────

  it('el gestor del barrio puede', () => {
    TestBed.resetTestingModule();
    configurar({ esManager: true });
    expect(montar()['puedeEditarUbicacion']()).toBe(true);
  });

  it('el titular de ESTA casa puede', () => {
    TestBed.resetTestingModule();
    configurar({ membresias: [{ homeId: CASA, role: 'TITULAR' }] });
    expect(montar()['puedeEditarUbicacion']()).toBe(true);
  });

  /**
   * La trampa: `auth.isTitular()` dice que sos titular de ALGUNA casa. Usarlo
   * acá le daría el botón al titular de la casa de enfrente — y el backend lo
   * frenaría con un 403 después de haberle dejado mover el pin en pantalla.
   */
  it('el titular de OTRA casa NO puede', () => {
    TestBed.resetTestingModule();
    configurar({ membresias: [{ homeId: 99, role: 'TITULAR' }] });
    expect(montar()['puedeEditarUbicacion']()).toBe(false);
  });

  it('un familiar de esta casa tampoco', () => {
    TestBed.resetTestingModule();
    configurar({ membresias: [{ homeId: CASA, role: 'FAMILIAR' }] });
    expect(montar()['puedeEditarUbicacion']()).toBe(false);
  });

  // ── El punto ───────────────────────────────────────────────────────

  it('el pin arranca donde está la casa', () => {
    const c = montar();
    expect(c['markers']()).toEqual([
      { latitude: -31.42, longitude: -64.18, label: 'Mza A Casa 5', variant: 'home' },
    ]);
    expect(c['centroMapa']()).toEqual([-31.42, -64.18]);
  });

  it('clickear el mapa mueve el pin pero NO guarda', () => {
    const c = montar();
    c['setUbicacion']({ latitude: -31.5, longitude: -64.2 });

    // Se ve el punto nuevo…
    expect(c['markers']()[0].latitude).toBe(-31.5);
    // …y la casa sigue como estaba hasta que alguien apriete Guardar.
    expect(homes.update).not.toHaveBeenCalled();
    expect(c['home']()?.latitude).toBe(-31.42);
  });

  it('guardar manda SOLO las coordenadas', () => {
    const c = montar();
    homes.update.mockReturnValue(of(casa({ latitude: -31.5, longitude: -64.2 })));

    c['setUbicacion']({ latitude: -31.5, longitude: -64.2 });
    c['guardarUbicacion']();

    // Un PATCH de dos campos: la dirección, el teléfono y la alarma preferida
    // de esta casa no se tocan.
    expect(homes.update).toHaveBeenCalledWith(CASA, {
      latitude: -31.5,
      longitude: -64.2,
    });
    expect(c['home']()?.latitude).toBe(-31.5);
    expect(c['nuevaUbicacion']()).toBeNull();
    expect(c['avisoUbicacion']()).toContain('punto nuevo');
  });

  it('descartar deja la casa donde estaba', () => {
    const c = montar();
    c['setUbicacion']({ latitude: -31.5, longitude: -64.2 });
    c['descartarUbicacion']();

    expect(c['markers']()[0].latitude).toBe(-31.42);
    expect(homes.update).not.toHaveBeenCalled();
  });

  it('sin nada marcado, guardar no hace nada', () => {
    const c = montar();
    c['guardarUbicacion']();
    expect(homes.update).not.toHaveBeenCalled();
  });

  it('el 403 del backend se muestra tal cual', () => {
    const c = montar();
    homes.update.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 403,
            error: { message: 'No podés editar esta vivienda' },
          }),
      ),
    );

    c['setUbicacion']({ latitude: -31.5, longitude: -64.2 });
    c['guardarUbicacion']();

    expect(c['errorUbicacion']()).toContain('No podés editar esta vivienda');
    // El punto elegido NO se descarta: se puede reintentar sin volver a marcarlo.
    expect(c['nuevaUbicacion']()).not.toBeNull();
  });
});
