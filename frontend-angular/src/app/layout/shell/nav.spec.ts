import { buildNav, NavFlags } from './nav';

const flags = (over: Partial<NavFlags> = {}): NavFlags => ({
  isCps: false,
  isManager: false,
  isCommunityOrg: false,
  ...over,
});

const sectionLabels = (f: NavFlags) => buildNav(f).map((s) => s.label);
const linksOf = (f: NavFlags, label: string) =>
  buildNav(f)
    .find((s) => s.label === label)
    ?.items.map((i) => i.link) ?? [];

describe('buildNav', () => {
  it('el vecino solo ve Operar', () => {
    expect(sectionLabels(flags())).toEqual(['Operar']);
  });

  it('Operar tiene las cinco pantallas del día a día más Inicio', () => {
    expect(linksOf(flags(), 'Operar')).toEqual([
      '/',
      '/eventos',
      '/barrios',
      '/viviendas',
      '/alarmas',
      '/controles',
    ]);
  });

  it('una organización COMMUNITY ve "Barrio" en singular', () => {
    const items = buildNav(flags({ isCommunityOrg: true }))[0].items;
    expect(items.find((i) => i.link === '/barrios')?.label).toBe('Barrio');
  });

  it('sin COMMUNITY el label es plural', () => {
    const items = buildNav(flags())[0].items;
    expect(items.find((i) => i.link === '/barrios')?.label).toBe('Barrios');
  });

  it('el manager de una organización ve Administrar con Contratos solamente', () => {
    expect(sectionLabels(flags({ isManager: true }))).toEqual(['Operar', 'Administrar']);
    expect(linksOf(flags({ isManager: true }), 'Administrar')).toEqual(['/contratos']);
  });

  it('CPS ve las cuatro secciones', () => {
    expect(sectionLabels(flags({ isCps: true, isManager: true }))).toEqual([
      'Operar',
      'Inventario',
      'Administrar',
      'Mi Empresa',
    ]);
  });

  it('Inventario es solo de CPS en esta fase', () => {
    expect(sectionLabels(flags({ isManager: true }))).not.toContain('Inventario');
    expect(linksOf(flags({ isCps: true, isManager: true }), 'Inventario')).toEqual([
      '/inventario/stock',
      '/inventario/fabrica',
      '/inventario/controles',
    ]);
  });

  it('Administrar de CPS suma Clientes y Usuarios', () => {
    expect(linksOf(flags({ isCps: true, isManager: true }), 'Administrar')).toEqual([
      '/clientes',
      '/contratos',
      '/usuarios',
    ]);
  });

  it('Mi Empresa es solo comercial', () => {
    expect(linksOf(flags({ isCps: true, isManager: true }), 'Mi Empresa')).toEqual([
      '/empresa/personal',
      '/empresa/planes',
    ]);
  });

  it('no devuelve secciones vacías', () => {
    for (const s of buildNav(flags({ isCps: true, isManager: true }))) {
      expect(s.items.length).toBeGreaterThan(0);
    }
  });
});
