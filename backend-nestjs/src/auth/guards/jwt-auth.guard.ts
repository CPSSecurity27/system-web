import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthService, AuthenticatedUser } from '../auth.service';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { JwtPayload } from '../token.service';

export interface RequestWithUser extends Request {
  user: AuthenticatedUser;
}

/**
 * Valida el access token y cuelga el usuario (con sus membresías) en el request.
 *
 * Se registra GLOBAL: por defecto todo endpoint exige token, y lo abierto se
 * marca explícitamente con @Public(). Al revés —proteger a mano cada endpoint—
 * el día que alguien olvida un decorador el agujero queda abierto en silencio.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException('Falta el token');

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token inválido o vencido');
    }

    // Se relee el usuario de la base en cada request: un usuario suspendido
    // deja de entrar YA, sin esperar a que venza su access token.
    request.user = await this.auth.buildAuthenticatedUser(payload.sub);
    return true;
  }

  private extractToken(request: Request): string | null {
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    return scheme === 'Bearer' && token ? token : null;
  }
}
