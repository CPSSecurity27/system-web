import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AccountType, HomeMemberRole, UserRole } from '../common/enums';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireMembership } from '../auth/decorators/roles.decorator';
import { CreateUserDto, FindUsersQuery, UpdateUserDto } from './dto/user.dto';
import { User } from './entities/user.entity';
import type { CreatedUser, PagedUsers } from './users.service';
import { UsersService } from './users.service';

/**
 * Alta de usuarios (v2). NO hay registro público: los crea un admin de panel o
 * el titular de una vivienda (para su familia).
 *
 * Crear un usuario NO le da acceso a nada: es solo una identidad. El acceso lo
 * da la membresía (POST /accounts/:id/members o POST /homes/:id/members).
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /**
   * POST /api/users
   *
   * Admins de panel, o el TITULAR de una vivienda (que da de alta a su familia
   * — se valida acá porque el titular ya no tiene cuenta). Los usuarios
   * institucionales (OWNER) solo los crea CPS: lo valida el servicio.
   */
  @Post()
  create(
    @Body() dto: CreateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<CreatedUser> {
    const esAdminPanel = actor.memberships.some(
      (m) =>
        (m.accountType === AccountType.COMPANY ||
          m.accountType === AccountType.ORGANIZATION) &&
        (m.role === UserRole.OWNER || m.role === UserRole.ADMIN),
    );
    const esTitular = actor.homeMemberships.some(
      (h) => h.role === HomeMemberRole.TITULAR,
    );
    if (!esAdminPanel && !esTitular) {
      throw new ForbiddenException('No tenés permisos para crear usuarios');
    }

    return this.users.create(dto, actor);
  }

  /**
   * GET /api/users?search=&status=&limit=&offset=
   *
   * El padrón COMPLETO del sistema. SOLO CPS: ni siquiera el admin de un
   * barrio entra acá — para ver a su gente tiene /accounts/:id/members y
   * /homes/:id/members, acotados a lo suyo.
   */
  @Get()
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  findAll(@Query() query: FindUsersQuery): Promise<PagedUsers> {
    return this.users.findAll(query);
  }

  /**
   * GET /api/users/:id — 403 si no compartís cuenta NI hogar con esa persona.
   * El rol dice QUÉ podés hacer; la membresía dice SOBRE QUIÉN.
   */
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<User> {
    return this.users.findOne(id, actor);
  }

  /**
   * PATCH /api/users/:id — 403 si no compartís cuenta ni hogar.
   *
   * Lo más sensible del módulo: suspender a alguien lo deja afuera EN EL ACTO.
   * Nadie que no sea de CPS puede tocar a un miembro de CPS.
   */
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<User> {
    return this.users.update(id, dto, actor);
  }
}
