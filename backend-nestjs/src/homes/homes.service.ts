import {
  BadRequestException,
  ConflictException,
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
  HomeMemberRole,
  UserKind,
} from '../common/enums';
import { AccessScope, ScopeService } from '../common/scope.service';
import { Device } from '../devices/entities/device.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import { User } from '../users/entities/user.entity';
import {
  AddHomeMemberDto,
  CreateHomeDto,
  TransferHomeTitularDto,
  UpdateHomeDto,
} from './dto/home.dto';
import { HomeMember } from './entities/home-member.entity';
import { Home } from './entities/home.entity';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Viviendas y sus miembros (v2).
 *
 * El titular ya NO es "el ADMIN de una cuenta HOME": es la fila TITULAR de
 * home_member. Su permiso sobre la vivienda se resuelve acá, no en el guard.
 *
 * Cupo de familiares: neighborhood.max_family_members, impuesto AL CREAR.
 * Si CPS lo bajó por debajo de lo existente: grandfathering — nadie se
 * suspende, solo se bloquean altas nuevas.
 *
 * Quién gestiona una vivienda depende de `neighborhood.managed_by`: en un
 * barrio vendido llave en mano el personal de la organización dueña lo VE
 * pero las viviendas y los vecinos los carga CPS. El titular queda al margen
 * de esa distinción — su casa la administra él, la opere quien la opere.
 */
@Injectable()
export class HomesService {
  constructor(
    @InjectRepository(Home) private readonly homes: Repository<Home>,
    @InjectRepository(HomeMember)
    private readonly members: Repository<HomeMember>,
    @InjectRepository(Neighborhood)
    private readonly neighborhoods: Repository<Neighborhood>,
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly scopes: ScopeService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Viviendas visibles: las del barrio que gestionás, o la tuya si sos vecino.
   * Un titular NO ve las casas de sus vecinos.
   */
  async findAll(scope: AccessScope, neighborhoodId?: number): Promise<Home[]> {
    if (scope.global) {
      return this.homes.find({
        where: neighborhoodId ? { neighborhoodId } : {},
        order: { name: 'ASC' },
      });
    }

    const porBarrio = scope.neighborhoodIds.length
      ? await this.homes.find({
          where: { neighborhoodId: In(scope.neighborhoodIds) },
        })
      : [];
    const propias = scope.homeIds.length
      ? await this.homes.find({ where: { id: In(scope.homeIds) } })
      : [];

    const unicas = new Map<number, Home>();
    for (const home of [...porBarrio, ...propias]) unicas.set(home.id, home);

    return [...unicas.values()]
      .filter((h) => !neighborhoodId || h.neighborhoodId === neighborhoodId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async findOne(id: number, scope: AccessScope): Promise<Home> {
    const home = await this.homes.findOne({
      where: { id },
      relations: { neighborhood: true },
    });
    if (!home) throw new NotFoundException(`No existe la vivienda ${id}`);

    this.scopes.assertHome(scope, id, home.neighborhoodId);
    return home;
  }

  async create(
    dto: CreateHomeDto,
    scope: AccessScope,
    createdBy: number,
  ): Promise<Home> {
    await this.assertNeighborhoodExists(dto.neighborhoodId);
    // No podés meter una vivienda en un barrio que no gestionás — y "gestionar"
    // excluye los barrios vendidos llave en mano, que opera CPS.
    await this.scopes.assertManagesNeighborhood(scope, dto.neighborhoodId);

    if (dto.defaultDeviceId) {
      await this.assertDeviceInNeighborhood(
        dto.defaultDeviceId,
        dto.neighborhoodId,
      );
    }

    const home = await this.homes.save(
      this.homes.create({
        name: dto.name,
        address: dto.address ?? null,
        contactPhone: dto.contactPhone ?? null,
        neighborhoodId: dto.neighborhoodId,
        defaultDeviceId: dto.defaultDeviceId ?? null,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        status: EntityStatus.ACTIVE,
        createdBy,
      }),
    );

    return this.findOne(home.id, scope);
  }

  /**
   * Editar la vivienda: CPS, el gestor del barrio, o el TITULAR (solo la suya).
   * Un FAMILIAR no edita la casa: vive en ella.
   */
  async update(
    id: number,
    dto: UpdateHomeDto,
    actor: AuthenticatedUser,
  ): Promise<Home> {
    const scope = await this.scopes.forUser(actor);
    const home = await this.findOne(id, scope);
    await this.assertCanManageHome(scope, actor, home);

    if (dto.neighborhoodId && dto.neighborhoodId !== home.neighborhoodId) {
      await this.assertNeighborhoodExists(dto.neighborhoodId);
      // Mudar una casa a otro barrio exige GESTIONAR el barrio DESTINO también.
      await this.scopes.assertManagesNeighborhood(scope, dto.neighborhoodId);
    }

    const barrioFinal = dto.neighborhoodId ?? home.neighborhoodId;
    if (dto.defaultDeviceId) {
      await this.assertDeviceInNeighborhood(dto.defaultDeviceId, barrioFinal);
    }

    await this.homes.update(id, {
      name: dto.name ?? home.name,
      address: dto.address ?? home.address,
      contactPhone: dto.contactPhone ?? home.contactPhone,
      neighborhoodId: barrioFinal,
      defaultDeviceId:
        dto.defaultDeviceId !== undefined
          ? dto.defaultDeviceId
          : home.defaultDeviceId,
      latitude: dto.latitude ?? home.latitude,
      longitude: dto.longitude ?? home.longitude,
      status: dto.status ?? home.status,
      updatedBy: actor.id,
    });

    return this.findOne(id, scope);
  }

  // --- Miembros del hogar (el dominio del vecino) ----------------------------

  async findMembers(
    homeId: number,
    actor: AuthenticatedUser,
  ): Promise<HomeMember[]> {
    const scope = await this.scopes.forUser(actor);
    await this.findOne(homeId, scope); // valida el acceso

    return this.members.find({
      where: { homeId },
      relations: { user: true },
      order: { id: 'ASC' },
    });
  }

  /**
   * Alta de miembro. Quién puede:
   *  - CPS / gestor del barrio: titular y familiares.
   *  - El TITULAR del hogar: solo FAMILIARES de su casa (regla del PDF).
   *
   * Cupo: FAMILIAR ≤ neighborhood.max_family_members, impuesto AL CREAR.
   * La base garantiza: un TITULAR por hogar, titular de un solo hogar.
   */
  async addMember(
    homeId: number,
    dto: AddHomeMemberDto,
    actor: AuthenticatedUser,
  ): Promise<HomeMember> {
    const scope = await this.scopes.forUser(actor);
    const home = await this.findOne(homeId, scope);

    const esGestor = await this.esGestor(scope, actor, home);
    const esTitular = this.esTitularDe(actor, homeId);
    if (!esGestor && !esTitular) {
      throw new ForbiddenException(
        'No podés gestionar miembros de esta vivienda',
      );
    }
    if (!esGestor && dto.role === HomeMemberRole.TITULAR) {
      throw new ForbiddenException(
        'El titular lo asigna el gestor del barrio o CPS',
      );
    }

    const user = await this.users.findOne({ where: { id: dto.userId } });
    if (!user)
      throw new NotFoundException(`No existe el usuario ${dto.userId}`);
    if (user.kind === UserKind.INSTITUTIONAL) {
      throw new BadRequestException(
        'Un usuario institucional no puede ser miembro de un hogar',
      );
    }

    if (dto.role === HomeMemberRole.FAMILIAR) {
      await this.assertFamilyRoomLeft(home);
    }

    try {
      const member = await this.members.save(
        this.members.create({
          homeId,
          userId: dto.userId,
          role: dto.role,
          status: EntityStatus.ACTIVE,
          createdBy: actor.id,
        }),
      );

      await this.audit.record({
        actorUserId: actor.id,
        action: 'home_member.add',
        entityType: 'home_member',
        entityId: member.id,
        neighborhoodId: home.neighborhoodId,
        newValue: { homeId, userId: dto.userId, role: dto.role },
      });

      return member;
    } catch (error) {
      // uq_home_single_titular / uq_user_single_titular / uq_home_member.
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Esa persona ya es miembro, o el hogar ya tiene titular, o la persona ya es titular de otro hogar',
        );
      }
      throw error;
    }
  }

  async suspendMember(
    homeId: number,
    userId: number,
    status: EntityStatus,
    actor: AuthenticatedUser,
  ): Promise<HomeMember> {
    const scope = await this.scopes.forUser(actor);
    const home = await this.findOne(homeId, scope);

    const esGestor = await this.esGestor(scope, actor, home);
    if (!esGestor && !this.esTitularDe(actor, homeId)) {
      throw new ForbiddenException(
        'No podés gestionar miembros de esta vivienda',
      );
    }

    const member = await this.getMember(homeId, userId);
    if (
      member.role === HomeMemberRole.TITULAR &&
      status !== EntityStatus.ACTIVE
    ) {
      // Suspender al titular es una decisión del gestor, no del propio hogar.
      if (!esGestor) {
        throw new ForbiddenException(
          'Solo el gestor del barrio puede suspender al titular',
        );
      }
    }

    const oldStatus = member.status;
    await this.members.update(member.id, { status });

    await this.audit.record({
      actorUserId: actor.id,
      action: 'home_member.status_change',
      entityType: 'home_member',
      entityId: member.id,
      neighborhoodId: home.neighborhoodId,
      oldValue: { status: oldStatus },
      newValue: { status },
    });

    return this.getMember(homeId, userId);
  }

  async removeMember(
    homeId: number,
    userId: number,
    actor: AuthenticatedUser,
  ): Promise<void> {
    const scope = await this.scopes.forUser(actor);
    const home = await this.findOne(homeId, scope);

    if (
      !(await this.esGestor(scope, actor, home)) &&
      !this.esTitularDe(actor, homeId)
    ) {
      throw new ForbiddenException(
        'No podés gestionar miembros de esta vivienda',
      );
    }

    const member = await this.getMember(homeId, userId);

    // La titularidad no se borra: se TRANSFIERE (transferTitular, del gestor)
    // o se cierra el hogar. Borrar al titular dejaría un hogar acéfalo.
    if (member.role === HomeMemberRole.TITULAR) {
      throw new BadRequestException(
        'El titular no se elimina: transferí la titularidad o cerrá el hogar',
      );
    }

    await this.members.delete(member.id);

    await this.audit.record({
      actorUserId: actor.id,
      action: 'home_member.remove',
      entityType: 'home_member',
      entityId: member.id,
      neighborhoodId: home.neighborhoodId,
      oldValue: { homeId, userId, role: member.role },
    });
  }

  /**
   * Transferencia de titularidad: el miembro elegido pasa a TITULAR y el
   * saliente queda como FAMILIAR (para borrarlo está el DELETE de siempre).
   * Es una decisión del GESTOR, no del hogar: cambia quién manda en la casa.
   *
   * El swap no crea miembros, así que nunca consume cupo. Si el hogar quedó
   * sin titular (dato viejo), promueve al elegido sin más.
   */
  async transferTitular(
    homeId: number,
    dto: TransferHomeTitularDto,
    actor: AuthenticatedUser,
  ): Promise<HomeMember[]> {
    const scope = await this.scopes.forUser(actor);
    const home = await this.findOne(homeId, scope);

    if (!(await this.esGestor(scope, actor, home))) {
      throw new ForbiddenException(
        'La titularidad la transfiere el gestor del barrio o CPS',
      );
    }

    const nuevo = await this.getMember(homeId, dto.newTitularUserId);
    if (nuevo.role === HomeMemberRole.TITULAR) {
      throw new BadRequestException('Esa persona ya es el titular del hogar');
    }
    if (nuevo.status !== EntityStatus.ACTIVE) {
      throw new BadRequestException(
        'Un miembro suspendido no puede recibir la titularidad',
      );
    }

    const saliente = await this.members.findOne({
      where: { homeId, role: HomeMemberRole.TITULAR },
    });

    try {
      // Atómico: un hogar nunca queda con dos titulares ni acéfalo a medias.
      await this.members.manager.transaction(async (manager) => {
        if (saliente) {
          await manager.update(HomeMember, saliente.id, {
            role: HomeMemberRole.FAMILIAR,
          });
        }
        await manager.update(HomeMember, nuevo.id, {
          role: HomeMemberRole.TITULAR,
        });
      });
    } catch (error) {
      // uq_user_single_titular: ya es titular de OTRO hogar.
      if (isUniqueViolation(error)) {
        throw new ConflictException('Esa persona ya es titular de otro hogar');
      }
      throw error;
    }

    await this.audit.record({
      actorUserId: actor.id,
      action: 'home_member.titular_transfer',
      entityType: 'home',
      entityId: homeId,
      neighborhoodId: home.neighborhoodId,
      oldValue: { titularUserId: saliente?.userId ?? null },
      newValue: { titularUserId: nuevo.userId },
    });

    return this.members.find({
      where: { homeId },
      relations: { user: true },
      order: { id: 'ASC' },
    });
  }

  // --- Invariantes y helpers --------------------------------------------------

  /**
   * CUPO del barrio (§5.2): FAMILIAR ≤ max_family_members, impuesto al crear.
   * El cupo vive en el barrio (viaja con la comunidad); solo CPS lo cambia.
   */
  private async assertFamilyRoomLeft(home: Home): Promise<void> {
    const barrio =
      home.neighborhood ??
      (await this.neighborhoods.findOneOrFail({
        where: { id: home.neighborhoodId },
      }));

    const familiares = await this.members.count({
      where: { homeId: home.id, role: HomeMemberRole.FAMILIAR },
    });

    if (familiares >= barrio.maxFamilyMembers) {
      throw new BadRequestException(
        `El barrio permite ${barrio.maxFamilyMembers} familiar(es) por hogar y ya hay ${familiares}. ` +
          'Para ampliar el cupo, contactá a CPS.',
      );
    }
  }

  /**
   * CPS o gestor del barrio de esta vivienda.
   *
   * Desde 2026-07-30 mira `managed_by`: si el barrio está vendido llave en
   * mano, el personal de la organización dueña lo VE pero no gestiona sus
   * viviendas — las carga CPS. El TITULAR no pasa por acá y sigue
   * administrando a sus familiares como siempre: la restricción es sobre el
   * personal del panel, no sobre el vecino.
   */
  private async esGestor(
    scope: AccessScope,
    actor: AuthenticatedUser,
    home: Home,
  ): Promise<boolean> {
    if (scope.global) return true;
    const esPanel = actor.memberships.some(
      (m) =>
        m.accountType === AccountType.COMPANY ||
        m.accountType === AccountType.ORGANIZATION,
    );
    if (!esPanel) return false;

    return this.scopes.managesNeighborhood(scope, home.neighborhoodId);
  }

  private esTitularDe(actor: AuthenticatedUser, homeId: number): boolean {
    return actor.homeMemberships.some(
      (h) => h.homeId === homeId && h.role === HomeMemberRole.TITULAR,
    );
  }

  private async assertCanManageHome(
    scope: AccessScope,
    actor: AuthenticatedUser,
    home: Home,
  ): Promise<void> {
    if (await this.esGestor(scope, actor, home)) return;
    if (this.esTitularDe(actor, home.id)) return;
    throw new ForbiddenException('No podés editar esta vivienda');
  }

  private async getMember(homeId: number, userId: number): Promise<HomeMember> {
    const member = await this.members.findOne({
      where: { homeId, userId },
      relations: { user: true },
    });
    if (!member) {
      throw new NotFoundException(
        `El usuario ${userId} no es miembro de la vivienda ${homeId}`,
      );
    }
    return member;
  }

  /** La alarma preferida tiene que ser del mismo barrio: es preferencia local. */
  private async assertDeviceInNeighborhood(
    deviceId: number,
    neighborhoodId: number,
  ): Promise<void> {
    const device = await this.devices.findOne({ where: { id: deviceId } });
    if (!device)
      throw new NotFoundException(`No existe el dispositivo ${deviceId}`);
    if (device.neighborhoodId !== neighborhoodId) {
      throw new BadRequestException(
        'La alarma preferida debe ser del mismo barrio que la vivienda',
      );
    }
  }

  private async assertNeighborhoodExists(id: number): Promise<void> {
    const neighborhood = await this.neighborhoods.findOne({ where: { id } });
    if (!neighborhood) throw new NotFoundException(`No existe el barrio ${id}`);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
