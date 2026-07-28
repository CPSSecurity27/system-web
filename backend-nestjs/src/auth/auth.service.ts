import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AccountType,
  EntityStatus,
  HomeMemberRole,
  OrgSubtype,
  UserRole,
  UserTokenType,
} from '../common/enums';
import { AccountUser } from '../accounts/entities/account-user.entity';
import { HomeMember } from '../homes/entities/home-member.entity';
import { User } from '../users/entities/user.entity';
import { MailerService } from './mailer.service';
import { PasswordService } from './password.service';
import { SessionContext, TokenService } from './token.service';

const EMAIL_VERIFICATION_TTL_HOURS = 24;

/**
 * Mucho más corto que el de verificación: este token ABRE LA CUENTA ENTERA.
 * Uno de verificación, en el peor caso, confirma un correo.
 */
const PASSWORD_RESET_TTL_HOURS = 1;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * La identidad que viaja en cada request autenticado.
 *
 * v2: el accountType de cada membresía ya no es una columna copiada — se
 * resuelve con un join a account al construir la identidad. Y se suman las
 * membresías de HOGAR (home_member): son la puerta de la app de vecinos y de
 * ellas deriva el alcance del vecino.
 */
export interface AuthenticatedUser {
  id: number;
  username: string | null;
  name: string;
  email: string | null;
  emailVerified: boolean;
  /** Clave temporal sin cambiar: el `MustChangePasswordGuard` bloquea todo menos cambiarla. */
  mustChangePassword: boolean;
  memberships: {
    membershipId: number;
    accountId: number;
    accountType: AccountType;
    /** Solo ORGANIZATION. Ej: fija si una comunidad PRIVATE ve "Barrio" (uno solo) o "Barrios". */
    subtype: OrgSubtype | null;
    role: UserRole;
  }[];
  homeMemberships: { homeId: number; role: HomeMemberRole }[];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(AccountUser)
    private readonly memberships: Repository<AccountUser>,
    @InjectRepository(HomeMember)
    private readonly homeMembers: Repository<HomeMember>,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mailer: MailerService,
  ) {}

  /**
   * `identifier` es username (panel), o email/DNI (vecino): las tres son
   * columnas únicas, así que un OR entre ellas no puede traer ambigüedad.
   */
  async login(
    identifier: string,
    password: string,
    context: SessionContext,
  ): Promise<AuthTokens> {
    // passwordHash tiene select:false en la entidad: hay que pedirlo explícito.
    const user = await this.users.findOne({
      where: [
        { username: identifier },
        { email: identifier },
        { dni: identifier },
      ],
      select: {
        id: true,
        username: true,
        name: true,
        email: true,
        status: true,
        passwordHash: true,
        emailVerifiedAt: true,
      },
    });

    // Se quema el mismo tiempo aunque el usuario no exista (o sea un vecino
    // que todavía no activó su cuenta y no tiene contraseña): si no, el
    // tiempo de respuesta delata qué identificadores son válidos.
    let ok = false;
    if (user?.passwordHash) {
      ok = await this.passwords.verify(user.passwordHash, password);
    } else {
      await this.passwords.verifyDummy(password);
    }

    // Mismo error para "no existe", "clave mala", "suspendido" y "todavía no
    // activó la cuenta": un atacante no debe poder distinguirlos.
    if (!user || !ok || user.status !== EntityStatus.ACTIVE) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    await this.users.update(user.id, { lastLoginAt: new Date() });

    return {
      accessToken: this.tokens.signAccessToken(user),
      refreshToken: await this.tokens.issueRefreshToken(user, context),
    };
  }

  /**
   * Refresh CON ROTACIÓN: el token viejo se revoca y se emite uno nuevo. Si un
   * refresh token robado se usa después que el legítimo, ya no sirve.
   */
  async refresh(
    refreshToken: string,
    context: SessionContext,
  ): Promise<AuthTokens> {
    const stored = await this.tokens.findValidRefreshToken(refreshToken);
    if (!stored) {
      throw new UnauthorizedException('Refresh token inválido o vencido');
    }

    const user = await this.users.findOne({ where: { id: stored.userId } });
    if (!user || user.status !== EntityStatus.ACTIVE) {
      // El usuario fue suspendido/borrado mientras tenía sesión abierta.
      await this.tokens.revokeAllRefreshTokens(stored.userId);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    await this.tokens.revokeRefreshToken(stored.id);

    return {
      accessToken: this.tokens.signAccessToken(user),
      refreshToken: await this.tokens.issueRefreshToken(user, context),
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const stored = await this.tokens.findValidRefreshToken(refreshToken);
    // Sin token válido no hay nada que cerrar, pero tampoco es un error:
    // desloguearse dos veces no debería fallar.
    if (stored) await this.tokens.revokeRefreshToken(stored.id);
  }

  /** Cierra TODAS las sesiones. Es lo que se corre al echar a un técnico. */
  logoutAll(userId: number): Promise<number> {
    return this.tokens.revokeAllRefreshTokens(userId);
  }

  /**
   * Cambia la contraseña y REVOCA TODAS las sesiones, incluida la del que la
   * está cambiando.
   *
   * Es lo que hace que cambiar la clave sirva de algo: si alguien te robó la
   * cuenta, cambiarla sin cerrar sus sesiones no lo echa — su refresh token
   * seguiría vivo 30 días. Al revocar todo, en 15 minutos (lo que dura el
   * access token) queda afuera sí o sí.
   *
   * Efecto colateral asumido: el usuario tiene que volver a loguearse en todos
   * sus dispositivos. Es el comportamiento correcto y el que espera cualquiera
   * que acaba de cambiar su contraseña por sospecha de robo.
   */
  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    email?: string,
  ): Promise<void> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: {
        id: true,
        passwordHash: true,
        email: true,
        mustChangePassword: true,
      },
    });
    if (!user?.passwordHash) throw new UnauthorizedException();

    // Se exige la actual: un access token robado no debe alcanzar para
    // secuestrar la cuenta cambiándole la clave al dueño.
    const ok = await this.passwords.verify(user.passwordHash, currentPassword);
    if (!ok) {
      throw new UnauthorizedException('La contraseña actual es incorrecta');
    }

    if (currentPassword === newPassword) {
      throw new BadRequestException('La contraseña nueva debe ser distinta');
    }

    // Este es EL momento en que un OWNER institucional recién creado (sin
    // correo: no lo pide el alta) queda con una identidad de contacto real —
    // sin eso, "olvidé mi contraseña" no tiene a dónde mandarle nada.
    if (user.mustChangePassword && !user.email && !email) {
      throw new BadRequestException(
        'Cargá un correo antes de cambiar la contraseña temporal',
      );
    }

    const updates: {
      passwordHash: string;
      mustChangePassword: boolean;
      updatedBy: number;
      email?: string;
      emailVerifiedAt?: null;
    } = {
      passwordHash: await this.passwords.hash(newPassword),
      mustChangePassword: false,
      updatedBy: userId,
    };

    if (email && email !== user.email) {
      const taken = await this.users.findOne({ where: { email } });
      if (taken) {
        throw new BadRequestException(`El correo "${email}" ya está en uso`);
      }
      updates.email = email;
      // Cambia el correo: INVALIDA la verificación, el nuevo no está probado.
      updates.emailVerifiedAt = null;
    }

    await this.users.update(userId, updates);

    if (updates.email) {
      // El OWNER acaba de cargar su correo por primera vez: se dispara la
      // verificación de una, sin que tenga que ir a buscar el botón del
      // perfil aparte.
      await this.requestEmailVerification(userId);
    }

    const revocadas = await this.tokens.revokeAllRefreshTokens(userId);
    this.logger.log(
      `Contraseña cambiada (usuario ${userId}); ${revocadas} sesión(es) revocada(s)`,
    );
  }

  /**
   * "Me olvidé la contraseña". El usuario NO puede loguearse, así que no hay
   * nada con qué probar quién es… salvo que controle su casilla. Por eso acá el
   * TOKEN es la prueba de identidad: no reemplaza a la contraseña actual,
   * reemplaza su ausencia.
   *
   * Exige correo VERIFICADO (2026-07-24, para todo usuario): si no se probó
   * que esa casilla es del usuario, mandarle ahí un link que abre la cuenta
   * entera es confiar en una identidad que nunca se confirmó — y si el correo
   * está mal cargado, el usuario queda sin saberlo, creyendo que "ya va a
   * llegar" un mail que nunca llega a nadie.
   *
   * SIEMPRE termina bien, exista, esté inactivo o sin verificar el correo. Si
   * respondiera distinto en cada caso, sería un buscador gratuito de quién
   * tiene cuenta en el sistema y con qué estado.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.users.findOne({ where: { email } });

    if (
      !user ||
      user.status !== EntityStatus.ACTIVE ||
      !user.email ||
      !user.emailVerifiedAt
    ) {
      // Se loguea, pero al que pide NO se le dice nada distinto.
      this.logger.warn(
        `Reseteo pedido para un correo inexistente, inactivo o sin verificar: ${email}`,
      );
      return;
    }

    const token = await this.tokens.issueUserToken(
      user,
      UserTokenType.PASSWORD_RESET,
      PASSWORD_RESET_TTL_HOURS,
    );

    await this.mailer.sendPasswordReset(user.email, user.name, token);
    this.logger.log(`Mail de reseteo enviado al usuario ${user.id}`);
  }

  /**
   * Consume el token del mail y pone la contraseña nueva.
   *
   * Es TAMBIÉN el mecanismo de activación de cuenta del vecino (v2.1): fijar
   * la contraseña por primera vez es, para este método, indistinguible de
   * resetearla — mismo token PASSWORD_RESET, lo emite UsersService al crear
   * al vecino. Revocar sesiones inexistentes no hace nada, así que reusar el
   * flujo es seguro en ambos casos.
   *
   * Revoca TODAS las sesiones: si alguien te robó la cuenta, recuperarla sin
   * cerrar sus sesiones no lo echa — su refresh token seguiría vivo 30 días.
   *
   * Además marca el correo como verificado: el usuario acaba de demostrar que
   * tiene acceso a esa casilla, que es exactamente lo que la verificación prueba.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const stored = await this.tokens.findValidUserToken(
      token,
      UserTokenType.PASSWORD_RESET,
    );
    if (!stored) {
      throw new BadRequestException('Token inválido, vencido o ya usado');
    }

    await this.users.update(stored.userId, {
      passwordHash: await this.passwords.hash(newPassword),
      emailVerifiedAt: new Date(),
      updatedBy: stored.userId,
    });

    await this.tokens.consumeUserToken(stored.id);
    const revocadas = await this.tokens.revokeAllRefreshTokens(stored.userId);

    this.logger.log(
      `Contraseña reseteada (usuario ${stored.userId}); ${revocadas} sesión(es) revocada(s)`,
    );
  }

  async requestEmailVerification(userId: number): Promise<void> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    if (!user.email) {
      throw new BadRequestException('El usuario no tiene correo cargado');
    }
    if (user.emailVerifiedAt) {
      throw new BadRequestException('El correo ya está verificado');
    }

    const token = await this.tokens.issueUserToken(
      user,
      UserTokenType.EMAIL_VERIFICATION,
      EMAIL_VERIFICATION_TTL_HOURS,
    );

    await this.mailer.sendEmailVerification(user.email, user.name, token);
  }

  async verifyEmail(token: string): Promise<void> {
    const stored = await this.tokens.findValidUserToken(
      token,
      UserTokenType.EMAIL_VERIFICATION,
    );
    if (!stored) {
      throw new BadRequestException('Token inválido, vencido o ya usado');
    }

    await this.users.update(stored.userId, { emailVerifiedAt: new Date() });
    await this.tokens.consumeUserToken(stored.id);

    this.logger.log(`Correo verificado para el usuario ${stored.userId}`);
  }

  /** Perfil + membresías (de cuenta Y de hogar): lo que los Guards necesitan. */
  async buildAuthenticatedUser(userId: number): Promise<AuthenticatedUser> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user || user.status !== EntityStatus.ACTIVE) {
      throw new UnauthorizedException();
    }

    // El tipo de cuenta se resuelve por join (v2: ya no hay columna copiada).
    const memberships = await this.memberships.find({
      where: { userId: user.id },
      relations: { account: true },
    });

    const homeMemberships = await this.homeMembers.find({
      where: { userId: user.id, status: EntityStatus.ACTIVE },
      select: { homeId: true, role: true },
    });

    return {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      mustChangePassword: user.mustChangePassword,
      memberships: memberships.map((m) => ({
        membershipId: m.id,
        accountId: m.accountId,
        accountType: m.account.type,
        subtype: m.account.subtype,
        role: m.role,
      })),
      homeMemberships: homeMemberships.map((h) => ({
        homeId: h.homeId,
        role: h.role,
      })),
    };
  }
}
