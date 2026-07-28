import { Injectable } from '@angular/core';
import { Tokens } from './auth.models';

const ACCESS_KEY = 'cps.accessToken';
const REFRESH_KEY = 'cps.refreshToken';

/**
 * Único lugar que toca localStorage. El resto del código pide los tokens acá.
 *
 * El refresh ROTA: cada /auth/refresh revoca el token usado y devuelve uno nuevo.
 * Por eso `save()` siempre pisa los dos, nunca solo el access.
 */
@Injectable({ providedIn: 'root' })
export class TokenStorage {
  get accessToken(): string | null {
    return localStorage.getItem(ACCESS_KEY);
  }

  get refreshToken(): string | null {
    return localStorage.getItem(REFRESH_KEY);
  }

  save(tokens: Tokens): void {
    localStorage.setItem(ACCESS_KEY, tokens.accessToken);
    localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  }

  clear(): void {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  }
}
