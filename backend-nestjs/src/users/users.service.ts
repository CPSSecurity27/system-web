import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { AccountUser } from '../accounts/entities/account-user.entity';
import type { AuthenticatedUser } from '../auth/auth.service';
import { AuditService } from '../common/audit.service';
import {
  AccountType,
  EntityStatus,
  UserKind,
  UserRole,
  UserTokenType,
} from '../common/enums';
import { generateTemporaryPassword } from '../common/temporary-password';
import { HomeMember } from '../homes/entities/home-member.entity';
import { MailerService } from '../auth/mailer.service';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { CreateUserDto, FindUsersQuery, UpdateUserDto } from './dto/user.dto';
import { User } from './entities/user.entity';

/** La cuenta a la que pertenece el usuario en el padrón (a lo sumo una, ver `uq_account_user_single_account`). */
export interface UserAccountSummary {
  id: number;
  name: string;
  role: UserRole;
}

export interface UserListItem extends Omit<
  User,
  'memberships' | 'emailVerified'
> {
  account: UserAccountSummary | null;
}

export interface PagedUsers {
  items: UserListItem[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Lo que devuelve el alta. `temporaryPassword` solo viaja en ESTA respuesta
 * (institucional, ver UsersService.create): no se puede volver a leer, ni de
 * acá ni de la base — solo se guarda su hash.
 */
export interface CreatedUser extends Omit<User, 'emailVerified'> {
  temporaryPassword?: string;
}

/**
 * Los datos de un vecino que se carga junto con su vivienda. Nombre y DNI y
 * nada más: el resto lo completa él desde la app.
 *
 * Se declara acá y no se importa el DTO de `homes` para que la dependencia
 * vaya en un solo sentido (homes -> users). `ResidentDto` lo satisface solo.
 */
export interface NewResident {
  name: string;
  dni: string;
  telephone?: string;
  birthDate?: string;
  email?: string;
}

/**
 * Sin urgencia real (nadie quedó afuera de una cuenta existente, todavía no
 * la usó): más margen que el PASSWORD_RESET_TTL_HOURS de auth.service (1h).
 */
const ACCOUNT_ACTIVATION_TTL_HOURS = 48;

/**
 * Alta y ABM de usuarios (v2.1). No hay registro público: a los usuarios los
 * crea un admin (de CPS o de una organización) o el titular de una vivienda
 * (para sus familiares, vía app).
 *
 * Tres identidades:
 *  - panel: username + password (persona real)
 *  - institucional: username, kind INSTITUTIONAL, sin DNI, SIN password (solo
 *    CPS lo crea) — nace con una clave TEMPORAL generada acá mismo, ver
 *    `generateTemporaryPassword`, y tiene que cambiarla en su primer login
 *    (`mustChangePassword`, impuesto por `MustChangePasswordGuard`).
 *  - vecino: **nombre + DNI** (el DNI es su identidad de login), email
 *    opcional, SIN password al crearlo. Nace con `password_hash` NULL —
 *    "cuenta sin activar" — y la fija él mismo: por mail si dejó correo (ver
 *    auth.service#resetPassword), o desde la app si no.
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(AccountUser)
    private readonly memberships: Repository<AccountUser>,
    @InjectRepository(HomeMember)
    private readonly homeMembers: Repository<HomeMember>,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
  ) {}

  async create(
    dto: CreateUserDto,
    actor: AuthenticatedUser,
  ): Promise<CreatedUser> {
    if (!dto.username && !dto.dni) {
      throw new BadRequestException(
        'Un usuario necesita username (panel) o DNI (vecino)',
      );
    }

    // El vecino fija su propia contraseña al activar la cuenta: si el gestor
    // pudiera mandarla acá, quedaría sabiéndola (mal hábito de seguridad).
    if (!dto.username && dto.password) {
      throw new BadRequestException(
        'La contraseña de un vecino se define al activar la cuenta, no se manda al crearlo',
      );
    }

    // Usuarios institucionales: SOLO los crea CPS. Son la soberanía de una
    // cuenta y nacen en el onboarding, no en la operación diaria.
    const esInstitucional = dto.kind === UserKind.INSTITUTIONAL;
    if (esInstitucional) {
      const esCps = actor.memberships.some(
        (m) => m.accountType === AccountType.COMPANY,
      );
      if (!esCps) {
        throw new ForbiddenException(
          'Los usuarios institucionales los crea CPS en el onboarding',
        );
      }
      if (dto.dni) {
        throw new BadRequestException(
          'Un usuario institucional no tiene DNI: no es una persona',
        );
      }
      if (!dto.username) {
        throw new BadRequestException(
          'Un usuario institucional necesita username',
        );
      }
      if (dto.password) {
        throw new BadRequestException(
          'La contraseña de un usuario institucional la genera el sistema, no se manda al crearlo',
        );
      }
    }

    if (dto.username) await this.assertUsernameFree(dto.username);
    if (dto.dni) await this.assertDniFree(dto.dni);
    if (dto.email) await this.assertEmailFree(dto.email);

    // Solo institucional genera clave temporal acá; el resto sigue igual
    // (panel: la manda el que crea; vecino: sin clave, la fija al activar).
    const temporaryPassword = esInstitucional
      ? generateTemporaryPassword()
      : undefined;
    const passwordToHash = temporaryPassword ?? dto.password;

    const user = await this.users.save(
      this.users.create({
        name: dto.name,
        kind: dto.kind ?? UserKind.PERSON,
        username: dto.username ?? null,
        dni: dto.dni ?? null,
        email: dto.email ?? null,
        telephone: dto.telephone ?? null,
        birthDate: dto.birthDate ?? null,
        passwordHash: passwordToHash
          ? await this.passwords.hash(passwordToHash)
          : null,
        mustChangePassword: esInstitucional,
        status: EntityStatus.ACTIVE,
        createdBy: actor.id,
      }),
    );

    // Vecino nuevo CON correo: se le manda el mail de activación como atajo.
    // Sin correo no pasa nada acá — nace con password_hash NULL ("cuenta sin
    // activar") y la activación por DNI la resuelve la app, que es el camino
    // previsto para el vecino. Ver el spec de viviendas y vecinos.
    if (!dto.username && user.email) {
      await this.sendActivationMail(user);
    }

    if (temporaryPassword) {
      // Se audita el HECHO, nunca el valor: la clave en claro no se guarda
      // en ningún lado más que en esta respuesta.
      await this.audit.record({
        actorUserId: actor.id,
        action: 'user.temp_password_issued',
        entityType: 'app_user',
        entityId: user.id,
      });
    }

    const created = await this.findOne(user.id);
    return temporaryPassword ? { ...created, temporaryPassword } : created;
  }

  /**
   * Crea un VECINO dentro de una transacción ajena: la del alta de vivienda,
   * donde el usuario, la casa y la membresía se escriben juntos o no se
   * escribe nada.
   *
   * Nace con `password_hash` NULL — "cuenta sin activar" — y sin membresía de
   * panel: un vecino no entra al panel. NO manda el mail de activación: eso va
   * después del commit (ver `sendActivationMail`), porque un mail no se puede
   * deshacer si la transacción rota.
   */
  async createResident(
    manager: EntityManager,
    data: NewResident,
    actorId: number,
  ): Promise<User> {
    // Unicidad DENTRO de la transacción: el repositorio de afuera no ve lo que
    // esta transacción todavía no commiteó.
    const users = manager.getRepository(User);

    if (await users.findOne({ where: { dni: data.dni } })) {
      throw new ConflictException(
        `Ya existe una persona con el DNI ${data.dni}`,
      );
    }
    if (data.email && (await users.findOne({ where: { email: data.email } }))) {
      throw new ConflictException(
        `Ya hay un usuario con el correo ${data.email}`,
      );
    }

    return users.save(
      users.create({
        name: data.name,
        kind: UserKind.PERSON,
        username: null,
        dni: data.dni,
        email: data.email ?? null,
        telephone: data.telephone ?? null,
        birthDate: data.birthDate ?? null,
        passwordHash: null,
        mustChangePassword: false,
        status: EntityStatus.ACTIVE,
        createdBy: actorId,
      }),
    );
  }

  /** Mismo token que "olvidé mi contraseña": fijar la clave por primera vez
   * es, para el modelo, la misma operación que resetearla. Es público porque
   * el alta de vivienda lo llama DESPUÉS de commitear su transacción. */
  async sendActivationMail(user: User): Promise<void> {
    if (!user.email) return;
    const token = await this.tokens.issueUserToken(
      user,
      UserTokenType.PASSWORD_RESET,
      ACCOUNT_ACTIVATION_TTL_HOURS,
    );
    await this.mailer.sendAccountActivation(user.email, user.name, token);
  }

  /**
   * Padrón completo. Solo CPS (ver el controller). Paginado SIEMPRE.
   * `passwordHash` tiene select:false: no puede filtrarse por descuido.
   * Trae la cuenta (a lo sumo una, uq_account_user_single_account) con
   * LEFT JOIN: un vecino sin membresía de panel simplemente no tiene cuenta.
   */
  async findAll(query: FindUsersQuery): Promise<PagedUsers> {
    const qb = this.users
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.memberships', 'membership')
      .leftJoinAndSelect('membership.account', 'account')
      .orderBy('user.id', 'ASC')
      .take(query.limit)
      .skip(query.offset);

    if (query.search) {
      qb.andWhere(
        '(user.name ILIKE :search OR user.username ILIKE :search OR user.dni ILIKE :search OR user.email ILIKE :search)',
        { search: `%${query.search}%` },
      );
    }
    if (query.status) {
      qb.andWhere('user.status = :status', { status: query.status });
    }

    const [users, total] = await qb.getManyAndCount();

    return {
      items: users.map((user) => this.toListItem(user)),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  private toListItem(user: User): UserListItem {
    const { memberships, ...rest } = user;
    const membership = memberships?.[0] ?? null;
    return {
      ...rest,
      account: membership
        ? {
            id: membership.account.id,
            name: membership.account.name,
            role: membership.role,
          }
        : null,
    };
  }

  async findOne(id: number, actor?: AuthenticatedUser): Promise<User> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`No existe el usuario ${id}`);

    if (actor) await this.assertCanManage(actor, id);
    return user;
  }

  async update(
    id: number,
    dto: UpdateUserDto,
    actor: AuthenticatedUser,
  ): Promise<User> {
    const user = await this.findOne(id, actor);

    if (dto.email && dto.email !== user.email) {
      await this.assertEmailFree(dto.email);
      // Cambiar el correo INVALIDA la verificación: el nuevo no está probado.
      await this.users.update(id, { emailVerifiedAt: null });
    }

    await this.users.update(id, {
      name: dto.name ?? user.name,
      email: dto.email ?? user.email,
      telephone: dto.telephone ?? user.telephone,
      birthDate: dto.birthDate ?? user.birthDate,
      status: dto.status ?? user.status,
      updatedBy: actor.id,
    });

    return this.findOne(id);
  }

  /**
   * Quién puede LEER o TOCAR a quién.
   *
   * Ser ADMIN no alcanza: hay que compartir una CUENTA o un HOGAR con el otro
   * (v2: los vecinos ya no tienen cuenta — el vínculo del titular con sus
   * familiares es el hogar). Y nadie que no sea de CPS toca a un miembro de
   * CPS: sin eso, suspender al admin del sistema sería una escalación trivial.
   */
  private async assertCanManage(
    actor: AuthenticatedUser,
    targetId: number,
  ): Promise<void> {
    const actorEsCps = actor.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );
    if (actorEsCps) return;

    // Uno no se puede quedar sin poder verse a sí mismo.
    if (actor.id === targetId) return;

    const membresiasDelTarget = await this.memberships.find({
      where: { userId: targetId },
      relations: { account: true },
    });

    const targetEsCps = membresiasDelTarget.some(
      (m) => m.account.type === AccountType.COMPANY,
    );
    if (targetEsCps) {
      throw new ForbiddenException('No tenés acceso a este usuario');
    }

    // ¿Comparten cuenta?
    const cuentasDelActor = new Set(actor.memberships.map((m) => m.accountId));
    const compartenCuenta = membresiasDelTarget.some((m) =>
      cuentasDelActor.has(m.accountId),
    );
    if (compartenCuenta) return;

    // ¿Comparten hogar? (el titular gestiona a su familia)
    const hogaresDelActor = actor.homeMemberships.map((h) => h.homeId);
    if (hogaresDelActor.length > 0) {
      const compartenHogar = await this.homeMembers.findOne({
        where: { userId: targetId, homeId: In(hogaresDelActor) },
      });
      if (compartenHogar) return;
    }

    throw new ForbiddenException('No tenés acceso a este usuario');
  }

  private async assertUsernameFree(username: string): Promise<void> {
    const taken = await this.users.findOne({ where: { username } });
    if (taken) {
      throw new ConflictException(`El usuario "${username}" ya existe`);
    }
  }

  private async assertDniFree(dni: string): Promise<void> {
    const taken = await this.users.findOne({ where: { dni } });
    if (taken) {
      throw new ConflictException(`Ya existe un usuario con el DNI ${dni}`);
    }
  }

  private async assertEmailFree(email: string): Promise<void> {
    const taken = await this.users.findOne({ where: { email } });
    if (taken) {
      throw new ConflictException(`El correo "${email}" ya está en uso`);
    }
  }
}
