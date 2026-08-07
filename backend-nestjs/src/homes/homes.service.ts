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
import { UsersService } from '../users/users.service';
import {
  AddHomeMemberDto,
  CreateHomeDto,
  ResidentDto,
  TransferHomeTitularDto,
  UpdateHomeDto,
} from './dto/home.dto';
import { HomeMember } from './entities/home-member.entity';
import { Home } from './entities/home.entity';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Miembro + si el vecino ya ACTIVÓ su cuenta (fijó su contraseña). Es un
 * booleano derivado de `password_hash IS NOT NULL`, no una copia guardada tipo
 * el `credential_set` del modelo viejo: ese dato podía mentir.
 *
 * El gestor lo necesita para saber si el vecino ya entró a la app o hay que
 * ir a buscarlo.
 */
export interface HomeMemberView extends HomeMember {
  activated: boolean;
}

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
    private readonly usersService: UsersService,
    private readonly scopes: ScopeService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Viviendas visibles: las del barrio que gestionás, o la tuya si sos vecino.
   * Un titular NO ve las casas de sus vecinos.
   */
  /**
   * El listado trae la ALARMA PREFERIDA con su nombre, no solo el id.
   *
   * Es la que responde por esa casa: sin verla en la lista no hay forma de
   * detectar de un vistazo las viviendas que quedaron sin ninguna — y una casa
   * sin alarma preferida es una casa cuyos controles **no se cargan en ningún
   * panel**, o sea llaveros que no disparan nada. Pasa siempre que la vivienda
   * se creó antes de que el barrio tuviera alarmas.
   */
  private static readonly RELACIONES_LISTA = { defaultDevice: true } as const;

  async findAll(scope: AccessScope, neighborhoodId?: number): Promise<Home[]> {
    if (scope.global) {
      return this.homes.find({
        where: neighborhoodId ? { neighborhoodId } : {},
        relations: HomesService.RELACIONES_LISTA,
        order: { address: 'ASC' },
      });
    }

    const porBarrio = scope.neighborhoodIds.length
      ? await this.homes.find({
          where: { neighborhoodId: In(scope.neighborhoodIds) },
          relations: HomesService.RELACIONES_LISTA,
        })
      : [];
    const propias = scope.homeIds.length
      ? await this.homes.find({
          where: { id: In(scope.homeIds) },
          relations: HomesService.RELACIONES_LISTA,
        })
      : [];

    const unicas = new Map<number, Home>();
    for (const home of [...porBarrio, ...propias]) unicas.set(home.id, home);

    return [...unicas.values()]
      .filter((h) => !neighborhoodId || h.neighborhoodId === neighborhoodId)
      .sort((a, b) => a.address.localeCompare(b.address));
  }

  async findOne(id: number, scope: AccessScope): Promise<Home> {
    const home = await this.homes.findOne({
      where: { id },
      relations: { neighborhood: true, defaultDevice: true },
    });
    if (!home) throw new NotFoundException(`No existe la vivienda ${id}`);

    this.scopes.assertHome(scope, id, home.neighborhoodId);
    return home;
  }

  /**
   * Alta de vivienda: UN SOLO ACTO que termina en una casa con titular. Una
   * vivienda sin dueño no sirve para nada y nadie vuelve después a completarla,
   * así que el titular se crea acá mismo — usuario, casa y membresía en la
   * MISMA transacción: si algo falla no queda ni la casa ni la persona a medias.
   */
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

    // Antes de abrir la transacción: si el DNI ya está, el mensaje dice DÓNDE.
    // El gestor necesita distinguir un error de tipeo de alguien que se mudó.
    await this.assertDniDisponible(dto.titular.dni);

    const { home, titular } = await this.homes.manager.transaction(
      async (manager) => {
        const titular = await this.usersService.createResident(
          manager,
          dto.titular,
          createdBy,
        );

        const home = await manager.save(
          manager.create(Home, {
            address: dto.address,
            contactPhone: dto.contactPhone ?? null,
            neighborhoodId: dto.neighborhoodId,
            defaultDeviceId: dto.defaultDeviceId ?? null,
            latitude: dto.latitude,
            longitude: dto.longitude,
            status: EntityStatus.ACTIVE,
            createdBy,
          }),
        );

        await manager.save(
          manager.create(HomeMember, {
            homeId: home.id,
            userId: titular.id,
            role: HomeMemberRole.TITULAR,
            status: EntityStatus.ACTIVE,
            createdBy,
          }),
        );

        return { home, titular };
      },
    );

    // Fuera de la transacción a propósito: un mail no se puede deshacer.
    if (titular.email) await this.usersService.sendActivationMail(titular);

    await this.audit.record({
      actorUserId: createdBy,
      action: 'home.create',
      entityType: 'home',
      entityId: home.id,
      neighborhoodId: home.neighborhoodId,
      newValue: {
        address: home.address,
        titularUserId: titular.id,
        titularDni: titular.dni,
      },
    });

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

    /**
     * Mudar la casa de barrio SIN mandar alarma preferida le dejaba la del
     * barrio viejo, violando la invariante del esquema ("debe ser un device del
     * mismo barrio"). Se validaba solo la que venía en el patch.
     *
     * Ahora importa más que antes: el plan de sincronización de cada equipo sale
     * de las viviendas que lo eligieron, así que una casa mudada seguiría
     * mandándole sus controles a un poste de otro barrio.
     *
     * Se limpia, no se adivina: elegir la más cercana del barrio nuevo sería
     * decidir por el gestor algo que la pantalla ya le muestra en naranja.
     */
    const conservada = dto.defaultDeviceId ?? home.defaultDeviceId;
    let preferidaFinal = conservada;
    if (dto.defaultDeviceId === undefined && conservada !== null) {
      const sigueSirviendo = await this.devices.findOne({
        where: { id: conservada, neighborhoodId: barrioFinal },
        select: { id: true },
      });
      preferidaFinal = sigueSirviendo ? conservada : null;
    }

    await this.homes.update(id, {
      address: dto.address ?? home.address,
      contactPhone: dto.contactPhone ?? home.contactPhone,
      neighborhoodId: barrioFinal,
      defaultDeviceId: preferidaFinal,
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
  ): Promise<HomeMemberView[]> {
    const scope = await this.scopes.forUser(actor);
    await this.findOne(homeId, scope); // valida el acceso

    return this.listMembers(homeId);
  }

  /**
   * Los miembros con el flag de cuenta activada. `passwordHash` tiene
   * select:false, así que se pide explícito y NUNCA sale de acá: lo único que
   * viaja es el booleano.
   */
  private async listMembers(homeId: number): Promise<HomeMemberView[]> {
    const members = await this.members.find({
      where: { homeId },
      relations: { user: true },
      order: { id: 'ASC' },
    });
    if (!members.length) return [];

    const claves = await this.users.find({
      where: { id: In(members.map((m) => m.userId)) },
      select: { id: true, passwordHash: true },
    });
    const activados = new Set(
      claves.filter((u) => u.passwordHash).map((u) => u.id),
    );

    return members.map((member) =>
      Object.assign(member, { activated: activados.has(member.userId) }),
    );
  }

  /**
   * Alta de miembro. Quién puede:
   *  - CPS / gestor del barrio: titular y familiares.
   *  - El TITULAR del hogar: solo FAMILIARES de su casa (regla del PDF).
   *
   * Dos formas: `person` (la persona no existe todavía — el caso normal de un
   * familiar) o `userId` (ya está en el padrón). Con `person`, el usuario y la
   * membresía se escriben en una transacción.
   *
   * Cupo: FAMILIAR ≤ neighborhood.max_family_members, impuesto AL CREAR.
   * La base garantiza: un TITULAR por hogar, y una persona en UNA sola casa.
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

    // class-validator no expresa bien "exactamente uno de estos dos campos".
    if (Boolean(dto.person) === Boolean(dto.userId)) {
      throw new BadRequestException(
        'Mandá los datos de la persona (person) o el id de una existente (userId), no las dos cosas',
      );
    }

    // El cupo se mira ANTES de crear a nadie: si no entra, no se crea el
    // usuario para después tener que borrarlo.
    if (dto.role === HomeMemberRole.FAMILIAR) {
      await this.assertFamilyRoomLeft(home);
    }

    if (dto.person) {
      return this.addNewPerson(home, dto.person, dto.role, actor);
    }

    const user = await this.users.findOne({ where: { id: dto.userId } });
    if (!user)
      throw new NotFoundException(`No existe el usuario ${dto.userId}`);
    if (user.kind === UserKind.INSTITUTIONAL) {
      throw new BadRequestException(
        'Un usuario institucional no puede ser miembro de un hogar',
      );
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

      await this.auditMemberAdd(member, home, actor.id);
      return member;
    } catch (error) {
      // uq_home_single_titular / uq_home_member_one_home.
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Esa persona ya vive en una vivienda, o el hogar ya tiene titular',
        );
      }
      throw error;
    }
  }

  /** Persona nueva + membresía, juntas o nada. */
  private async addNewPerson(
    home: Home,
    person: ResidentDto,
    role: HomeMemberRole,
    actor: AuthenticatedUser,
  ): Promise<HomeMember> {
    await this.assertDniDisponible(person.dni);

    const { member, user } = await this.members.manager.transaction(
      async (manager) => {
        const user = await this.usersService.createResident(
          manager,
          person,
          actor.id,
        );
        const member = await manager.save(
          manager.create(HomeMember, {
            homeId: home.id,
            userId: user.id,
            role,
            status: EntityStatus.ACTIVE,
            createdBy: actor.id,
          }),
        );
        return { member, user };
      },
    );

    if (user.email) await this.usersService.sendActivationMail(user);
    await this.auditMemberAdd(member, home, actor.id);

    return member;
  }

  private async auditMemberAdd(
    member: HomeMember,
    home: Home,
    actorUserId: number,
  ): Promise<void> {
    await this.audit.record({
      actorUserId,
      action: 'home_member.add',
      entityType: 'home_member',
      entityId: member.id,
      neighborhoodId: home.neighborhoodId,
      newValue: {
        homeId: member.homeId,
        userId: member.userId,
        role: member.role,
      },
    });
  }

  /**
   * El DNI es único global, pero un 409 pelado no le sirve al gestor: necesita
   * saber si se equivocó tipeando o si la persona ya está cargada en otra casa
   * (se mudó, o alguien la cargó antes). Por eso el mensaje dice DÓNDE está.
   */
  private async assertDniDisponible(dni: string): Promise<void> {
    const existente = await this.users.findOne({ where: { dni } });
    if (!existente) return;

    const membresia = await this.members.findOne({
      where: { userId: existente.id },
      relations: { home: { neighborhood: true } },
    });

    if (membresia) {
      const rol =
        membresia.role === HomeMemberRole.TITULAR ? 'titular' : 'familiar';
      throw new ConflictException(
        `El DNI ${dni} (${existente.name}) ya es ${rol} de ${membresia.home.address}, ` +
          `barrio ${membresia.home.neighborhood.name}.`,
      );
    }

    throw new ConflictException(
      `Ya existe una persona con el DNI ${dni} (${existente.name}) fuera de toda vivienda.`,
    );
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
  ): Promise<HomeMemberView[]> {
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

    return this.listMembers(homeId);
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
