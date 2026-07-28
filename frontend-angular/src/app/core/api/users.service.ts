import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { environment } from '../../../environments/environment';
import { Paginated, User, UserKind } from '../models/api.models';

/**
 * v2.1 — tres formas de identidad:
 *  - Usuario de panel: username + password.
 *  - OWNER institucional: username + password + kind INSTITUTIONAL (solo CPS).
 *  - Vecino: email (obligatorio, activa la cuenta por mail) + dni/teléfono
 *    opcionales, SIN password — lo fija el vecino al activar.
 */
export interface CreateUser {
  name: string;
  kind?: UserKind;
  username?: string;
  /** Institucional NO manda esto: el backend genera una clave temporal (ver create()). */
  password?: string;
  dni?: string;
  email?: string;
  telephone?: string;
}

/** Solo en la respuesta del alta institucional: no se puede volver a leer después. */
export interface CreatedUser extends User {
  temporaryPassword?: string;
}

@Injectable({ providedIn: 'root' })
export class UsersService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  /**
   * Para COMBOS (candidatos a miembro, etc.): trae hasta 100 y aplana.
   * Para el padrón como pantalla usá `page()`, que pagina de verdad.
   */
  list(search?: string): Observable<User[]> {
    return this.http
      .get<Paginated<User>>(`${this.api}/users`, {
        params: { limit: 100, ...(search ? { search } : {}) },
      })
      .pipe(map((page) => page.items));
  }

  /** El padrón paginado (solo CPS). `search` busca por nombre/usuario/DNI. */
  page(
    query: { search?: string; limit?: number; offset?: number } = {},
  ): Observable<Paginated<User>> {
    const params: Record<string, string | number> = {};
    if (query.search) params['search'] = query.search;
    if (query.limit !== undefined) params['limit'] = query.limit;
    if (query.offset !== undefined) params['offset'] = query.offset;
    return this.http.get<Paginated<User>>(`${this.api}/users`, { params });
  }

  create(user: CreateUser): Observable<CreatedUser> {
    return this.http.post<CreatedUser>(`${this.api}/users`, user);
  }
}
