import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, In, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/auth.service';
import { PasswordService } from '../auth/password.service';
import { AuditService } from '../common/audit.service';
import {
  AccountType,
  EntityStatus,
  OrgSubtype,
  UserKind,
  UserRole,
} from '../common/enums';
import { generateTemporaryPassword } from '../common/temporary-password';
import { Locality } from '../geography/entities/locality.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import { User } from '../users/entities/user.entity';
import {
  AddMemberDto,
  CreateAccountDto,
  FindAccountsQuery,
  OnboardCommunityDto,
  SetStaffAssignmentsDto,
  UpdateMemberRoleDto,
  UpdateQuotasDto,
} from './dto/account.dto';
import { AccountUser } from './entities/account-user.entity';
import { Account } from './entities/account.entity';
import { Plan } from './entities/plan.entity';
import { StaffAssignment } from './entities/staff-assignment.entity';

/** Los cuatro cupos de una organización, siempre juntos. */
export interface AccountQuotas {
  maxNeighborhoods: number;
  maxAdminUsers: number;
  maxTechnicianUsers: number;
  maxMonitorUsers: number;
}

const QUOTA_FIELDS = [
  'maxNeighborhoods',
  'maxAdminUsers',
  'maxTechnicianUsers',
  'maxMonitorUsers',
] as const satisfies readonly (keyof AccountQuotas)[];

/** Para los mensajes de cupo, en el idioma del que los lee. */
const ROLE_LABELS: Record<UserRole, string> = {
  [UserRole.OWNER]: 'usuarios institucionales',
  [UserRole.ADMIN]: 'administradores',
  [UserRole.TECHNICIAN]: 'técnicos',
  [UserRole.MONITOR]: 'usuarios de monitoreo',
};

/**
 * El cupo que le corresponde a un rol, o null si no le aplica ninguno.
 *
 * Null en dos casos: el OWNER (es único por índice de la base, no por tarifa —
 * cobrarle un cupo a la soberanía de la cuenta no tendría sentido) y cualquier
 * rol en la cuenta COMPANY, que no tiene cupos porque CPS no se cobra a sí misma.
 */
function quotaForRole(account: Account, role: UserRole): number | null {
  switch (role) {
    case UserRole.ADMIN:
      return account.maxAdminUsers;
    case UserRole.TECHNICIAN:
      return account.maxTechnicianUsers;
    case UserRole.MONITOR:
      return account.maxMonitorUsers;
    case UserRole.OWNER:
      return null;
  }
}

/** La foto de los cuatro cupos, para el audit_log. */
function pickQuotas(account: Account): Partial<AccountQuotas> {
  return {
    maxNeighborhoods: account.maxNeighborhoods ?? undefined,
    maxAdminUsers: account.maxAdminUsers ?? undefined,
    maxTechnicianUsers: account.maxTechnicianUsers ?? undefined,
    maxMonitorUsers: account.maxMonitorUsers ?? undefined,
  };
}

/** Lo que deja el alta atómica de una comunidad: la cuenta + la clave temporal del OWNER (una sola vez). */
export interface OnboardCommunityResult {
  account: Account;
  neighborhoodId: number;
  ownerId: number;
  ownerUsername: string;
  temporaryPassword: string;
}

export interface PagedAccounts {
  items: Account[];
  total: number;
  limit: number;
  offset: number;
}

const PG_UNIQUE_VIOLATION = '23505';
const PG_FK_VIOLATION = '23503';

/**
 * Cuentas, membresías y CUPOS (v2).
 *
 * Invariantes que van acá (la base no llega):
 *  - El usuario con rol OWNER debe ser kind = INSTITUTIONAL, y viceversa un
 *    INSTITUTIONAL solo puede ser OWNER.
 *  - El OWNER no se degrada ni se borra por API: es la soberanía de la cuenta.
 *  - Cupo POR ROL (ADMIN / TECHNICIAN / MONITOR) al crear o promover una
 *    membresía. El cupo 0 significa "este rol no existe en esta cuenta": así
 *    "una comunitaria no tiene técnicos propios" se expresa con el mismo
 *    mecanismo que "puede tener 5 monitores", sin una matriz aparte.
 *  - Los CUPOS los modifica SOLO CPS, siempre con auditoría (valor viejo -> nuevo).
 *  - Una cuenta COMMUNITY es dueña de UN SOLO barrio: max_neighborhoods queda
 *    fijo en 1, siempre (ver negocio-redisenado.md §2.2/2.3). Si crece y
 *    necesita más barrios, la solución es pasarla a MUNICIPAL — no ampliarle
 *    el cupo siendo COMMUNITY. Ojo: eso es independiente de QUIÉN OPERA sus
 *    barrios, que se decide por barrio en `neighborhood.managed_by`.
 *
 * Lo que la base SÍ garantiza y por eso acá no se re-implementa:
 *  - Una sola cuenta COMPANY (índice único parcial).
 *  - Exactamente un OWNER por cuenta (índice único parcial -> 23505 -> 409).
 *  - Que una persona no se repita en la misma cuenta (UNIQUE compuesto).
 */
@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @InjectRepository(AccountUser)
    private readonly memberships: Repository<AccountUser>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(StaffAssignment)
    private readonly assignments: Repository<StaffAssignment>,
    @InjectRepository(Locality)
    private readonly localities: Repository<Locality>,
    @InjectRepository(Plan) private readonly plans: Repository<Plan>,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
  ) {}

  async create(dto: CreateAccountDto, createdBy: number): Promise<Account> {
    // CPS presta el servicio. Hay una sola cuenta COMPANY (la crea el
    // bootstrap) y la base impide duplicarla; esto da un 400 legible.
    if (dto.type === AccountType.COMPANY) {
      throw new BadRequestException(
        'No se pueden crear cuentas COMPANY: ya existe la de CPS Security',
      );
    }

    const quotas = await this.resolveQuotas(dto);
    this.assertCommunityHasOneNeighborhood(
      dto.subtype,
      quotas.maxNeighborhoods,
    );

    const account = await this.accounts.save(
      this.accounts.create({
        name: dto.name,
        type: dto.type,
        subtype: dto.subtype,
        status: EntityStatus.ACTIVE,
        planId: dto.planId ?? null,
        ...quotas,
        createdBy,
      }),
    );

    await this.audit.record({
      actorUserId: createdBy,
      action: 'account.create',
      entityType: 'account',
      entityId: account.id,
      accountId: account.id,
      newValue: {
        name: account.name,
        subtype: account.subtype,
        planId: account.planId,
        ...quotas,
      },
    });

    return account;
  }

  /**
   * Alta atómica de una organización COMMUNITY: cuenta + su único barrio +
   * OWNER institucional (clave temporal) + membresía, en UNA transacción.
   *
   * Por qué existe aparte de create(): la cuenta no tiene sentido de negocio
   * sin su barrio — es lo único que gestiona. Encadenar 4 POST separados desde
   * el front dejaría, ante cualquier falla a mitad de camino, una cuenta a
   * medio crear que nadie puede completar por su cuenta. Todo o nada.
   *
   * SOLO CPS (controller). Siempre COMMUNITY, siempre cupo 1 barrio: no se
   * piden esos campos, para no abrir la puerta a un valor inconsistente.
   *
   * Lo que SÍ se pide es `managedBy`: si el barrio lo opera CPS (llave en
   * mano) o la propia comunidad (autogestión). Es la decisión comercial del
   * momento de la venta y desde 2026-07-30 no se deriva más del subtipo.
   */
  async onboardCommunity(
    dto: OnboardCommunityDto,
    actor: AuthenticatedUser,
  ): Promise<OnboardCommunityResult> {
    const locality = await this.localities.findOne({
      where: { id: dto.neighborhood.localityId },
    });
    if (!locality) {
      throw new NotFoundException(
        `No existe la localidad ${dto.neighborhood.localityId}`,
      );
    }

    // Mismo camino que create(): plan (copiado) o cupos a mano. El de barrios
    // se ignora — una comunitaria es 1, y acá ni siquiera se pregunta.
    const quotas = await this.resolveQuotas({
      ...dto,
      type: AccountType.ORGANIZATION,
      subtype: OrgSubtype.COMMUNITY,
      maxNeighborhoods: 1,
    });

    // Chequeo previo, fuera de la transacción: sin esto, un username repetido
    // revienta el INSERT a mitad de la transacción y el que complete el alta
    // ve un 500 en vez de "el usuario ya existe" (el rollback igual es
    // correcto — no queda cuenta huérfana — pero el mensaje es ilegible).
    const usernameTomado = await this.users.findOne({
      where: { username: dto.ownerUsername },
    });
    if (usernameTomado) {
      throw new ConflictException(
        `El usuario "${dto.ownerUsername}" ya existe`,
      );
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.passwords.hash(temporaryPassword);

    const { account, neighborhood, owner, membership } =
      await this.accounts.manager.transaction(async (manager) => {
        const account = await manager.save(
          manager.create(Account, {
            name: dto.name,
            type: AccountType.ORGANIZATION,
            subtype: OrgSubtype.COMMUNITY,
            status: EntityStatus.ACTIVE,
            planId: dto.planId ?? null,
            ...quotas,
            // Invariante de negocio, no negociable (ver create()): COMMUNITY = 1.
            maxNeighborhoods: 1,
            createdBy: actor.id,
          }),
        );

        const neighborhood = await manager.save(
          manager.create(Neighborhood, {
            name: dto.neighborhood.name,
            localityId: dto.neighborhood.localityId,
            latitude: dto.neighborhood.latitude ?? null,
            longitude: dto.neighborhood.longitude ?? null,
            status: EntityStatus.ACTIVE,
            organizationId: account.id,
            organizationType: AccountType.ORGANIZATION,
            // La modalidad de venta, explícita. Llave en mano (CPS) o
            // autogestión (ORGANIZATION): las dos son ventas legítimas y el
            // que carga el alta es el que sabe cuál se firmó.
            managedBy: dto.managedBy,
            createdBy: actor.id,
          }),
        );

        const owner = await manager.save(
          manager.create(User, {
            name: dto.name,
            kind: UserKind.INSTITUTIONAL,
            username: dto.ownerUsername,
            passwordHash,
            mustChangePassword: true,
            status: EntityStatus.ACTIVE,
            createdBy: actor.id,
          }),
        );

        const membership = await manager.save(
          manager.create(AccountUser, {
            accountId: account.id,
            userId: owner.id,
            role: UserRole.OWNER,
            createdBy: actor.id,
          }),
        );

        return { account, neighborhood, owner, membership };
      });

    // Auditoría DESPUÉS del commit: si algo de arriba revierte, no queda un
    // registro de una acción que en definitiva no pasó.
    await this.audit.record({
      actorUserId: actor.id,
      action: 'account.create',
      entityType: 'account',
      entityId: account.id,
      accountId: account.id,
      newValue: { name: account.name, subtype: account.subtype },
    });
    await this.audit.record({
      actorUserId: actor.id,
      action: 'neighborhood.create',
      entityType: 'neighborhood',
      entityId: neighborhood.id,
      accountId: account.id,
      neighborhoodId: neighborhood.id,
      newValue: { name: neighborhood.name, managedBy: neighborhood.managedBy },
    });
    await this.audit.record({
      actorUserId: actor.id,
      action: 'user.temp_password_issued',
      entityType: 'app_user',
      entityId: owner.id,
    });
    await this.audit.record({
      actorUserId: actor.id,
      action: 'membership.add',
      entityType: 'account_user',
      entityId: membership.id,
      accountId: account.id,
      newValue: { userId: owner.id, role: UserRole.OWNER },
    });

    return {
      account,
      neighborhoodId: neighborhood.id,
      ownerId: owner.id,
      ownerUsername: owner.username!,
      temporaryPassword,
    };
  }

  /**
   * CUPOS = tarifa. SOLO CPS llega acá (controller) y todo cambio queda en
   * audit_log con valor viejo -> nuevo: esa es la trazabilidad tarifaria.
   * Reducir un cupo NO destruye nada (grandfathering): solo bloquea altas.
   */
  async updateQuotas(
    accountId: number,
    dto: UpdateQuotasDto,
    actor: AuthenticatedUser,
  ): Promise<Account> {
    const account = await this.getAccount(accountId);
    if (account.type !== AccountType.ORGANIZATION) {
      throw new BadRequestException('La cuenta COMPANY no tiene cupos');
    }

    // La misma invariante que en create(): la COMMUNITY es un único barrio,
    // sin excepciones ni siquiera para CPS.
    this.assertCommunityHasOneNeighborhood(
      account.subtype,
      dto.maxNeighborhoods ?? account.maxNeighborhoods!,
    );

    const oldValue = pickQuotas(account);
    // Ausente = no tocar ese cupo (PATCH parcial). Se escriben los cuatro
    // igual para que el audit_log guarde la foto completa: un "antes" a medias
    // no sirve para reconstruir qué tenía contratado el cliente ese día.
    const newValue: AccountQuotas = {
      maxNeighborhoods: dto.maxNeighborhoods ?? oldValue.maxNeighborhoods!,
      maxAdminUsers: dto.maxAdminUsers ?? oldValue.maxAdminUsers!,
      maxTechnicianUsers:
        dto.maxTechnicianUsers ?? oldValue.maxTechnicianUsers!,
      maxMonitorUsers: dto.maxMonitorUsers ?? oldValue.maxMonitorUsers!,
    };

    await this.accounts.update(accountId, { ...newValue, updatedBy: actor.id });

    const updated = await this.getAccount(accountId);

    await this.audit.record({
      actorUserId: actor.id,
      action: 'quota.update',
      entityType: 'account',
      entityId: accountId,
      accountId,
      oldValue,
      newValue: pickQuotas(updated),
    });

    return updated;
  }

  /**
   * Lista las cuentas VISIBLES para el que pregunta:
   *   CPS -> todas (con filtros y paginado)
   *   cualquier otro -> SOLO las cuentas a las que pertenece
   */
  async findAll(
    actor: AuthenticatedUser,
    query: FindAccountsQuery,
  ): Promise<PagedAccounts> {
    const propias = actor.memberships.map((m) => m.accountId);
    const esCps = actor.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );

    const filtros = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { name: ILike(`%${query.search}%`) } : {}),
    };

    // El que no es de CPS queda acotado a sus cuentas, siempre. Los filtros se
    // aplican ENCIMA de ese recorte, nunca en lugar de él.
    const where = esCps
      ? filtros
      : propias.length > 0
        ? { ...filtros, id: In(propias) }
        : null;

    if (!where) {
      return { items: [], total: 0, limit: query.limit, offset: query.offset };
    }

    const [items, total] = await this.accounts.findAndCount({
      where,
      order: { id: 'ASC' },
      take: query.limit,
      skip: query.offset,
    });

    return { items, total, limit: query.limit, offset: query.offset };
  }

  async findOne(id: number, actor: AuthenticatedUser): Promise<Account> {
    const account = await this.getAccount(id);
    this.assertAccess(actor, id);
    return account;
  }

  findMembers(
    accountId: number,
    actor: AuthenticatedUser,
  ): Promise<AccountUser[]> {
    this.assertAccess(actor, accountId);

    return this.memberships.find({
      where: { accountId },
      relations: { user: true },
      order: { id: 'ASC' },
    });
  }

  async addMember(
    accountId: number,
    dto: AddMemberDto,
    actor: AuthenticatedUser,
  ): Promise<AccountUser> {
    const account = await this.findOne(accountId, actor);
    const user = await this.getUser(dto.userId);
    await this.assertNoPuedeCapturarACps(actor, dto.userId);
    this.assertKindMatchesRole(user, dto.role);

    const yaEsta = await this.memberships.findOne({
      where: { accountId, userId: dto.userId },
    });
    if (yaEsta) {
      throw new ConflictException('El usuario ya pertenece a esta cuenta');
    }

    await this.assertRoleRoomLeft(account, dto.role);

    try {
      const membership = await this.memberships.save(
        this.memberships.create({
          accountId,
          userId: dto.userId,
          role: dto.role,
          createdBy: actor.id,
        }),
      );

      await this.audit.record({
        actorUserId: actor.id,
        action: 'membership.add',
        entityType: 'account_user',
        entityId: membership.id,
        accountId,
        newValue: { userId: dto.userId, role: dto.role },
      });

      return membership;
    } catch (error) {
      // uq_account_single_owner: exactamente un OWNER por cuenta.
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Esta cuenta ya tiene su OWNER. El OWNER es único: para cambiarlo, contactá a CPS.',
        );
      }
      throw error;
    }
  }

  async updateMemberRole(
    accountId: number,
    userId: number,
    dto: UpdateMemberRoleDto,
    actor: AuthenticatedUser,
  ): Promise<AccountUser> {
    const account = await this.findOne(accountId, actor);
    const membership = await this.getMembership(accountId, userId);

    // La soberanía no se toca por API: ni degradar al OWNER ni promover a
    // alguien a OWNER por PATCH (el OWNER se crea con la cuenta, y cambiarlo es
    // un acto formal de CPS con traspaso de credenciales).
    if (membership.role === UserRole.OWNER || dto.role === UserRole.OWNER) {
      throw new ForbiddenException(
        'El rol OWNER no se cambia por esta vía: es la soberanía de la cuenta',
      );
    }

    // Solo si CAMBIA de rol: revalidar el cupo de un rol que ya tenía haría
    // que un PATCH sin cambios falle en una cuenta que está justo en el límite.
    if (dto.role !== membership.role) {
      await this.assertRoleRoomLeft(account, dto.role);
    }

    const oldRole = membership.role;
    await this.memberships.update(membership.id, { role: dto.role });

    await this.audit.record({
      actorUserId: actor.id,
      action: 'membership.role_change',
      entityType: 'account_user',
      entityId: membership.id,
      accountId,
      oldValue: { role: oldRole },
      newValue: { role: dto.role },
    });

    return this.getMembership(accountId, userId);
  }

  async removeMember(
    accountId: number,
    userId: number,
    actor: AuthenticatedUser,
  ): Promise<void> {
    await this.findOne(accountId, actor); // valida acceso a ESTA cuenta
    const membership = await this.getMembership(accountId, userId);

    // El OWNER no se borra: la cuenta quedaría sin soberanía.
    if (membership.role === UserRole.OWNER) {
      throw new ForbiddenException(
        'El OWNER no se puede eliminar: es la soberanía de la cuenta',
      );
    }

    await this.memberships.delete(membership.id);

    await this.audit.record({
      actorUserId: actor.id,
      action: 'membership.remove',
      entityType: 'account_user',
      entityId: membership.id,
      accountId,
      oldValue: { userId, role: membership.role },
    });
  }

  // --- Asignaciones de personal (staff_assignment) ----------------------------

  /**
   * Barrios asignados a una membresía TECHNICIAN/MONITOR. SIN filas = ve todos
   * los barrios de su organización (default cómodo); CON filas = solo esos.
   */
  async findStaffAssignments(
    accountId: number,
    userId: number,
    actor: AuthenticatedUser,
  ): Promise<StaffAssignment[]> {
    this.assertAccess(actor, accountId);
    const membership = await this.getMembership(accountId, userId);

    return this.assignments.find({
      where: { accountUserId: membership.id },
      relations: { neighborhood: true },
      order: { id: 'ASC' },
    });
  }

  /**
   * Reemplaza el conjunto de barrios asignados (PUT semántico: lo que mandás
   * es lo que queda; lista vacía = volver a "toda la organización").
   *
   * Que el barrio sea de OTRA organización lo frena la FK compuesta de la
   * base — acá solo se traduce ese error a un 400 legible.
   */
  async setStaffAssignments(
    accountId: number,
    userId: number,
    dto: SetStaffAssignmentsDto,
    actor: AuthenticatedUser,
  ): Promise<StaffAssignment[]> {
    await this.findOne(accountId, actor);
    const membership = await this.getMembership(accountId, userId);

    // OWNER y ADMIN ven toda su organización SIEMPRE: asignarles barrios solo
    // generaría la falsa expectativa de que se los está acotando.
    if (
      membership.role !== UserRole.TECHNICIAN &&
      membership.role !== UserRole.MONITOR
    ) {
      throw new BadRequestException(
        'Las asignaciones por barrio son para TECHNICIAN y MONITOR: OWNER y ADMIN ven toda la organización',
      );
    }

    const actuales = await this.assignments.find({
      where: { accountUserId: membership.id },
      select: { neighborhoodId: true },
    });
    const nuevos = [...new Set(dto.neighborhoodIds)];

    try {
      await this.assignments.manager.transaction(async (manager) => {
        await manager.delete(StaffAssignment, {
          accountUserId: membership.id,
        });
        if (nuevos.length > 0) {
          await manager.insert(
            StaffAssignment,
            nuevos.map((neighborhoodId) => ({
              accountUserId: membership.id,
              accountId,
              neighborhoodId,
              createdBy: actor.id,
            })),
          );
        }
      });
    } catch (error) {
      // fk_sa_neighborhood: (neighborhood_id, account_id) no existe — el barrio
      // no es de esta organización (o no existe).
      if (isFkViolation(error)) {
        throw new BadRequestException(
          'Solo se pueden asignar barrios de la propia organización',
        );
      }
      throw error;
    }

    await this.audit.record({
      actorUserId: actor.id,
      action: 'staff_assignment.set',
      entityType: 'account_user',
      entityId: membership.id,
      accountId,
      oldValue: { neighborhoodIds: actuales.map((a) => a.neighborhoodId) },
      newValue: { neighborhoodIds: nuevos },
    });

    return this.findStaffAssignments(accountId, userId, actor);
  }

  // --- Invariantes ------------------------------------------------------------

  /**
   * OWNER <=> usuario INSTITUCIONAL. En las dos direcciones: una persona real
   * no puede ser OWNER (rotación de personal = perder la cuenta), y el usuario
   * institucional no puede operar (ADMIN/TECH/MONITOR exigen un humano con
   * nombre y apellido para que la auditoría diga QUIÉN).
   */
  private assertKindMatchesRole(user: User, role: UserRole): void {
    if (role === UserRole.OWNER && user.kind !== UserKind.INSTITUTIONAL) {
      throw new BadRequestException(
        'El OWNER debe ser un usuario INSTITUCIONAL (la institución, no un empleado)',
      );
    }
    if (role !== UserRole.OWNER && user.kind === UserKind.INSTITUTIONAL) {
      throw new BadRequestException(
        'Un usuario institucional solo puede ser OWNER: la operación diaria es de personas reales',
      );
    }
  }

  /**
   * CUPO POR ROL (§5.2 del diseño): se impone AL CREAR o AL PROMOVER. Si CPS
   * bajó el cupo por debajo de lo existente, no se suspende a nadie
   * (grandfathering): solo se bloquean altas nuevas como esta.
   *
   * Cupo 0 no es "cupo agotado", es "este rol no existe en esta cuenta", y el
   * mensaje lo dice distinto: al que le falta cupo hay que ofrecerle ampliarlo,
   * al que no tiene el rol hay que explicarle por qué.
   */
  private async assertRoleRoomLeft(
    account: Account,
    role: UserRole,
  ): Promise<void> {
    const cupo = quotaForRole(account, role);
    // null = sin cupo aplicable: el OWNER (único por índice, no por tarifa) y
    // la cuenta COMPANY (CPS no se cobra a sí misma).
    if (cupo === null) return;

    const actuales = await this.memberships.count({
      where: { accountId: account.id, role },
    });
    if (actuales < cupo) return;

    const etiqueta = ROLE_LABELS[role];
    if (cupo === 0) {
      throw new BadRequestException(
        `El plan de esta cuenta no incluye ${etiqueta}. Para habilitarlos, contactá a CPS.`,
      );
    }
    throw new BadRequestException(
      `El cupo contratado permite ${cupo} ${etiqueta} y ya hay ${actuales}. ` +
        'Para ampliarlo, contactá a CPS.',
    );
  }

  /**
   * De dónde salen los cupos de una cuenta nueva: del PLAN (copiados) o a
   * mano. El plan es una plantilla — se copia y se olvida. Ver Plan: leerlo en
   * vivo rompería el grandfathering y la trazabilidad de la regla 4.
   *
   * Si vienen las dos cosas, el valor explícito gana: es el caso real de
   * vender un plan con un ajuste puntual sin tener que crear un plan nuevo.
   */
  private async resolveQuotas(dto: CreateAccountDto): Promise<AccountQuotas> {
    if (dto.planId === undefined) {
      const faltantes = QUOTA_FIELDS.filter((f) => dto[f] === undefined);
      if (faltantes.length > 0) {
        throw new BadRequestException(
          `Sin plan hay que indicar todos los cupos a mano. Faltan: ${faltantes.join(', ')}`,
        );
      }
      return {
        maxNeighborhoods: dto.maxNeighborhoods!,
        maxAdminUsers: dto.maxAdminUsers!,
        maxTechnicianUsers: dto.maxTechnicianUsers!,
        maxMonitorUsers: dto.maxMonitorUsers!,
      };
    }

    const plan = await this.plans.findOne({ where: { id: dto.planId } });
    if (!plan) throw new NotFoundException(`No existe el plan ${dto.planId}`);
    if (!plan.active) {
      throw new BadRequestException(
        `El plan "${plan.name}" está discontinuado: no se puede vender uno nuevo con él`,
      );
    }
    if (plan.appliesTo !== dto.subtype) {
      throw new BadRequestException(
        `El plan "${plan.name}" es para organizaciones ${plan.appliesTo}, no ${dto.subtype}`,
      );
    }

    return {
      maxNeighborhoods: dto.maxNeighborhoods ?? plan.maxNeighborhoods,
      maxAdminUsers: dto.maxAdminUsers ?? plan.maxAdminUsers,
      maxTechnicianUsers: dto.maxTechnicianUsers ?? plan.maxTechnicianUsers,
      maxMonitorUsers: dto.maxMonitorUsers ?? plan.maxMonitorUsers,
    };
  }

  /**
   * Una COMMUNITY es dueña de un único barrio: el cupo no es negociable como
   * el resto de la tarifa. Si mandaron otro valor es un malentendido de quien
   * completa el alta y se lo decimos, en vez de pisarlo en silencio.
   *
   * OJO: esto es sobre CUÁNTOS barrios tiene, no sobre quién los opera. Una
   * comunitaria autogestionada sigue teniendo un solo barrio.
   */
  private assertCommunityHasOneNeighborhood(
    subtype: OrgSubtype | null | undefined,
    maxNeighborhoods: number,
  ): void {
    if (subtype !== OrgSubtype.COMMUNITY) return;
    if (maxNeighborhoods === 1) return;

    throw new BadRequestException(
      'Una organización comunitaria gestiona un único barrio: el cupo de barrios es siempre 1. ' +
        'Para más de un barrio, la cuenta tiene que ser MUNICIPAL.',
    );
  }

  /**
   * Un actor que no es de CPS NO puede sumar a un miembro de CPS a su cuenta.
   * Sin esto queda un rodeo para escalar privilegios: "compartir cuenta" con el
   * admin de CPS y desde ahí tocarlo.
   */
  private async assertNoPuedeCapturarACps(
    actor: AuthenticatedUser,
    targetUserId: number,
  ): Promise<void> {
    const actorEsCps = actor.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );
    if (actorEsCps) return;

    // v2: el tipo se resuelve por join (ya no hay columna copiada).
    const targetEsCps = await this.memberships.findOne({
      where: { userId: targetUserId, account: { type: AccountType.COMPANY } },
      relations: { account: true },
    });
    if (targetEsCps) {
      throw new ForbiddenException(
        'No podés agregar a un miembro de CPS Security a tu cuenta',
      );
    }
  }

  /**
   * Ser ADMIN no alcanza: hay que pertenecer a ESTA cuenta. El rol dice QUÉ
   * podés hacer; la membresía dice DÓNDE.
   */
  private assertAccess(actor: AuthenticatedUser, accountId: number): void {
    const esCps = actor.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );
    if (esCps) return;

    const pertenece = actor.memberships.some((m) => m.accountId === accountId);
    if (!pertenece) {
      throw new ForbiddenException('No tenés acceso a esta cuenta');
    }
  }

  private async getMembership(
    accountId: number,
    userId: number,
  ): Promise<AccountUser> {
    const membership = await this.memberships.findOne({
      where: { accountId, userId },
      relations: { user: true },
    });
    if (!membership) {
      throw new NotFoundException(
        `El usuario ${userId} no pertenece a la cuenta ${accountId}`,
      );
    }
    return membership;
  }

  private async getAccount(id: number): Promise<Account> {
    const account = await this.accounts.findOne({ where: { id } });
    if (!account) throw new NotFoundException(`No existe la cuenta ${id}`);
    return account;
  }

  private async getUser(userId: number): Promise<User> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException(`No existe el usuario ${userId}`);
    return user;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

function isFkViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === PG_FK_VIOLATION
  );
}
