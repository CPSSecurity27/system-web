import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AccountType, UserRole } from './enums';
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
