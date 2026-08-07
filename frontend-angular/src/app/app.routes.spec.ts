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
  it('Inventario tiene una pantalla por familia, más la fábrica', () => {
    const paths = inventarioChildren().map((r) => r.path);
    // `alarmas` y `controles` son STOCK; fabricar es otra cosa y vive aparte.
    expect(paths).toContain('alarmas');
    expect(paths).toContain('controles');
    expect(paths).toContain('fabrica');
  });

  it('la fábrica es la única que secciona por familia', () => {
    const fabrica = inventarioChildren().find((r) => r.path === 'fabrica');
    const paths = (fabrica?.children ?? []).map((r) => r.path);
    expect(paths).toContain('alarmas');
    expect(paths).toContain('controles');
    expect(paths).toContain('alarmas/removidos');
    expect(paths).toContain('controles/removidos');
  });

  it('Inventario entra por el stock de alarmas', () => {
    const index = inventarioChildren().find((r) => r.path === '');
    expect(index?.redirectTo).toBe('alarmas');
  });

  it('el link viejo de la fábrica sigue llevando a la fábrica', () => {
    expect(inventarioChildren().find((r) => r.path === 'stock')?.redirectTo).toBe('alarmas');
    expect(inventarioChildren().find((r) => r.path === 'alarmas/fabricar')?.redirectTo).toBe(
      'fabrica/alarmas',
    );
    expect(inventarioChildren().find((r) => r.path === 'removidos')?.redirectTo).toBe(
      'fabrica/alarmas/removidos',
    );
  });

  it('el stock viejo redirige a Inventario', () => {
    expect(find('alarmas/stock')?.redirectTo).toBe('/inventario/alarmas');
  });

  it('el alta vieja de alarmas lleva a la fábrica', () => {
    expect(find('alarmas/nueva')?.redirectTo).toBe('/inventario/fabrica/alarmas');
  });

  it('el alta vieja de controles lleva a la asignación', () => {
    // El alta manual se eliminó: creaba controles sin serial, sin modelo y sin
    // códigos, o sea controles que no podían funcionar. Todo control nace en la
    // fábrica, y lo que se hace con uno existente es asignarlo.
    expect(find('controles/nuevo')?.redirectTo).toBe('/controles/asignar');
  });

  it('Actualizaciones tiene sus dos pestañas y entra por Versiones', () => {
    const hijos = find('actualizaciones')?.children ?? [];
    const paths = hijos.map((r) => r.path);
    // Dos trabajos distintos y en dos momentos distintos: primero se publica
    // una versión, y después —quizás días después— se decide a qué postes va.
    expect(paths).toContain('versiones');
    expect(paths).toContain('equipos');
    expect(hijos.find((r) => r.path === '')?.redirectTo).toBe('versiones');
  });

  it('Actualizaciones está detrás del cpsGuard', () => {
    // Un firmware corre en los postes de TODOS los clientes: publicarlo no es
    // una decisión de un barrio. Mismo criterio que la fábrica.
    expect(find('actualizaciones')?.canActivate?.length).toBeGreaterThan(0);
    expect(find('actualizaciones')?.canActivate).toEqual(find('inventario')?.children?.find((r) => r.path === 'fabrica')?.canActivate);
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
