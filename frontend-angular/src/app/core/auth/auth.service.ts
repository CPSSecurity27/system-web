import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  Observable,
  catchError,
  finalize,
  of,
  shareReplay,
  switchMap,
  tap,
  throwError,
} from 'rxjs';

import { environment } from '../../../environments/environment';
import { LoginRequest, Me, Tokens } from './auth.models';
import { TokenStorage } from './token-storage';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly storage = inject(TokenStorage);
  private readonly api = environment.apiUrl;

  /** Perfil del usuario logueado. `null` mientras no se cargó o tras cerrar sesión. */
  readonly user = signal<Me | null>(null);
  readonly isAuthenticated = computed(() => this.user() !== null);

  /**
   * Permisos v2: SIEMPRE el par (accountType, role). El vecino ya no tiene
   * cuenta: se lo reconoce por `homeMemberships`, no por sus membresías.
   */
  readonly isCps = computed(() =>
    (this.user()?.memberships ?? []).some((m) => m.accountType === 'COMPANY'),
  );
  /** OWNER/ADMIN de una organización (municipio o comunidad): autogestión. */
  readonly isOrgManager = computed(() =>
    (this.user()?.memberships ?? []).some(
      (m) => m.accountType === 'ORGANIZATION' && (m.role === 'OWNER' || m.role === 'ADMIN'),
    ),
  );
  /** Gestor (CPS u organización): puede crear barrios, viviendas, vecinos. */
  readonly isManager = computed(() => this.isCps() || this.isOrgManager());
  readonly isMonitor = computed(() =>
    (this.user()?.memberships ?? []).some((m) => m.role === 'MONITOR'),
  );
  readonly isTechnician = computed(() =>
    (this.user()?.memberships ?? []).some((m) => m.role === 'TECHNICIAN'),
  );
  /** Organización comunitaria: gestiona UN solo barrio (el negocio lo fuerza). */
  readonly isCommunityOrg = computed(() =>
    (this.user()?.memberships ?? []).some(
      (m) => m.accountType === 'ORGANIZATION' && m.subtype === 'COMMUNITY',
    ),
  );
  /**
   * El id de la cuenta COMPANY (CPS), o null si el usuario no es de CPS.
   *
   * Existe para que la sección "Mi Empresa" pueda reusar las pantallas de
   * cuenta sin un `:id` en la URL: CPS es una sola (índice único en la base),
   * así que su id se deduce de la sesión en vez de andar paseándolo por rutas.
   */
  readonly companyAccountId = computed(
    () =>
      (this.user()?.memberships ?? []).find((m) => m.accountType === 'COMPANY')?.accountId ?? null,
  );
  /** Vecino: al menos una membresía de hogar. TITULAR administra la suya. */
  readonly isVecino = computed(() => (this.user()?.homeMemberships ?? []).length > 0);
  /** Clave TEMPORAL sin cambiar: el guard manda a /perfil pase lo que pase. */
  readonly mustChangePassword = computed(() => this.user()?.mustChangePassword ?? false);
  readonly isTitular = computed(() =>
    (this.user()?.homeMemberships ?? []).some((h) => h.role === 'TITULAR'),
  );
  /** Nombre a mostrar: el vecino no tiene username (entra por email/DNI). */
  readonly displayName = computed(() => {
    const me = this.user();
    return me?.name ?? me?.username ?? '';
  });

  /**
   * La ÚNICA promesa de refresh en vuelo. Si la pantalla dispara 5 requests en
   * paralelo y los 5 reciben 401, todos se cuelgan de este mismo observable.
   * Sin esto se lanzarían 5 refresh: el primero rota el token y los otros 4
   * fallan con el token ya quemado, deslogueando al usuario sin motivo.
   */
  private refreshInFlight: Observable<Tokens> | null = null;

  hasSession(): boolean {
    return this.storage.refreshToken !== null;
  }

  login(credentials: LoginRequest): Observable<Me> {
    return this.http.post<Tokens>(`${this.api}/auth/login`, credentials).pipe(
      tap((tokens) => this.storage.save(tokens)),
      switchMap(() => this.loadMe()),
    );
  }

  loadMe(): Observable<Me> {
    return this.http.get<Me>(`${this.api}/auth/me`).pipe(tap((me) => this.user.set(me)));
  }

  refreshTokens(): Observable<Tokens> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    const refreshToken = this.storage.refreshToken;
    if (!refreshToken) {
      this.forceLogout();
      return throwError(() => new Error('No hay refresh token guardado'));
    }

    this.refreshInFlight = this.http
      .post<Tokens>(`${this.api}/auth/refresh`, { refreshToken })
      .pipe(
        tap((tokens) => this.storage.save(tokens)),
        catchError((error) => {
          // El refresh venció o fue revocado (p. ej. cambió la contraseña).
          // No se reintenta: se limpia y se manda al login.
          this.forceLogout();
          return throwError(() => error);
        }),
        finalize(() => (this.refreshInFlight = null)),
        shareReplay({ bufferSize: 1, refCount: false }),
      );

    return this.refreshInFlight;
  }

  /** Cierra la sesión de ESTE dispositivo. El 4xx del backend no debe frenar la salida. */
  logout(): Observable<void> {
    const refreshToken = this.storage.refreshToken;
    const request = refreshToken
      ? this.http.post<void>(`${this.api}/auth/logout`, { refreshToken })
      : of(void 0);

    return request.pipe(
      catchError(() => of(void 0)),
      tap(() => this.forceLogout()),
    );
  }

  /** Cierra la sesión en TODOS los dispositivos. */
  logoutAll(): Observable<void> {
    return this.http.post<void>(`${this.api}/auth/logout-all`, {}).pipe(
      catchError(() => of(void 0)),
      tap(() => this.forceLogout()),
    );
  }

  /** Borra el estado local y manda al login. No llama al backend. */
  forceLogout(): void {
    this.storage.clear();
    this.user.set(null);
    this.refreshInFlight = null;
    void this.router.navigate(['/login']);
  }
}
