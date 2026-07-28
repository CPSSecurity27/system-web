import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/auth.service';
import { AuditService } from '../common/audit.service';
import {
  AccountType,
  EntityStatus,
  ManagedBy,
  OrgSubtype,
  UserRole,
} from '../common/enums';
import { AccessScope, ScopeService } from '../common/scope.service';
import { Account } from '../accounts/entities/account.entity';
import { Locality } from '../geography/entities/locality.entity';
import {
  CreateNeighborhoodDto,
  TransferNeighborhoodDto,
  UpdateNeighborhoodDto,
  UpdateNeighborhoodQuotasDto,
} from './dto/neighborhood.dto';
import { Neighborhood } from './entities/neighborhood.entity';

/**
 * Barrios (v2): el molde único de las dos líneas de negocio.
 *
 * - CPS crea y edita barrios de cualquier organización.
 * - El OWNER/ADMIN de una organización MUNICIPAL crea/edita barrios PROPIOS
 *   (autogestión), hasta su cupo max_neighborhoods. Nacen operativos.
 * - Un consorcio PRIVATE NO gestiona su barrio: lo crea y administra CPS
 *   (nunca tiene más de uno, ver assertNeighborhoodRoomLeft).
 * - Los CUPOS del barrio (max_family_members, remote_controls_enabled) los
 *   toca SOLO CPS: son tarifa.
 * - TRANSFERIR una comunidad (privada -> municipal o viceversa) = cambiar
 *   organization_id y/o managed_by. SOLO CPS, siempre auditado. Hogares,
 *   vecinos, equipos e historial no se tocan: esa es la gracia del diseño.
 */
@Injectable()
export class NeighborhoodsService {
  constructor(
    @InjectRepository(Neighborhood)
    private readonly neighborhoods: Repository<Neighborhood>,
    @InjectRepository(Locality)
    private readonly localities: Repository<Locality>,
    @InjectRepository(Account)
    private readonly accounts: Repository<Account>,
    private readonly scopes: ScopeService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lista SOLO los barrios que el usuario alcanza. `localityId` filtra ENCIMA
   * del alcance, nunca en lugar de él.
   */
  findAll(scope: AccessScope, localityId?: number): Promise<Neighborhood[]> {
    const relations = { locality: { department: { province: true } } };

    if (scope.global) {
      return this.neighborhoods.find({
        where: localityId ? { localityId } : {},
        relations,
        order: { name: 'ASC' },
      });
    }

    if (scope.neighborhoodIds.length === 0) return Promise.resolve([]);

    return this.neighborhoods.find({
      where: {
        id: In(scope.neighborhoodIds),
        ...(localityId ? { localityId } : {}),
      },
      relations,
      order: { name: 'ASC' },
    });
  }

  async findOne(id: number, scope: AccessScope): Promise<Neighborhood> {
    const neighborhood = await this.neighborhoods.findOne({
      where: { id },
      relations: { locality: { department: { province: true } } },
    });
    if (!neighborhood) throw new NotFoundException(`No existe el barrio ${id}`);

    this.scopes.assertNeighborhood(scope, id);
    return neighborhood;
  }

  /**
   * Alta de barrio. Quién puede:
   *  - CPS: para cualquier organización (organizationId del DTO).
   *  - OWNER/ADMIN de una ORGANIZATION: solo para SU cuenta, y contra su cupo.
   */
  async create(
    dto: CreateNeighborhoodDto,
    actor: AuthenticatedUser,
  ): Promise<Neighborhood> {
    await this.assertLocalityExists(dto.localityId);

    const esCps = actor.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );

    let organizationId: number;
    if (esCps) {
      if (!dto.organizationId) {
        throw new BadRequestException(
          'CPS debe indicar la organización cliente del barrio (organizationId)',
        );
      }
      organizationId = dto.organizationId;
    } else {
      // El admin de una organización crea barrios de SU organización. Si vino
      // un organizationId ajeno, se rechaza — no hay forma de crear en otra.
      const propia = actor.memberships.find(
        (m) =>
          m.accountType === AccountType.ORGANIZATION &&
          (m.role === UserRole.OWNER || m.role === UserRole.ADMIN) &&
          (dto.organizationId === undefined ||
            dto.organizationId === m.accountId),
      );
      if (!propia) {
        throw new ForbiddenException(
          'Solo podés crear barrios de tu propia organización',
        );
      }
      organizationId = propia.accountId;
    }

    const organization = await this.getOrganization(organizationId);

    // Un consorcio PRIVATE no gestiona su barrio: nace y vive administrado
    // por CPS (negocio-redisenado.md §2.2). El MUNICIPAL sí se autogestiona:
    // puede tener varios y necesita cargar los suyos.
    if (!esCps && organization.subtype === OrgSubtype.PRIVATE) {
      throw new ForbiddenException(
        'Un consorcio privado no gestiona su barrio: lo crea y administra CPS',
      );
    }

    // CUPO max_neighborhoods: se impone AL CREAR. NULL = sin límite.
    await this.assertNeighborhoodRoomLeft(organization);

    const neighborhood = await this.neighborhoods.save(
      this.neighborhoods.create({
        name: dto.name,
        localityId: dto.localityId,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        status: EntityStatus.ACTIVE,
        organizationId: organization.id,
        organizationType: AccountType.ORGANIZATION,
        // El default de gestión sale del subtipo: municipal se autogestiona,
        // privado lo opera CPS. CPS puede pisarlo explícitamente.
        managedBy:
          dto.managedBy ??
          (organization.subtype === OrgSubtype.MUNICIPAL
            ? ManagedBy.ORGANIZATION
            : ManagedBy.CPS),
        createdBy: actor.id,
      }),
    );

    await this.audit.record({
      actorUserId: actor.id,
      action: 'neighborhood.create',
      entityType: 'neighborhood',
      entityId: neighborhood.id,
      accountId: organization.id,
      neighborhoodId: neighborhood.id,
      newValue: { name: dto.name, managedBy: neighborhood.managedBy },
    });

    return this.findOne(neighborhood.id, {
      global: true,
      neighborhoodIds: [],
      homeIds: [],
    });
  }

  async update(
    id: number,
    dto: UpdateNeighborhoodDto,
    scope: AccessScope,
    actor: AuthenticatedUser,
  ): Promise<Neighborhood> {
    const neighborhood = await this.findOne(id, scope);

    // Mismo criterio que create(): un consorcio PRIVATE no toca su barrio, lo
    // administra CPS. El MUNICIPAL sí puede actualizar el suyo.
    const esCps = actor.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );
    if (!esCps) {
      const organization = await this.getOrganization(
        neighborhood.organizationId,
      );
      if (organization.subtype === OrgSubtype.PRIVATE) {
        throw new ForbiddenException(
          'Un consorcio privado no gestiona su barrio: lo administra CPS',
        );
      }
    }

    if (dto.localityId) await this.assertLocalityExists(dto.localityId);

    await this.neighborhoods.update(id, {
      name: dto.name ?? neighborhood.name,
      localityId: dto.localityId ?? neighborhood.localityId,
      latitude: dto.latitude ?? neighborhood.latitude,
      longitude: dto.longitude ?? neighborhood.longitude,
      status: dto.status ?? neighborhood.status,
      updatedBy: actor.id,
    });

    return this.findOne(id, scope);
  }

  /**
   * CUPOS del barrio = tarifa. SOLO CPS (controller), siempre con auditoría
   * valor viejo -> nuevo. Reducir no destruye nada (grandfathering).
   */
  async updateQuotas(
    id: number,
    dto: UpdateNeighborhoodQuotasDto,
    actor: AuthenticatedUser,
  ): Promise<Neighborhood> {
    const neighborhood = await this.neighborhoods.findOne({ where: { id } });
    if (!neighborhood) throw new NotFoundException(`No existe el barrio ${id}`);

    const oldValue = {
      maxFamilyMembers: neighborhood.maxFamilyMembers,
      remoteControlsEnabled: neighborhood.remoteControlsEnabled,
    };

    await this.neighborhoods.update(id, {
      maxFamilyMembers: dto.maxFamilyMembers ?? neighborhood.maxFamilyMembers,
      remoteControlsEnabled:
        dto.remoteControlsEnabled ?? neighborhood.remoteControlsEnabled,
      updatedBy: actor.id,
    });

    const updated = await this.neighborhoods.findOneOrFail({ where: { id } });

    await this.audit.record({
      actorUserId: actor.id,
      action: 'quota.update',
      entityType: 'neighborhood',
      entityId: id,
      accountId: neighborhood.organizationId,
      neighborhoodId: id,
      oldValue,
      newValue: {
        maxFamilyMembers: updated.maxFamilyMembers,
        remoteControlsEnabled: updated.remoteControlsEnabled,
      },
    });

    return updated;
  }

  /**
   * TRANSFERENCIA de comunidad (privada -> municipal o viceversa). SOLO CPS.
   * Cambia el cliente y/o el gestor; hogares, vecinos, equipos, controles e
   * historial quedan intactos. La operación de negocio más sensible: auditada
   * siempre, con antes y después.
   */
  async transfer(
    id: number,
    dto: TransferNeighborhoodDto,
    actor: AuthenticatedUser,
  ): Promise<Neighborhood> {
    const neighborhood = await this.neighborhoods.findOne({ where: { id } });
    if (!neighborhood) throw new NotFoundException(`No existe el barrio ${id}`);

    const target = await this.getOrganization(dto.organizationId);

    // El barrio entra al cupo de la organización destino.
    if (target.id !== neighborhood.organizationId) {
      await this.assertNeighborhoodRoomLeft(target);
    }

    const oldValue = {
      organizationId: neighborhood.organizationId,
      managedBy: neighborhood.managedBy,
    };

    await this.neighborhoods.update(id, {
      organizationId: target.id,
      managedBy:
        dto.managedBy ??
        (target.subtype === OrgSubtype.MUNICIPAL
          ? ManagedBy.ORGANIZATION
          : ManagedBy.CPS),
      updatedBy: actor.id,
    });

    const updated = await this.neighborhoods.findOneOrFail({ where: { id } });

    await this.audit.record({
      actorUserId: actor.id,
      action: 'neighborhood.transfer',
      entityType: 'neighborhood',
      entityId: id,
      accountId: target.id,
      neighborhoodId: id,
      oldValue,
      newValue: {
        organizationId: updated.organizationId,
        managedBy: updated.managedBy,
      },
    });

    return updated;
  }

  // --- Invariantes ------------------------------------------------------------

  /** CUPO max_neighborhoods: al crear (o recibir por transferencia). */
  private async assertNeighborhoodRoomLeft(
    organization: Account,
  ): Promise<void> {
    if (organization.maxNeighborhoods === null) return;

    const existentes = await this.neighborhoods.count({
      where: { organizationId: organization.id },
    });

    if (existentes >= organization.maxNeighborhoods) {
      throw new BadRequestException(
        `El cupo contratado permite ${organization.maxNeighborhoods} barrio(s) ` +
          `y ya hay ${existentes}. Para ampliarlo, contactá a CPS.`,
      );
    }
  }

  private async getOrganization(id: number): Promise<Account> {
    const account = await this.accounts.findOne({ where: { id } });
    if (!account) throw new NotFoundException(`No existe la cuenta ${id}`);
    if (account.type !== AccountType.ORGANIZATION) {
      throw new BadRequestException(
        'La cuenta dueña de un barrio debe ser una ORGANIZATION (muni o consorcio)',
      );
    }
    return account;
  }

  private async assertLocalityExists(localityId: number): Promise<void> {
    const locality = await this.localities.findOne({
      where: { id: localityId },
    });
    if (!locality) {
      throw new NotFoundException(`No existe la localidad ${localityId}`);
    }
  }
}
