import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  MembershipRequirement,
  REQUIRED_MEMBERSHIP,
} from '../decorators/roles.decorator';
import { RequestWithUser } from './jwt-auth.guard';

/**
 * RBAC: chequea el par (account.type, role), no el rol suelto.
 *
 * Alcanza con que UNA membresía del usuario cumpla alguno de los requisitos.
 * Un técnico de CPS que además es titular de su vivienda tiene dos membresías y
 * cada una le habilita cosas distintas.
 */
@Injectable()
export class MembershipGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<MembershipRequirement[]>(
      REQUIRED_MEMBERSHIP,
      [context.getHandler(), context.getClass()],
    );
    // Sin @RequireMembership solo hace falta estar logueado (lo hizo JwtAuthGuard).
    if (!required?.length) return true;

    const { user } = context.switchToHttp().getRequest<RequestWithUser>();

    const allowed = user.memberships.some((m) =>
      required.some(
        (r) => r.accountType === m.accountType && r.roles.includes(m.role),
      ),
    );

    if (!allowed) {
      throw new ForbiddenException('No tenés permisos para esta operación');
    }
    return true;
  }
}
