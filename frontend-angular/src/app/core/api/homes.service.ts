import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { HomeMemberRole } from '../auth/auth.models';
import { EntityStatus, Home, HomeMember } from '../models/api.models';

/**
 * Una persona que vive en la casa. Nombre y DNI y nada más obligatorio: el
 * DNI es la identidad de login del vecino en la app.
 */
export interface Resident {
  name: string;
  dni: string;
  telephone?: string;
  birthDate?: string;
  email?: string;
}

/**
 * Alta de vivienda: UN SOLO ACTO que termina en una casa con titular. La
 * dirección identifica la vivienda y el GPS es obligatorio.
 */
export interface CreateHome {
  address: string;
  neighborhoodId: number;
  latitude: number;
  longitude: number;
  /** Teléfono DEL HOGAR (sobrevive a cambios de titular). */
  contactPhone?: string;
  /** Alarma preferida para eventos SINGLE. Del mismo barrio. */
  defaultDeviceId?: number;
  titular: Resident;
}

@Injectable({ providedIn: 'root' })
export class HomesService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  list(neighborhoodId?: number): Observable<Home[]> {
    return this.http.get<Home[]>(`${this.api}/homes`, {
      params: neighborhoodId ? { neighborhoodId } : {},
    });
  }

  get(id: number): Observable<Home> {
    return this.http.get<Home>(`${this.api}/homes/${id}`);
  }

  create(home: CreateHome): Observable<Home> {
    return this.http.post<Home>(`${this.api}/homes`, home);
  }

  // --- Miembros del hogar (el dominio del vecino, NUEVO en v2) --------------

  members(homeId: number): Observable<HomeMember[]> {
    return this.http.get<HomeMember[]>(`${this.api}/homes/${homeId}/members`);
  }

  /**
   * Alta de un familiar QUE NO EXISTE todavía: se crea la persona y la
   * membresía juntas. Es el caso normal — nadie carga un vecino "suelto" para
   * después vincularlo.
   *
   * FAMILIAR: hasta el cupo del barrio — el 400 de cupo trae el mensaje
   * comercial, se muestra tal cual. El 409 de DNI repetido dice en qué
   * vivienda está ya esa persona.
   */
  addPerson(homeId: number, person: Resident, role: HomeMemberRole): Observable<HomeMember> {
    return this.http.post<HomeMember>(`${this.api}/homes/${homeId}/members`, { person, role });
  }

  /** Alta de un miembro que YA está en el padrón. */
  addMember(homeId: number, userId: number, role: HomeMemberRole): Observable<HomeMember> {
    return this.http.post<HomeMember>(`${this.api}/homes/${homeId}/members`, { userId, role });
  }

  /** Suspender / reactivar sin perder el historial. */
  updateMemberStatus(homeId: number, userId: number, status: EntityStatus): Observable<HomeMember> {
    return this.http.patch<HomeMember>(`${this.api}/homes/${homeId}/members/${userId}`, {
      status,
    });
  }

  /** Al TITULAR no se lo borra: se transfiere (transferTitular). */
  removeMember(homeId: number, userId: number): Observable<void> {
    return this.http.delete<void>(`${this.api}/homes/${homeId}/members/${userId}`);
  }

  /**
   * Transferencia de titularidad (solo gestores): el miembro elegido pasa a
   * TITULAR y el saliente queda como FAMILIAR. Devuelve la lista actualizada.
   */
  transferTitular(homeId: number, newTitularUserId: number): Observable<HomeMember[]> {
    return this.http.post<HomeMember[]>(`${this.api}/homes/${homeId}/transfer-titular`, {
      newTitularUserId,
    });
  }
}
