import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { AuthService } from './auth.service';

/** Rutas que siguen accesibles con una clave temporal sin cambiar (ahí es donde se cambia). */
const ALLOWED_WITH_PENDING_PASSWORD = '/perfil';

/**
 * Protege las rutas privadas. Si hay refresh token guardado pero todavía no se
 * cargó el perfil (típico: F5 sobre una ruta interna), lo pide antes de entrar
 * — si no, la pantalla arrancaría sin saber qué permisos tiene el usuario.
 *
 * Si el usuario tiene una clave TEMPORAL sin cambiar (`mustChangePassword`),
 * lo manda a /perfil sea cual sea la ruta pedida. Esto es solo comodidad de
 * navegación: la protección real es del backend (MustChangePasswordGuard),
 * que rechaza todo lo demás aunque el front no redirija.
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const toLogin = () => router.createUrlTree(['/login'], { queryParams: { redirect: state.url } });
  const toChangePassword = () => router.createUrlTree([ALLOWED_WITH_PENDING_PASSWORD]);
  const pendingPasswordBlocks = () =>
    auth.mustChangePassword() && !state.url.startsWith(ALLOWED_WITH_PENDING_PASSWORD);

  if (!auth.hasSession()) {
    return toLogin();
  }

  if (auth.isAuthenticated()) {
    return pendingPasswordBlocks() ? toChangePassword() : true;
  }

  return auth.loadMe().pipe(
    map(() => (pendingPasswordBlocks() ? toChangePassword() : true)),
    catchError(() => of(toLogin())),
  );
};

/**
 * Rutas exclusivas de CPS (padrón de usuarios, alta de barrios/alarmas, códigos RF).
 *
 * Esto NO es la protección: el backend ya rechaza con 403 y el dato ajeno ni
 * siquiera sale del servidor. Es para que la UI no ofrezca puertas que dan a un
 * 403 — y para no navegar a una pantalla que va a fallar entera.
 */
export const cpsGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth.isCps() ? true : router.createUrlTree(['/']);
};

/**
 * Rutas de GESTIÓN (alta de barrios/viviendas, stock): CPS o el OWNER/ADMIN de
 * una organización. En v2 la organización se autogestiona, así que estas
 * pantallas ya no son exclusivas de CPS.
 */
export const managerGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth.isManager() ? true : router.createUrlTree(['/']);
};

/**
 * Alta de barrios: CPS o el OWNER/ADMIN de una organización MUNICIPAL.
 *
 * Una organización COMMUNITY gestiona un único barrio y ese barrio nace con
 * la cuenta (onboarding atómico), así que su cupo ya está consumido el día 1:
 * el formulario solo la llevaría a un 400 de cupo. El backend es el que
 * decide de verdad — esto es para no ofrecer una puerta que da a un error.
 */
export const neighborhoodManagerGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth.isManager() && !auth.isCommunityOrg() ? true : router.createUrlTree(['/']);
};

/** Para /login: si ya hay sesión, no tiene sentido volver a pedirla. */
export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth.hasSession() ? router.createUrlTree(['/']) : true;
};
