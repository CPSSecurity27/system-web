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
  /** OWNER/ADMIN de una organización cliente. CPS NO cuenta acá. */
  isOrgManager: boolean;
  isCommunityOrg: boolean;
}

export function buildNav(flags: NavFlags): NavSection[] {
  const sections: NavSection[] = [
    {
      label: 'Operar',
      items: [
        { label: 'Inicio', link: '/', icon: 'icon-gauge' },
        { label: 'Eventos', link: '/eventos', icon: 'icon-bell' },
        {
          // Una organización COMMUNITY gestiona UN solo barrio (lo fuerza el
          // negocio): el plural quedaría mal.
          label: flags.isCommunityOrg ? 'Barrio' : 'Barrios',
          link: '/barrios',
          icon: 'icon-map-pinned',
        },
        { label: 'Viviendas', link: '/viviendas', icon: 'icon-house' },
        { label: 'Alarmas', link: '/alarmas', icon: 'icon-radio-tower' },
        { label: 'Controles', link: '/controles', icon: 'icon-key' },
      ],
    },
    {
      /**
       * Los equipos que TODAVÍA NO están en servicio.
       *
       * Lo ve CPS y también el CLIENTE, con su propio stock: la API ya lo
       * permitía (`/devices/inventory` y `/remotes/inventory` aceptan
       * organizaciones) y lo único que lo bloqueaba era esta pantalla. Ahí está
       * el RECLAMO, que es como una municipalidad —o una comunitaria con
       * autogestión— instala sus alarmas sin depender de CPS.
       *
       * FÁBRICA es lo único solo-CPS: una organización recibe equipos, no los
       * produce.
       */
      label: 'Inventario',
      items:
        flags.isCps || flags.isOrgManager
          ? [
              { label: 'Alarmas', link: '/inventario/stock', icon: 'icon-package' },
              ...(flags.isCps
                ? [{ label: 'Fábrica', link: '/inventario/fabrica', icon: 'icon-cpu' }]
                : []),
              { label: 'Controles', link: '/inventario/controles', icon: 'icon-key-round' },
            ]
          : [],
    },
    {
      // Contratos NO está más acá. Desde que el contrato es de la CUENTA (uno
      // ACTIVE por cliente), la lista de contratos ES la lista de clientes con
      // otras columnas: mantener las dos partía el mismo dato en dos lugares.
      // El contrato vive en la ficha del cliente, con renovar/suspender.
      label: 'Administrar',
      items: flags.isCps
        ? [
            { label: 'Clientes', link: '/clientes', icon: 'icon-briefcase' },
            { label: 'Usuarios', link: '/usuarios', icon: 'icon-users' },
          ]
        : [],
    },
    {
      label: 'Mi Empresa',
      items: flags.isCps
        ? [
            { label: 'Personal', link: '/empresa/personal', icon: 'icon-id-card' },
            { label: 'Planes', link: '/empresa/planes', icon: 'icon-tags' },
          ]
        : [],
    },
    {
      // El espejo de "Mi Empresa" para el cliente: su propia ficha, sin `:id`
      // (sale de la sesión). Es lo que reemplaza a la pestaña Contratos para
      // una organización — si no, se quedaría sin ver lo que paga, porque
      // /clientes es solo-CPS.
      label: 'Mi organización',
      items: flags.isOrgManager
        ? [{ label: 'Mi organización', link: '/mi-organizacion', icon: 'icon-building-2' }]
        : [],
    },
  ];

  return sections.filter((s) => s.items.length > 0);
}
