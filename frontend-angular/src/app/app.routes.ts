import { Routes } from '@angular/router';

import {
  authGuard,
  cpsGuard,
  guestGuard,
  managerGuard,
  neighborhoodManagerGuard,
} from './core/auth/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/login/login').then((m) => m.Login),
  },
  {
    path: 'forgot-password',
    canActivate: [guestGuard],
    loadComponent: () =>
      import('./features/auth/forgot-password/forgot-password').then((m) => m.ForgotPassword),
  },
  {
    // El link del mail cae acá: /reset-password?token=...
    // NO lleva guestGuard: si tu sesión vieja sigue abierta en este navegador,
    // igual tenés que poder usar el link.
    path: 'reset-password',
    loadComponent: () =>
      import('./features/auth/reset-password/reset-password').then((m) => m.ResetPassword),
  },
  {
    // Alta de vecino (v2.1): el link de activación cae acá con el MISMO
    // componente que reset-password — mismo endpoint, mismo formulario, solo
    // cambia el texto (route data: activation).
    path: 'activar-cuenta',
    data: { activation: true },
    loadComponent: () =>
      import('./features/auth/reset-password/reset-password').then((m) => m.ResetPassword),
  },
  {
    // El link del mail de verificación cae acá: /verify-email?token=...
    // Sin guards, por lo mismo que reset-password: el link debe funcionar
    // logueado o no. Verificar el correo no es requisito para entrar.
    path: 'verify-email',
    loadComponent: () =>
      import('./features/auth/verify-email/verify-email').then((m) => m.VerifyEmail),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/shell/shell').then((m) => m.Shell),
    children: [
      {
        path: '',
        loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.Dashboard),
      },

      // Eventos: el tablero del monitoreo (nuevo en v2)
      {
        path: 'eventos',
        loadComponent: () => import('./features/events/event-list').then((m) => m.EventList),
      },

      // Barrios
      {
        path: 'barrios',
        loadComponent: () =>
          import('./features/neighborhoods/neighborhood-list').then((m) => m.NeighborhoodList),
      },
      {
        // Antes de :id, si no "nuevo" se leería como un id.
        // v2: la organización MUNICIPAL crea sus propios barrios (contra su
        // cupo); un consorcio PRIVATE no gestiona el suyo, lo crea CPS.
        path: 'barrios/nuevo',
        canActivate: [neighborhoodManagerGuard],
        loadComponent: () =>
          import('./features/neighborhoods/neighborhood-form').then((m) => m.NeighborhoodForm),
      },
      {
        path: 'barrios/:id',
        loadComponent: () =>
          import('./features/neighborhoods/neighborhood-detail').then((m) => m.NeighborhoodDetail),
      },

      // Viviendas
      {
        path: 'viviendas',
        loadComponent: () => import('./features/homes/home-list').then((m) => m.HomeList),
      },
      {
        path: 'viviendas/nueva',
        canActivate: [managerGuard],
        loadComponent: () => import('./features/homes/home-form').then((m) => m.HomeForm),
      },
      {
        // Miembros del hogar: la pantalla del vecindario (nueva en v2)
        path: 'viviendas/:id',
        loadComponent: () => import('./features/homes/home-members').then((m) => m.HomeMembers),
      },

      // ---------------------------------------------------------------------
      // OPERACIÓN — el equipo funcionando. "¿qué pasa en mis barrios?"
      // Lo ve todo el mundo según su alcance (monitor, gestor, vecino).
      // ---------------------------------------------------------------------

      // Alarmas instaladas (son del barrio)
      {
        path: 'alarmas',
        loadComponent: () => import('./features/devices/device-list').then((m) => m.DeviceList),
      },
      // El stock se mudó a Inventario. Van ANTES de ':id' o el router se come
      // "stock" y "nueva" como si fueran un id — mismo motivo por el que
      // 'barrios/nuevo' precede a ':id'.
      { path: 'alarmas/stock', pathMatch: 'full', redirectTo: '/inventario/stock' },
      { path: 'alarmas/nueva', redirectTo: '/inventario/fabrica' },
      {
        path: 'alarmas/:id',
        loadComponent: () => import('./features/devices/device-detail').then((m) => m.DeviceDetail),
      },

      // Controles remotos (son de la vivienda)
      {
        path: 'controles',
        loadComponent: () => import('./features/remotes/remote-list').then((m) => m.RemoteList),
      },

      // ---------------------------------------------------------------------
      // INVENTARIO — los equipos que TODAVÍA NO están en servicio.
      //
      // El corte con /alarmas es el CHECK de la base: INVENTORY <=> sin barrio.
      // Operar/Alarmas son las que tienen barrio; Inventario, las que no.
      //
      // Lo ve CPS y también el CLIENTE con su propio stock (managerGuard): el
      // backend ya recortaba por alcance, y acá está el RECLAMO con el que una
      // muni instala sus alarmas. FÁBRICA sigue siendo lo único solo-CPS.
      // ---------------------------------------------------------------------
      {
        path: 'inventario',
        canActivate: [managerGuard],
        loadComponent: () =>
          import('./features/inventory/inventory-shell').then((m) => m.InventoryShell),
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'stock' },
          {
            // El stock: equipos entregados y por entregar. Provisorio — la
            // ENTREGA de lotes se separa a /inventario/entregas en la Fase 4,
            // y la instalación por reclamo se muda al detalle del barrio.
            path: 'stock',
            loadComponent: () =>
              import('./features/devices/device-inventory').then((m) => m.DeviceInventory),
          },
          {
            // Alta desde MAC + n° de placa, y el registro de todo lo fabricado.
            // Alta y listado en la MISMA pantalla: la estación de flasheo carga
            // placas en tanda y navegar por equipo sería fricción pura.
            //
            // SOLO CPS: una organización recibe equipos, no los fabrica.
            path: 'fabrica',
            canActivate: [cpsGuard],
            loadComponent: () =>
              import('./features/devices/device-factory').then((m) => m.DeviceFactory),
          },
          {
            // Provisorio: el único acto de fábrica que hoy existe para
            // controles es el alta. La pantalla propia —con su listado, al
            // molde de la de alarmas— es la Fase 4.
            path: 'controles',
            loadComponent: () => import('./features/remotes/remote-form').then((m) => m.RemoteForm),
          },
          // Los links viejos siguen andando: alguien los tiene en un favorito.
          { path: 'alarmas', pathMatch: 'full', redirectTo: 'fabrica' },
          { path: 'alarmas/fabricar', redirectTo: 'fabrica' },
        ],
      },

      { path: 'controles/nuevo', redirectTo: 'inventario/controles' },

      // ---------------------------------------------------------------------
      // CLIENTES — el mundo de afuera: quién nos compra el servicio.
      //
      // CPS no está acá (la lista pide type=ORGANIZATION): no es un cliente,
      // no firma contratos y no tiene cupos. Su ficha vive en /empresa.
      //
      // Era /cuentas hasta 2026-07-30. El modelo y la API siguen hablando de
      // `account` —ahí el término es correcto—; lo que cambió es la pantalla,
      // que ahora muestra clientes y solo clientes.
      // ---------------------------------------------------------------------
      {
        path: 'clientes',
        canActivate: [cpsGuard],
        loadComponent: () => import('./features/accounts/account-list').then((m) => m.AccountList),
      },
      {
        path: 'clientes/nuevo',
        canActivate: [cpsGuard],
        loadComponent: () => import('./features/accounts/account-form').then((m) => m.AccountForm),
      },
      {
        path: 'clientes/:id',
        loadComponent: () =>
          import('./features/accounts/account-members').then((m) => m.AccountMembers),
      },
      // Los links viejos siguen andando: alguien los tiene en un favorito.
      { path: 'cuentas', pathMatch: 'full', redirectTo: 'clientes' },
      { path: 'cuentas/nueva', redirectTo: 'clientes/nuevo' },
      { path: 'cuentas/:id', redirectTo: 'clientes/:id' },

      // ---------------------------------------------------------------------
      // MI EMPRESA — nuestro negocio, no el de los clientes.
      //
      // Acá va lo que es de CPS: su personal, su catálogo de planes y, más
      // adelante, facturación y configuración. Se separó de Clientes porque
      // CPS no es una cuenta más: la base ya lo dice (una sola COMPANY, sin
      // cupos, sin contratos) y la UI era el único lugar que la trataba como
      // si lo fuera, con un "—" en cada columna.
      // ---------------------------------------------------------------------
      {
        path: 'empresa',
        canActivate: [cpsGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'personal' },
          {
            // Mismo componente que la ficha de un cliente: es el mismo trabajo
            // sobre la misma tabla. Sin `:id` — CPS es única y sale de la sesión.
            path: 'personal',
            loadComponent: () =>
              import('./features/accounts/account-members').then((m) => m.AccountMembers),
          },
          {
            path: 'planes',
            loadComponent: () => import('./features/company/plan-list').then((m) => m.PlanList),
          },
        ],
      },

      // ---------------------------------------------------------------------
      // MI ORGANIZACIÓN — la ficha del PROPIO cliente, sin `:id`.
      //
      // Es el espejo de /empresa/personal: mismo componente, la cuenta sale de
      // la sesión. Existe porque /clientes es solo-CPS: sin esto, el admin de
      // una municipalidad no tendría dónde ver sus cupos ni su contrato.
      // ---------------------------------------------------------------------
      {
        path: 'mi-organizacion',
        loadComponent: () =>
          import('./features/accounts/account-members').then((m) => m.AccountMembers),
      },

      // Contratos dejó de ser pestaña (2026-07-31): el contrato es de la cuenta
      // y vive en su ficha. Los links viejos siguen andando.
      { path: 'contratos', pathMatch: 'full', redirectTo: 'clientes' },
      { path: 'contratos/nuevo', redirectTo: 'clientes' },

      // Padrón de usuarios: solo CPS
      {
        path: 'usuarios',
        canActivate: [cpsGuard],
        loadComponent: () => import('./features/users/user-list').then((m) => m.UserList),
      },
      {
        path: 'usuarios/nuevo',
        canActivate: [cpsGuard],
        loadComponent: () => import('./features/users/user-form').then((m) => m.UserForm),
      },

      {
        path: 'perfil',
        loadComponent: () => import('./features/profile/profile').then((m) => m.Profile),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
