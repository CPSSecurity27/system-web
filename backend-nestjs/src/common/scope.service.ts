import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AccountType, ManagedBy, UserRole } from './enums';
import type { AuthenticatedUser } from '../auth/auth.service';
import { StaffAssignment } from '../accounts/entities/staff-assignment.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';

/**
 * QUÉ puede ver cada usuario (v2).
 *
 * El alcance YA NO se deriva de contratos: el contrato dice si el servicio está
 * al día, no quién administra qué. Ahora se deriva de la ESTRUCTURA:
 *
 *   COMPANY (cualquier rol)     -> global (CPS presta el servicio a todos)
 *   ORGANIZATION OWNER/ADMIN    -> los barrios con organization_id = su cuenta
 *   ORGANIZATION TECH/MONITOR   -> ídem, acotado por staff_assignment si existe
 *                                  (sin filas = todos los barrios de su org)
 *   Vecino (home_member)        -> su(s) hogar(es) + el barrio como lectura de
 *                                  infraestructura compartida (alarmas)
 *
 * Un usuario con varias membresías acumula alcance: el técnico de CPS que
 * además es vecino ya es global por el lado de COMPANY.
 *
 * VER y GESTIONAR son dos preguntas distintas. Lo de arriba responde la
 * primera; para la segunda está `managesNeighborhood`, que además mira
 * `managed_by` — un barrio vendido llave en mano lo VE su organización dueña
 * pero lo OPERA CPS.
 */
export interface AccessScope {
  /** true = ve todo el sistema. Solo miembros de la cuenta COMPANY. */
  global: boolean;
  neighborhoodIds: number[];
  homeIds: number[];
}

@Injectable()
export class ScopeService {
  constructor(
    @InjectRepository(Neighborhood)
    private readonly neighborhoods: Repository<Neighborhood>,
    @InjectRepository(StaffAssignment)
    private readonly assignments: Repository<StaffAssignment>,
  ) {}

  async forUser(user: AuthenticatedUser): Promise<AccessScope> {
    const isCompany = user.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );
    if (isCompany) {
      return { global: true, neighborhoodIds: [], homeIds: [] };
    }

    const neighborhoodIds = new Set<number>();

    for (const membership of user.memberships) {
      if (membership.accountType !== AccountType.ORGANIZATION) continue;

      const isStaff =
        membership.role === UserRole.TECHNICIAN ||
        membership.role === UserRole.MONITOR;

      if (isStaff) {
        // Acotado por barrio si tiene asignaciones; sin filas = toda su org.
        const assigned = await this.assignments.find({
          where: { accountUserId: membership.membershipId },
          select: { neighborhoodId: true },
        });
        if (assigned.length > 0) {
          for (const a of assigned) neighborhoodIds.add(a.neighborhoodId);
          continue;
        }
      }

      const own = await this.neighborhoods.find({
        where: { organizationId: membership.accountId },
        select: { id: true },
      });
      for (const n of own) neighborhoodIds.add(n.id);
    }

    // El vecino: sus hogares vienen de home_member (cargados en el login).
    const homeIds = user.homeMemberships.map((h) => h.homeId);

    return {
      global: false,
      neighborhoodIds: [...neighborhoodIds],
      homeIds,
    };
  }

  /** Tira 403 si el usuario no alcanza ese barrio. */
  assertNeighborhood(scope: AccessScope, neighborhoodId: number): void {
    if (scope.global || scope.neighborhoodIds.includes(neighborhoodId)) return;
    // 403 y no 404: el recurso existe, simplemente no es tuyo.
    throw new ForbiddenException('No tenés acceso a este barrio');
  }

  /**
   * ¿Este usuario GESTIONA el barrio, o solamente lo VE?
   *
   * Son dos preguntas distintas y hasta 2026-07-30 el código solo hacía la
   * primera. Un barrio vendido llave en mano (`managed_by = CPS`) lo opera
   * CPS: la organización dueña lo ve entero — es su barrio, paga por él y
   * necesita ver sus eventos y su estado — pero no carga hogares, ni vecinos,
   * ni lo edita. Si pudiera, habría dos operadores pisándose sobre los mismos
   * datos y "llave en mano" sería mentira a medias.
   *
   * La pregunta se hace sobre el BARRIO y no sobre el subtipo de la cuenta a
   * propósito: así una municipal puede tercerizarle un barrio a CPS teniendo
   * los otros nueve propios, y una comunitaria puede autogestionarse el suyo.
   * Antes esto se decidía mirando `account.subtype === PRIVATE`, que ataba la
   * modalidad de operación a la clase de cliente y hacía imposibles los dos
   * casos.
   */
  async managesNeighborhood(
    scope: AccessScope,
    neighborhoodId: number,
  ): Promise<boolean> {
    // CPS gestiona cualquier barrio, sea de quien sea. Es quien presta el servicio.
    if (scope.global) return true;
    if (!scope.neighborhoodIds.includes(neighborhoodId)) return false;

    const neighborhood = await this.neighborhoods.findOne({
      where: { id: neighborhoodId },
      select: { id: true, managedBy: true },
    });
    if (!neighborhood) return false;

    return neighborhood.managedBy !== ManagedBy.CPS;
  }

  /** Tira 403 si el usuario ve el barrio pero no lo gestiona (o ni lo ve). */
  async assertManagesNeighborhood(
    scope: AccessScope,
    neighborhoodId: number,
  ): Promise<void> {
    // Primero el alcance, para no confundir "no es tuyo" con "no lo operás":
    // son dos 403 con causas distintas y el mensaje tiene que decir cuál es.
    this.assertNeighborhood(scope, neighborhoodId);

    if (await this.managesNeighborhood(scope, neighborhoodId)) return;

    throw new ForbiddenException(
      'Este barrio lo opera CPS: podés verlo, pero la gestión (viviendas, vecinos, datos del barrio) la hace CPS',
    );
  }

  /**
   * Tira 403 si el usuario no alcanza esa vivienda.
   *
   * `neighborhoodIdOfHome` permite que el gestor de un barrio vea las viviendas
   * de SU barrio, sin necesidad de una relación por vivienda.
   */
  assertHome(
    scope: AccessScope,
    homeId: number,
    neighborhoodIdOfHome: number,
  ): void {
    if (scope.global) return;
    if (scope.homeIds.includes(homeId)) return;
    if (scope.neighborhoodIds.includes(neighborhoodIdOfHome)) return;
    throw new ForbiddenException('No tenés acceso a esta vivienda');
  }

  /** Los barrios de las viviendas del usuario (para ver infraestructura compartida). */
  async neighborhoodsOfHomes(homeNeighborhoodIds: number[]): Promise<number[]> {
    if (homeNeighborhoodIds.length === 0) return [];
    const rows = await this.neighborhoods.find({
      where: { id: In(homeNeighborhoodIds) },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
