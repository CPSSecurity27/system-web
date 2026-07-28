import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { AuthenticatedUser } from '../auth.service';
import { RequestWithUser } from '../guards/jwt-auth.guard';

/** El usuario que el JwtAuthGuard dejó en el request. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser =>
    context.switchToHttp().getRequest<RequestWithUser>().user,
);
