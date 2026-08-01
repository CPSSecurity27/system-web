import { Routes } from '@angular/router';

import { routes } from './app.routes';

/** Las rutas privadas cuelgan del shell (el único hijo de la ruta ''). */
const shellChildren = (): Routes => {
  const shell = routes.find((r) => r.path === '' && r.children);
  return shell?.children ?? [];
};

const find = (path: string) => shellChildren().find((r) => r.path === path);

const inventarioChildren = (): Routes => find('inventario')?.children ?? [];

describe('rutas', () => {
  it('Inventario tiene stock, fábrica y controles', () => {
    const paths = inventarioChildren().map((r) => r.path);
    expect(paths).toContain('stock');
    expect(paths).toContain('fabrica');
    expect(paths).toContain('controles');
  });

  it('Inventario entra por stock', () => {
    const index = inventarioChildren().find((r) => r.path === '');
    expect(index?.redirectTo).toBe('stock');
  });

  it('el link viejo de la fábrica sigue llevando a la fábrica', () => {
    expect(inventarioChildren().find((r) => r.path === 'alarmas')?.redirectTo).toBe('fabrica');
    expect(inventarioChildren().find((r) => r.path === 'alarmas/fabricar')?.redirectTo).toBe(
      'fabrica',
    );
  });

  it('el stock viejo redirige a Inventario', () => {
    expect(find('alarmas/stock')?.redirectTo).toBe('/inventario/stock');
  });

  it('el alta vieja de alarmas lleva a la fábrica', () => {
    expect(find('alarmas/nueva')?.redirectTo).toBe('/inventario/fabrica');
  });

  it('el alta vieja de controles lleva a Inventario', () => {
    expect(find('controles/nuevo')?.redirectTo).toBe('inventario/controles');
  });

  it('Mi organización existe y no lleva :id (sale de la sesión)', () => {
    expect(find('mi-organizacion')).toBeDefined();
    expect(find('mi-organizacion')?.redirectTo).toBeUndefined();
  });

  it('los links viejos de contratos llevan a Clientes', () => {
    expect(find('contratos')?.redirectTo).toBe('clientes');
    expect(find('contratos/nuevo')?.redirectTo).toBe('clientes');
  });

  it('las rutas de Operar no se movieron', () => {
    const operar = ['eventos', 'barrios', 'viviendas', 'alarmas', 'controles'];
    // Comparar la lista completa —en vez de un expect por vuelta— hace que el
    // fallo diga CUÁL ruta falta, sin necesidad de un mensaje por assertion.
    expect(operar.filter((p) => find(p) !== undefined)).toEqual(operar);
  });
});
