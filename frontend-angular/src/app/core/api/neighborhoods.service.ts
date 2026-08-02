import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { EntityStatus, ManagedBy } from '../models/api.models';
import { Neighborhood } from '../models/neighborhood';

export interface CreateNeighborhood {
  name: string;
  localityId: number;
  /**
   * La organización dueña. Obligatorio para CPS; el admin de una organización
   * lo omite (se usa la suya) y no puede indicar una ajena.
   */
  organizationId?: number;
  latitude?: number;
  longitude?: number;
}

export interface UpdateNeighborhoodQuotas {
  maxFamilyMembers?: number;
  remoteControlsEnabled?: boolean;
  communityScopeEnabled?: boolean;
}

/**
 * Datos del barrio (NO los cupos: esos van por su propio endpoint porque son
 * tarifa y solo los toca CPS).
 */
export interface UpdateNeighborhood {
  name?: string;
  localityId?: number;
  latitude?: number;
  longitude?: number;
  status?: EntityStatus;
}

@Injectable({ providedIn: 'root' })
export class NeighborhoodsService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  /**
   * Devuelve SOLO los barrios que el usuario alcanza. En v2 el alcance sale de
   * la ESTRUCTURA (organización dueña, asignaciones de personal, hogares del
   * vecino), no de contratos. El front no filtra nada.
   */
  list(): Observable<Neighborhood[]> {
    return this.http.get<Neighborhood[]>(`${this.api}/neighborhoods`);
  }

  get(id: number): Observable<Neighborhood> {
    return this.http.get<Neighborhood>(`${this.api}/neighborhoods/${id}`);
  }

  /**
   * CPS (cualquier organización) o el OWNER/ADMIN de una organización (la
   * suya, contra su cupo). El 400 de cupo trae el mensaje comercial: mostrarlo
   * tal cual.
   */
  create(neighborhood: CreateNeighborhood): Observable<Neighborhood> {
    return this.http.post<Neighborhood>(`${this.api}/neighborhoods`, neighborhood);
  }

  /**
   * Datos del barrio. Lo puede llamar CPS o el OWNER/ADMIN de la organización
   * dueña, pero SOLO si gestiona ese barrio: con `managedBy = 'CPS'` (vendido
   * llave en mano) el cliente lo VE y no lo toca — el backend responde 403.
   */
  update(id: number, changes: UpdateNeighborhood): Observable<Neighborhood> {
    return this.http.patch<Neighborhood>(`${this.api}/neighborhoods/${id}`, changes);
  }

  /** SOLO CPS: los cupos del barrio son la tarifa. */
  updateQuotas(id: number, quotas: UpdateNeighborhoodQuotas): Observable<Neighborhood> {
    return this.http.patch<Neighborhood>(`${this.api}/neighborhoods/${id}/quotas`, quotas);
  }

  /**
   * SOLO CPS. La operación más sensible del negocio: el barrio cambia de
   * cliente y/o de gestor; hogares, vecinos, equipos e historial intactos.
   */
  transfer(id: number, organizationId: number, managedBy?: ManagedBy): Observable<Neighborhood> {
    return this.http.post<Neighborhood>(`${this.api}/neighborhoods/${id}/transfer`, {
      organizationId,
      ...(managedBy ? { managedBy } : {}),
    });
  }
}
