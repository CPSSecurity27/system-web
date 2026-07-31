import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { OrgSubtype, Plan } from '../models/api.models';

export interface CreatePlan {
  /** MAYÚSCULAS, sin espacios. Es el identificador estable del plan. */
  code: string;
  name: string;
  description?: string;
  appliesTo: OrgSubtype;
  priceReference?: string;
  maxNeighborhoods: number;
  maxAdminUsers: number;
  maxTechnicianUsers: number;
  maxMonitorUsers: number;
  maxFamilyMembers: number;
  remoteControlsEnabled: boolean;
}

/** `code` y `appliesTo` no se editan: son la identidad del plan. */
export type UpdatePlan = Partial<Omit<CreatePlan, 'code' | 'appliesTo'>> & {
  /** false = discontinuado: no se vende más, los que lo tienen siguen igual. */
  active?: boolean;
};

/**
 * Planes: el catálogo comercial. TODO es solo-CPS, incluido el listado.
 *
 * Un plan es una PLANTILLA que se copia al vender: editarlo NO le cambia los
 * cupos a las cuentas que ya lo compraron. Para eso está
 * `AccountsService.updateQuotas()`, cuenta por cuenta y auditado.
 */
@Injectable({ providedIn: 'root' })
export class PlansService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  /** Sin filtro vienen todos, discontinuados incluidos (la pantalla los administra). */
  list(query: { active?: boolean; appliesTo?: OrgSubtype } = {}): Observable<Plan[]> {
    const params: Record<string, string | boolean> = {};
    if (query.active !== undefined) params['active'] = query.active;
    if (query.appliesTo !== undefined) params['appliesTo'] = query.appliesTo;
    return this.http.get<Plan[]>(`${this.api}/plans`, { params });
  }

  get(id: number): Observable<Plan> {
    return this.http.get<Plan>(`${this.api}/plans/${id}`);
  }

  /** Cuántos clientes se vendieron con este plan. */
  accountsCount(id: number): Observable<{ count: number }> {
    return this.http.get<{ count: number }>(`${this.api}/plans/${id}/accounts-count`);
  }

  create(plan: CreatePlan): Observable<Plan> {
    return this.http.post<Plan>(`${this.api}/plans`, plan);
  }

  update(id: number, plan: UpdatePlan): Observable<Plan> {
    return this.http.patch<Plan>(`${this.api}/plans/${id}`, plan);
  }
}
