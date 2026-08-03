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
  JurisdictionLevel,
  ManagedBy,
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
 * - El OWNER/ADMIN de una organización crea/edita sus barrios PROPIOS, hasta
 *   su cupo max_neighborhoods. Nacen operativos.
 * - Lo que decide si el cliente puede editar un barrio es `managed_by`, NO el
 *   subtipo de la cuenta (2026-07-30). Un barrio `managed_by = CPS` está
 *   vendido llave en mano: su dueño lo ve pero no lo toca. Antes esto se
 *   decidía por `subtype === PRIVATE`, lo que hacía imposibles los dos casos
 *   que el negocio necesita — la comunitaria autogestionada y la municipal
 *   que terceriza un barrio.
 * - Alta: la COMMUNITY tiene UN barrio (cupo 1, invariante) y lo crea CPS en
 *   el onboarding atómico. Que después lo opere ella o CPS es la modalidad
 *   que se elige al venderlo.
 * - Los CUPOS del barrio (max_family_members, remote_controls_enabled) los
 *   toca SOLO CPS: son tarifa.
 * - TRANSFERIR una comunidad (comunitaria -> municipal o viceversa) = cambiar
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

    // Ya no hay puerta por subtipo acá: la COMMUNITY tiene cupo 1 y su barrio
    // nace en el onboarding atómico, así que si su admin intenta crear otro
    // el CUPO lo frena solo, con un mensaje que explica el motivo real. Un
    // segundo chequeo por subtipo sería la misma regla dicha dos veces, y el
    // día que difieran gana la que nadie recuerda que existe.
    await this.assertNeighborhoodRoomLeft(organization);
    await this.assertDentroDeJurisdiccion(organization, dto.localityId);

    const neighborhood = await this.neighborhoods.save(
      this.neighborhoods.create({
        name: dto.name,
        localityId: dto.localityId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        status: EntityStatus.ACTIVE,
        organizationId: organization.id,
        organizationType: AccountType.ORGANIZATION,
        // Default: lo opera su dueño. "Llave en mano" (managed_by = CPS) es
        // una decisión comercial explícita y por eso se pide explícita: si
        // fuera el default silencioso de algún subtipo, un cliente terminaría
        // sin poder tocar su propio barrio sin que nadie lo haya decidido.
        managedBy: dto.managedBy ?? ManagedBy.ORGANIZATION,
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
      accountIds: [],
    });
  }

  async update(
    id: number,
    dto: UpdateNeighborhoodDto,
    scope: AccessScope,
    actor: AuthenticatedUser,
  ): Promise<Neighborhood> {
    const neighborhood = await this.findOne(id, scope);

    // Ver no alcanza para editar: un barrio vendido llave en mano lo opera
    // CPS. Una sola llamada resuelve las dos cosas (alcance y modalidad) y
    // vale igual para la comunitaria y para la municipal que terceriza.
    await this.scopes.assertManagesNeighborhood(scope, id);

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
      communityScopeEnabled: neighborhood.communityScopeEnabled,
    };

    await this.neighborhoods.update(id, {
      maxFamilyMembers: dto.maxFamilyMembers ?? neighborhood.maxFamilyMembers,
      remoteControlsEnabled:
        dto.remoteControlsEnabled ?? neighborhood.remoteControlsEnabled,
      communityScopeEnabled:
        dto.communityScopeEnabled ?? neighborhood.communityScopeEnabled,
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
        communityScopeEnabled: updated.communityScopeEnabled,
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
      // Se PRESERVA salvo que CPS diga otra cosa. Cambiar de cliente y de
      // operador son dos decisiones separadas: derivar la segunda de la
      // primera haría que un traspaso administrativo le saque (o le dé) la
      // operación a alguien sin que nadie lo haya pedido.
      managedBy: dto.managedBy ?? neighborhood.managedBy,
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

  /**
   * El barrio tiene que caer DENTRO de la jurisdicción de su cuenta.
   *
   * El sistema se vende a nivel localidad o a nivel departamento, y el límite
   * es distinto para cada cliente:
   *   LOCALITY   -> el barrio va en ESA localidad. San Pedro no puede crear en
   *                 Rosario de Río Grande (ex Barro Negro): mismo departamento,
   *                 otro municipio.
   *   DEPARTMENT -> el barrio va en cualquier localidad de ESE departamento,
   *                 pero no en otro (Ledesma queda afuera).
   *
   * Vale para TODOS, CPS incluida: la regla es del cliente, no de quien carga.
   * Y vive acá y no en la base porque cruza account -> locality -> department.
   */
  private async assertDentroDeJurisdiccion(
    organization: Account,
    localityId: number,
  ): Promise<void> {
    const locality = await this.localities.findOne({
      where: { id: localityId },
      relations: { department: true },
    });
    if (!locality) {
      throw new NotFoundException(`No existe la localidad ${localityId}`);
    }

    if (organization.jurisdictionLevel === JurisdictionLevel.LOCALITY) {
      if (locality.id !== organization.localityId) {
        throw new BadRequestException(
          `El cliente opera en una sola localidad y "${locality.name}" no es esa. ` +
            'Si el territorio del cliente cambió, CPS ajusta su jurisdicción.',
        );
      }
      return;
    }

    if (organization.jurisdictionLevel === JurisdictionLevel.DEPARTMENT) {
      if (locality.departmentId !== organization.departmentId) {
        throw new BadRequestException(
          `"${locality.name}" está fuera del departamento del cliente. ` +
            'Si el territorio del cliente cambió, CPS ajusta su jurisdicción.',
        );
      }
      return;
    }

    // Una ORGANIZATION sin jurisdicción no debería existir (lo impide el CHECK
    // chk_account_jurisdiction). Si aparece, es un dato corrupto: mejor frenar
    // que dejar crear barrios en cualquier lado.
    throw new BadRequestException(
      'El cliente no tiene jurisdicción definida: no se puede validar dónde va el barrio',
    );
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
