import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { environment } from '../../../environments/environment';
import { UserRole } from '../auth/auth.models';
import { Account, Member, OrgSubtype, Paginated, StaffAssignment } from '../models/api.models';

export interface CreateAccount {
  name: string;
  type: 'ORGANIZATION';
  subtype: OrgSubtype;
  /** CUPOS = tarifa, obligatorios: no existe "sin límite". Después solo se tocan por /quotas. */
  maxNeighborhoods: number;
  maxMonitorUsers: number;
}

export interface UpdateAccountQuotas {
  /** Si vienen, tienen que ser >= 1 (no existe "sin límite"); ausente = no tocar. */
  maxNeighborhoods?: number;
  maxMonitorUsers?: number;
}

export interface OnboardCommunity {
  /** Nombre de la cuenta (la comunidad/consorcio) Y del usuario institucional OWNER. */
  name: string;
  maxMonitorUsers: number;
  ownerUsername: string;
  neighborhood: {
    name: string;
    localityId: number;
    latitude?: number;
    longitude?: number;
  };
}

export interface OnboardCommunityResult {
  account: Account;
  neighborhoodId: number;
  ownerId: number;
  ownerUsername: string;
  /** Se muestra UNA sola vez: no se puede volver a leer. */
  temporaryPassword: string;
}

@Injectable({ providedIn: 'root' })
export class AccountsService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  /**
   * Para COMBOS (contratos, entregas de stock): hasta 100, aplanado.
   * Para la pantalla de cuentas usá `page()`, que pagina de verdad.
   */
  list(): Observable<Account[]> {
    return this.http
      .get<Paginated<Account>>(`${this.api}/accounts`, { params: { limit: 100 } })
      .pipe(map((page) => page.items));
  }

  /** Cuentas paginadas (CPS ve todas; una organización, las suyas). */
  page(query: { limit?: number; offset?: number } = {}): Observable<Paginated<Account>> {
    const params: Record<string, string | number> = {};
    if (query.limit !== undefined) params['limit'] = query.limit;
    if (query.offset !== undefined) params['offset'] = query.offset;
    return this.http.get<Paginated<Account>>(`${this.api}/accounts`, { params });
  }

  get(id: number): Observable<Account> {
    return this.http.get<Account>(`${this.api}/accounts/${id}`);
  }

  /** COMPANY no se puede crear: es CPS y ya existe. Solo ORGANIZATION. */
  create(account: CreateAccount): Observable<Account> {
    return this.http.post<Account>(`${this.api}/accounts`, account);
  }

  /**
   * Alta atómica de una comunidad PRIVATE: cuenta + su único barrio + OWNER
   * institucional (clave temporal) + membresía, todo en una transacción — o
   * nada, si algo falla no queda una cuenta a medio crear. Para MUNICIPAL
   * seguí usando create() + UsersService.create() + addMember() por
   * separado: se autogestiona y no necesita el barrio en el mismo paso.
   */
  onboardCommunity(dto: OnboardCommunity): Observable<OnboardCommunityResult> {
    return this.http.post<OnboardCommunityResult>(`${this.api}/accounts/onboard-community`, dto);
  }

  /** SOLO CPS: los cupos son la tarifa. Queda auditado con viejo → nuevo. */
  updateQuotas(id: number, quotas: UpdateAccountQuotas): Observable<Account> {
    return this.http.patch<Account>(`${this.api}/accounts/${id}/quotas`, quotas);
  }

  members(accountId: number): Observable<Member[]> {
    return this.http.get<Member[]>(`${this.api}/accounts/${accountId}/members`);
  }

  /**
   * Crear un usuario NO le da acceso a nada: el acceso lo da la membresía.
   *
   * Errores esperables: 409 si la cuenta ya tiene OWNER, 400 si OWNER no es
   * institucional (o viceversa), 400 si MONITOR supera el cupo de la cuenta.
   */
  addMember(accountId: number, member: { userId: number; role: UserRole }): Observable<Member> {
    return this.http.post<Member>(`${this.api}/accounts/${accountId}/members`, member);
  }

  /** El rol OWNER no se asigna ni se quita por acá: es la soberanía. */
  updateMemberRole(accountId: number, userId: number, role: UserRole): Observable<Member> {
    return this.http.patch<Member>(`${this.api}/accounts/${accountId}/members/${userId}`, {
      role,
    });
  }

  /** Al OWNER no se lo puede sacar. */
  removeMember(accountId: number, userId: number): Observable<void> {
    return this.http.delete<void>(`${this.api}/accounts/${accountId}/members/${userId}`);
  }

  /**
   * Barrios asignados a un TECHNICIAN/MONITOR (staff_assignment).
   * SIN filas = ve todos los barrios de su organización.
   */
  assignments(accountId: number, userId: number): Observable<StaffAssignment[]> {
    return this.http.get<StaffAssignment[]>(
      `${this.api}/accounts/${accountId}/members/${userId}/assignments`,
    );
  }

  /** Reemplaza el conjunto completo; [] = vuelve a "toda la organización". */
  setAssignments(
    accountId: number,
    userId: number,
    neighborhoodIds: number[],
  ): Observable<StaffAssignment[]> {
    return this.http.put<StaffAssignment[]>(
      `${this.api}/accounts/${accountId}/members/${userId}/assignments`,
      { neighborhoodIds },
    );
  }
}
