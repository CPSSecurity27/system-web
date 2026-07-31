/**
 * El menú como DATO, no como HTML.
 *
 * La navegación se arma con el par (tipo de cuenta, rol), NUNCA con el rol
 * suelto: ADMIN en COMPANY es el admin de CPS, ADMIN en una ORGANIZATION es el
 * gestor de un municipio.
 *
 * Esconder un link NO es la protección — el backend ya rechaza con 403. Es para
 * no ofrecer puertas que dan a un error o a una pantalla vacía.
 *
 * El corte de las secciones es por FRECUENCIA DE USO, no por quién lo hace:
 *   Operar       el día a día, recortado por alcance
 *   Inventario   equipos que todavía no están en servicio
 *   Administrar  lo comercial, de vez en cuando
 *   Mi Empresa   el negocio de CPS
 */

export interface NavItem {
  label: string;
  link: string;
  icon: string;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export interface NavFlags {
  isCps: boolean;
  isManager: boolean;
  isCommunityOrg: boolean;
}

export function buildNav(flags: NavFlags): NavSection[] {
  const sections: NavSection[] = [
    {
      label: 'Operar',
      items: [
        { label: 'Inicio', link: '/', icon: 'bi-speedometer2' },
        { label: 'Eventos', link: '/eventos', icon: 'bi-bell' },
        {
          // Una organización COMMUNITY gestiona UN solo barrio (lo fuerza el
          // negocio): el plural quedaría mal.
          label: flags.isCommunityOrg ? 'Barrio' : 'Barrios',
          link: '/barrios',
          icon: 'bi-houses',
        },
        { label: 'Viviendas', link: '/viviendas', icon: 'bi-house-door' },
        { label: 'Alarmas', link: '/alarmas', icon: 'bi-broadcast' },
        { label: 'Controles', link: '/controles', icon: 'bi-key' },
      ],
    },
    {
      // Fase 1: sigue siendo solo-CPS. Que la organización vea SU stock es
      // Fase 4, junto con la revisión de alcance en el backend.
      label: 'Inventario',
      items: flags.isCps
        ? [
            { label: 'Alarmas', link: '/inventario/stock', icon: 'bi-box-seam' },
            { label: 'Fábrica', link: '/inventario/fabrica', icon: 'bi-cpu' },
            { label: 'Controles', link: '/inventario/controles', icon: 'bi-key-fill' },
          ]
        : [],
    },
    {
      label: 'Administrar',
      items: [
        ...(flags.isCps ? [{ label: 'Clientes', link: '/clientes', icon: 'bi-briefcase' }] : []),
        ...(flags.isManager
          ? [{ label: 'Contratos', link: '/contratos', icon: 'bi-file-earmark-text' }]
          : []),
        ...(flags.isCps ? [{ label: 'Usuarios', link: '/usuarios', icon: 'bi-people' }] : []),
      ],
    },
    {
      label: 'Mi Empresa',
      items: flags.isCps
        ? [
            { label: 'Personal', link: '/empresa/personal', icon: 'bi-person-badge' },
            { label: 'Planes', link: '/empresa/planes', icon: 'bi-tags' },
          ]
        : [],
    },
  ];

  return sections.filter((s) => s.items.length > 0);
}
