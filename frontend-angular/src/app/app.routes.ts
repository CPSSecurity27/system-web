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
      {
        // Entrega del lote a una organización + instalación por reclamo. NO es
        // fábrica: acá sí importa el destino, y por eso no vive en Inventario.
        // Provisorio — cada mitad se va a mudar a donde pertenece: la entrega
        // al detalle de la cuenta, la instalación al detalle del barrio.
        path: 'alarmas/stock',
        canActivate: [managerGuard],
        loadComponent: () =>
          import('./features/devices/device-inventory').then((m) => m.DeviceInventory),
      },
      // Va ANTES de :id o el router se come "nueva" como si fuera un id.
      // Mismo motivo por el que 'barrios/nuevo' precede a ':id'.
      { path: 'alarmas/nueva', redirectTo: 'inventario/alarmas' },
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
      // INVENTARIO — la FÁBRICA: por dónde un equipo ENTRA al sistema.
      //
      // Acá NO se decide destino: ni a qué organización va ni en qué barrio se
      // instala. Eso pasa después y en otro lado (la entrega, desde la cuenta;
      // la instalación por reclamo, desde el barrio). Lo único que importa es
      // registrar la identidad física del equipo.
      //
      // Por eso es cpsGuard y no managerGuard: fabricar lo hace CPS y nadie
      // más. Una organización recibe equipos, no los produce.
      // ---------------------------------------------------------------------
      {
        path: 'inventario',
        canActivate: [cpsGuard],
        loadComponent: () =>
          import('./features/inventory/inventory-shell').then((m) => m.InventoryShell),
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'alarmas' },
          {
            // Alta desde MAC + n° de placa, y el registro de todo lo fabricado.
            // Alta y listado en la MISMA pantalla: la estación de flasheo carga
            // placas en tanda y navegar por equipo sería fricción pura.
            path: 'alarmas',
            loadComponent: () =>
              import('./features/devices/device-factory').then((m) => m.DeviceFactory),
          },
          { path: 'alarmas/fabricar', redirectTo: 'alarmas' },
          {
            // Provisorio: el único acto de fábrica que hoy existe para
            // controles es el alta. La pantalla propia —con su listado, al
            // molde de la de alarmas— es la fase siguiente.
            path: 'controles',
            loadComponent: () => import('./features/remotes/remote-form').then((m) => m.RemoteForm),
          },
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

      {
        path: 'contratos',
        loadComponent: () =>
          import('./features/contracts/contract-list').then((m) => m.ContractList),
      },
      {
        path: 'contratos/nuevo',
        canActivate: [cpsGuard],
        loadComponent: () =>
          import('./features/contracts/contract-form').then((m) => m.ContractForm),
      },

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
