import { buildNav, NavFlags } from './nav';

const flags = (over: Partial<NavFlags> = {}): NavFlags => ({
  isCps: false,
  isManager: false,
  isOrgManager: false,
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

  it('el manager de una organización ve Operar, su Inventario y su organización', () => {
    const f = flags({ isManager: true, isOrgManager: true });
    expect(sectionLabels(f)).toEqual(['Operar', 'Inventario', 'Mi organización']);
    expect(linksOf(f, 'Mi organización')).toEqual(['/mi-organizacion']);
  });

  it('la organización NO ve Administrar: Clientes y Usuarios son solo de CPS', () => {
    expect(sectionLabels(flags({ isManager: true, isOrgManager: true }))).not.toContain(
      'Administrar',
    );
  });

  it('CPS NO ve "Mi organización": para eso tiene Mi Empresa', () => {
    expect(sectionLabels(flags({ isCps: true, isManager: true }))).not.toContain(
      'Mi organización',
    );
  });

  it('Contratos ya no es una pestaña: el contrato vive en la ficha del cliente', () => {
    for (const f of [
      flags({ isCps: true, isManager: true }),
      flags({ isManager: true, isOrgManager: true }),
    ]) {
      const links = buildNav(f).flatMap((s) => s.items.map((i) => i.link));
      expect(links).not.toContain('/contratos');
    }
  });

  it('CPS ve las cuatro secciones', () => {
    expect(sectionLabels(flags({ isCps: true, isManager: true }))).toEqual([
      'Operar',
      'Inventario',
      'Administrar',
      'Mi Empresa',
    ]);
  });

  it('CPS ve todo el inventario, fábrica incluida', () => {
    expect(linksOf(flags({ isCps: true, isManager: true }), 'Inventario')).toEqual([
      '/inventario/stock',
      '/inventario/fabrica',
      '/inventario/controles',
    ]);
  });

  it('el cliente ve SU inventario: alarmas y controles, pero NO la fábrica', () => {
    const f = flags({ isManager: true, isOrgManager: true });
    expect(linksOf(f, 'Inventario')).toEqual([
      '/inventario/stock',
      '/inventario/controles',
    ]);
  });

  it('el vecino no ve inventario', () => {
    expect(sectionLabels(flags())).not.toContain('Inventario');
  });

  it('Administrar de CPS son Clientes y Usuarios', () => {
    expect(linksOf(flags({ isCps: true, isManager: true }), 'Administrar')).toEqual([
      '/clientes',
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
