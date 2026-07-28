import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { Remote, RemoteCode } from '../models/api.models';

/**
 * Sin homeId el control nace en INVENTARIO (solo CPS; organizationId opcional
 * para cargarlo directo al stock de una org). Con homeId, alta directa en la
 * vivienda — falla si el barrio no tiene controles habilitados (cupo).
 */
export interface CreateRemote {
  name: string;
  homeId?: number;
  organizationId?: number;
  assignedToUserId?: number;
  deviceId?: number;
}

@Injectable({ providedIn: 'root' })
export class RemotesService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  list(homeId?: number): Observable<Remote[]> {
    return this.http.get<Remote[]>(`${this.api}/remotes`, {
      params: homeId ? { homeId } : {},
    });
  }

  /** CPS: todo el stock; organización: SU stock. */
  inventory(): Observable<Remote[]> {
    return this.http.get<Remote[]>(`${this.api}/remotes/inventory`);
  }

  create(remote: CreateRemote): Observable<Remote> {
    return this.http.post<Remote>(`${this.api}/remotes`, remote);
  }

  /** Entrega física: control del stock → una vivienda. El dueño ya no cambia. */
  assign(id: number, homeId: number): Observable<Remote> {
    return this.http.post<Remote>(`${this.api}/remotes/${id}/assign`, { homeId });
  }

  /**
   * Reasigna el PORTADOR (null = queda en la casa sin portador). Debe ser
   * MIEMBRO del hogar: si no, 400.
   */
  reassign(id: number, assignedToUserId: number | null): Observable<Remote> {
    return this.http.patch<Remote>(`${this.api}/remotes/${id}`, { assignedToUserId });
  }

  /** Devuelve posición (1..4) y fecha. NUNCA el código. */
  codes(remoteId: number): Observable<RemoteCode[]> {
    return this.http.get<RemoteCode[]>(`${this.api}/remotes/${remoteId}/codes`);
  }

  /** Solo CPS. El código viaja en claro SOLO acá: se cifra antes de guardarse. */
  addCode(remoteId: number, code: string, position: number): Observable<RemoteCode> {
    return this.http.post<RemoteCode>(`${this.api}/remotes/${remoteId}/codes`, {
      code,
      position,
    });
  }

  /**
   * El único endpoint que descifra un código RF. Solo CPS. Se pide de a uno,
   * se muestra y se descarta: no se cachea ni se guarda en estado global.
   * Cada llamada queda en audit_log.
   */
  reveal(remoteId: number, codeId: number): Observable<{ position: number; code: string }> {
    return this.http.get<{ position: number; code: string }>(
      `${this.api}/remotes/${remoteId}/codes/${codeId}/reveal`,
    );
  }
}
