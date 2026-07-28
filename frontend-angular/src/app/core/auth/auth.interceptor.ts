import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';

import { AuthService } from './auth.service';
import { TokenStorage } from './token-storage';

/**
 * Endpoints que NO llevan access token y cuyo 401 NO dispara un refresh.
 * Un 401 de /auth/login es "clave incorrecta", no "el token venció": refrescar
 * ahí sería absurdo, y hacerlo en /auth/refresh sería un loop infinito.
 */
const AUTH_FREE_PATHS = [
  '/auth/login',
  '/auth/refresh',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/verify-email',
];

/**
 * El backend nunca refresca solo: lo hace el cliente reaccionando al 401.
 *
 *   1. GET /homes          -> 401 (el access venció)
 *   2. POST /auth/refresh  -> access nuevo + refresh nuevo (el viejo queda revocado)
 *   3. se reintenta el request original -> 200
 *
 * El refresh compartido vive en AuthService.refreshTokens(): N requests que
 * fallen a la vez esperan UNA sola llamada, no N.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const storage = inject(TokenStorage);
  const auth = inject(AuthService);

  const isAuthFree = AUTH_FREE_PATHS.some((path) => req.url.includes(path));

  const withToken = (request: HttpRequest<unknown>, token: string | null) =>
    token && !isAuthFree
      ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : request;

  return next(withToken(req, storage.accessToken)).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status !== 401 || isAuthFree) {
        return throwError(() => error);
      }

      return auth.refreshTokens().pipe(
        // Se reintenta UNA vez, con el token nuevo. Si este segundo intento
        // vuelve a dar 401, el error sale para afuera: no vuelve a pasar por
        // este catchError, así que no hay loop.
        switchMap((tokens) => next(withToken(req, tokens.accessToken))),
      );
    }),
  );
};
