import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AccountType, UserRole } from '../auth/auth.models';
import {
  Account,
  JurisdictionLevel,
  ManagedBy,
  Member,
  OrgSubtype,
  Paginated,
  StaffAssignment,
} from '../models/api.models';

export interface CreateAccount {
  name: string;
  type: 'ORGANIZATION';
  subtype: OrgSubtype;
  /** El plan del que se COPIAN los cupos. Sin plan, hay que mandarlos todos. */
  planId?: number;
  /** CUPOS = tarifa. Con plan son opcionales (lo pisan); sin plan, obligatorios. */
  maxNeighborhoods?: number;
  /** Los de personal admiten 0 = "esta cuenta no tiene ese rol". */
  maxAdminUsers?: number;
  maxTechnicianUsers?: number;
  maxMonitorUsers?: number;
}

export interface UpdateAccountQuotas {
  /** Ausente = no tocar ese cupo. Barrios >= 1; los de personal admiten 0. */
  maxNeighborhoods?: number;
  maxAdminUsers?: number;
  maxTechnicianUsers?: number;
  maxMonitorUsers?: number;
}

export interface OnboardCommunity {
  /** Nombre de la cuenta (la comunidad/consorcio) Y del usuario institucional OWNER. */
  name: string;
  /**
   * La MODALIDAD DE VENTA del barrio, obligatoria:
   *   CPS          -> llave en mano (CPS carga viviendas, vecinos y equipos)
   *   ORGANIZATION -> autogestión (la comunidad opera su barrio)
   */
  managedBy: ManagedBy;
  planId?: number;
  /** Obligatorio: no existe un cliente sin contrato. */
  contract: OnboardContract;
  /** Opcional: si está, el OWNER puede recuperar su contraseña solo. */
  ownerEmail?: string;
  maxAdminUsers?: number;
  maxTechnicianUsers?: number;
  maxMonitorUsers?: number;
  ownerUsername: string;
  neighborhood: {
    name: string;
    localityId: number;
    latitude?: number;
    longitude?: number;
  };
}

/**
 * El contrato que se firma junto con el alta. Es de la CUENTA, y no lleva su
 * id porque la cuenta se está creando en el mismo acto.
 */
export interface OnboardContract {
  price: number;
  /** AAAA-MM-DD */
  startDate: string;
  /** OBLIGATORIA: el precio es por el período del contrato. */
  endDate: string;
  description?: string;
}

/**
 * Hasta dónde llega el cliente. Solo se manda en el alta MUNICIPAL: la
 * comunitaria la deriva de su único barrio.
 */
export interface Jurisdiction {
  level: JurisdictionLevel;
  /** Con nivel LOCALITY. */
  localityId?: number;
  /** Con nivel DEPARTMENT. */
  departmentId?: number;
  latitude?: number;
  longitude?: number;
}

export interface OnboardCommunityResult {
  account: Account;
  neighborhoodId: number;
  contractId: number;
  ownerId: number;
  ownerUsername: string;
  /** Se muestra UNA sola vez: no se puede volver a leer. */
  temporaryPassword: string;
}

/**
 * Alta atómica de una MUNICIPAL: cuenta + OWNER + membresía. Sin barrio y sin
 * contrato, a propósito — la muni carga sus barrios después, contra su cupo.
 */
export interface OnboardMunicipal {
  name: string;
  jurisdiction: Jurisdiction;
  contract: OnboardContract;
  planId?: number;
  maxNeighborhoods?: number;
  maxAdminUsers?: number;
  maxTechnicianUsers?: number;
  maxMonitorUsers?: number;
  ownerUsername: string;
  /** Opcional: si está, el OWNER puede recuperar su contraseña solo. */
  ownerEmail?: string;
}

export interface OnboardMunicipalResult {
  account: Account;
  contractId: number;
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
   * Para COMBOS de "¿de qué cliente?" (contratos, entregas de stock, dueño de
   * un barrio): hasta 100, aplanado. SIEMPRE filtrado a ORGANIZATION — CPS es
   * quien presta el servicio, no un cliente: no firma contratos, no es dueña
   * de barrios y no se entrega stock a sí misma. Ofrecerla en esos combos solo
   * daba a elegir una opción que el backend rechaza.
   */
  list(): Observable<Account[]> {
    return this.http
      .get<Paginated<Account>>(`${this.api}/accounts`, {
        params: { limit: 100, type: 'ORGANIZATION' },
      })
      .pipe(map((page) => page.items));
  }

  /**
   * Cuentas paginadas (CPS ve todas; una organización, las suyas).
   * `type` recorta por tipo: la pantalla de Clientes manda ORGANIZATION para
   * que CPS no aparezca ahí — su ficha vive en Mi Empresa.
   */
  page(
    query: { limit?: number; offset?: number; type?: AccountType } = {},
  ): Observable<Paginated<Account>> {
    const params: Record<string, string | number> = {};
    if (query.limit !== undefined) params['limit'] = query.limit;
    if (query.offset !== undefined) params['offset'] = query.offset;
    if (query.type !== undefined) params['type'] = query.type;
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
   * Alta atómica de una organización COMMUNITY: cuenta + su único barrio +
   * OWNER institucional (clave temporal) + membresía + CONTRATO, todo en una
   * transacción — o nada, si algo falla no queda una cuenta a medio crear.
   *
   * El contrato va acá porque la comunitaria nace con su barrio: hay contra
   * qué contratar. Es obligatorio.
   */
  onboardCommunity(dto: OnboardCommunity): Observable<OnboardCommunityResult> {
    return this.http.post<OnboardCommunityResult>(`${this.api}/accounts/onboard-community`, dto);
  }

  /**
   * Alta atómica de una MUNICIPAL: cuenta + OWNER + membresía en una sola
   * llamada. Antes eran tres encadenadas desde acá, y si fallaba la del OWNER
   * quedaba una cuenta que nadie podía administrar.
   *
   * No lleva contrato: la muni nace SIN barrios, así que no hay contra qué
   * firmarlo. Eso es un estado válido, no un alta a medias.
   */
  onboardMunicipal(dto: OnboardMunicipal): Observable<OnboardMunicipalResult> {
    return this.http.post<OnboardMunicipalResult>(`${this.api}/accounts/onboard-municipal`, dto);
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
