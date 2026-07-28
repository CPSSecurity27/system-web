import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { UserTokenType } from '../common/enums';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { UserToken } from './entities/user-token.entity';

/** Lo que va firmado dentro del access token. */
export interface JwtPayload {
  sub: number;
  /** NULL para vecinos (su identidad de login es el email o el DNI). */
  username: string | null;
}

export interface SessionContext {
  userAgent?: string | null;
  ipAddress?: string | null;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(UserToken)
    private readonly userTokens: Repository<UserToken>,
  ) {}

  /**
   * Solo se guarda el SHA-256. Si alguien se roba la base, no se lleva tokens
   * usables. No hace falta argon2 acá: el token es aleatorio de 256 bits, no
   * una contraseña adivinable por diccionario.
   */
  private static digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  signAccessToken(user: User): string {
    const payload: JwtPayload = { sub: user.id, username: user.username };
    return this.jwt.sign(payload);
  }

  /** Devuelve el refresh token EN CLARO (única vez que existe) y lo guarda hasheado. */
  async issueRefreshToken(
    user: User,
    context: SessionContext = {},
  ): Promise<string> {
    const plain = randomBytes(32).toString('hex');
    const ttlDays = Number(this.config.get('JWT_REFRESH_TTL_DAYS') ?? 30);

    await this.refreshTokens.save(
      this.refreshTokens.create({
        userId: user.id,
        tokenHash: TokenService.digest(plain),
        expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
      }),
    );

    return plain;
  }

  /** Vigente = existe, no revocado y no vencido. */
  async findValidRefreshToken(plain: string): Promise<RefreshToken | null> {
    const token = await this.refreshTokens.findOne({
      where: { tokenHash: TokenService.digest(plain) },
    });

    if (!token || token.revokedAt !== null || token.expiresAt <= new Date()) {
      return null;
    }
    return token;
  }

  async revokeRefreshToken(id: number): Promise<void> {
    await this.refreshTokens.update(id, { revokedAt: new Date() });
  }

  /** Logout de TODAS las sesiones: es lo que se corre al echar a alguien. */
  async revokeAllRefreshTokens(userId: number): Promise<number> {
    // IsNull() y no `undefined`: TypeORM IGNORA los undefined en el where, y
    // esto terminaría revocando de más (o de menos) sin avisar.
    const result = await this.refreshTokens.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    return result.affected ?? 0;
  }

  /**
   * Token de un solo uso (verificar email, resetear contraseña).
   * Devuelve el valor en claro: es lo que va en el link del mail.
   */
  async issueUserToken(
    user: User,
    type: UserTokenType,
    ttlHours: number,
  ): Promise<string> {
    // Los pendientes anteriores se invalidan: pedir un link nuevo mata al viejo.
    await this.userTokens.update(
      { userId: user.id, type, usedAt: IsNull() },
      { usedAt: new Date() },
    );

    const plain = randomBytes(32).toString('hex');
    await this.userTokens.save(
      this.userTokens.create({
        userId: user.id,
        type,
        tokenHash: TokenService.digest(plain),
        expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
      }),
    );

    return plain;
  }

  async findValidUserToken(
    plain: string,
    type: UserTokenType,
  ): Promise<UserToken | null> {
    const token = await this.userTokens.findOne({
      where: { tokenHash: TokenService.digest(plain), type },
    });

    if (!token || token.usedAt !== null || token.expiresAt <= new Date()) {
      return null;
    }
    return token;
  }

  async consumeUserToken(id: number): Promise<void> {
    await this.userTokens.update(id, { usedAt: new Date() });
  }

  /** Higiene: los vencidos no sirven para nada y la tabla crece sola. */
  async purgeExpired(): Promise<void> {
    const now = new Date();
    await this.refreshTokens.delete({ expiresAt: LessThan(now) });
    await this.userTokens.delete({ expiresAt: LessThan(now) });
  }
}
