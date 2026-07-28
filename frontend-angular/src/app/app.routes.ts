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

      // Alarmas (son del barrio)
      {
        path: 'alarmas',
        loadComponent: () => import('./features/devices/device-list').then((m) => m.DeviceList),
      },
      {
        // Fábrica: solo CPS. Los equipos nacen en inventario con claim code.
        path: 'alarmas/nueva',
        canActivate: [cpsGuard],
        loadComponent: () => import('./features/devices/device-form').then((m) => m.DeviceForm),
      },
      {
        // Stock + instalación por claim: CPS y organizaciones.
        path: 'alarmas/stock',
        canActivate: [managerGuard],
        loadComponent: () =>
          import('./features/devices/device-inventory').then((m) => m.DeviceInventory),
      },
      {
        path: 'alarmas/:id',
        loadComponent: () => import('./features/devices/device-detail').then((m) => m.DeviceDetail),
      },

      // Controles remotos (son de la vivienda)
      {
        path: 'controles',
        loadComponent: () => import('./features/remotes/remote-list').then((m) => m.RemoteList),
      },
      {
        path: 'controles/nuevo',
        canActivate: [managerGuard],
        loadComponent: () => import('./features/remotes/remote-form').then((m) => m.RemoteForm),
      },

      // Cuentas y contratos
      {
        path: 'cuentas',
        canActivate: [cpsGuard],
        loadComponent: () => import('./features/accounts/account-list').then((m) => m.AccountList),
      },
      {
        path: 'cuentas/nueva',
        canActivate: [cpsGuard],
        loadComponent: () => import('./features/accounts/account-form').then((m) => m.AccountForm),
      },
      {
        path: 'cuentas/:id',
        loadComponent: () =>
          import('./features/accounts/account-members').then((m) => m.AccountMembers),
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
