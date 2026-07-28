import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { ManagedBy } from '../models/api.models';
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
