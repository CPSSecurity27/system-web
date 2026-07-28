import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_PASSWORD_PENDING } from '../decorators/allow-password-pending.decorator';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { RequestWithUser } from './jwt-auth.guard';

/**
 * Si el usuario tiene una clave TEMPORAL sin cambiar, bloquea todo menos lo
 * marcado con @AllowPasswordPending(). Bloquear esto solo en el front sería
 * cosmético: el access token ya emitido igual serviría para pegarle a
 * cualquier endpoint con curl.
 *
 * Va DESPUÉS de JwtAuthGuard (necesita request.user) y ANTES de
 * MembershipGuard: así el motivo del 403 es "cambiá tu clave", no un error
 * de permisos que no viene al caso.
 */
@Injectable()
export class MustChangePasswordGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_PASSWORD_PENDING,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;

    const { user } = context.switchToHttp().getRequest<RequestWithUser>();
    if (user.mustChangePassword) {
      throw new ForbiddenException(
        'Tenés que cambiar tu contraseña temporal antes de continuar',
      );
    }
    return true;
  }
}
