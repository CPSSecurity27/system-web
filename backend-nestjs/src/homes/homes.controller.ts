import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { AccountType, UserRole } from '../common/enums';
import { ScopeService } from '../common/scope.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireMembership } from '../auth/decorators/roles.decorator';
import {
  AddHomeMemberDto,
  CreateHomeDto,
  TransferHomeTitularDto,
  UpdateHomeDto,
  UpdateHomeMemberStatusDto,
} from './dto/home.dto';
import { HomeMember } from './entities/home-member.entity';
import { Home } from './entities/home.entity';
import { HomeMemberView, HomesService } from './homes.service';

class FindHomesQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  neighborhoodId?: number;
}

/**
 * Viviendas y sus miembros (v2).
 *
 * El aislamiento importa acá más que en ningún lado: un vecino NO ve la casa
 * de al lado. El gestor del barrio sí ve todas las de SU barrio.
 *
 * Los endpoints donde participa el TITULAR no llevan @RequireMembership: el
 * titular ya no tiene cuenta (es home_member) y su permiso se resuelve en el
 * servicio contra la membresía de hogar. El guard de JWT sigue aplicando.
 */
@ApiTags('homes')
@ApiBearerAuth()
@Controller('homes')
export class HomesController {
  constructor(
    private readonly homes: HomesService,
    private readonly scopes: ScopeService,
  ) {}

  /** GET /api/homes?neighborhoodId= -> solo las viviendas que alcanzás */
  @Get()
  async findAll(
    @Query() query: FindHomesQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Home[]> {
    return this.homes.findAll(
      await this.scopes.forUser(user),
      query.neighborhoodId,
    );
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Home> {
    return this.homes.findOne(id, await this.scopes.forUser(user));
  }

  /**
   * POST /api/homes — CPS o el gestor del barrio. Un titular no da de alta
   * viviendas: no es dueño del barrio, es dueño de su casa.
   */
  @Post()
  @RequireMembership(
    {
      accountType: AccountType.COMPANY,
      roles: [UserRole.OWNER, UserRole.ADMIN],
    },
    {
      accountType: AccountType.ORGANIZATION,
      roles: [UserRole.OWNER, UserRole.ADMIN],
    },
  )
  async create(
    @Body() dto: CreateHomeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Home> {
    return this.homes.create(dto, await this.scopes.forUser(user), user.id);
  }

  /** PATCH /api/homes/:id — gestores, o el TITULAR sobre la suya (lo valida el servicio). */
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateHomeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Home> {
    return this.homes.update(id, dto, user);
  }

  // --- Miembros (el dominio del vecino) -----------------------------------

  /** GET /api/homes/:id/members */
  @Get(':id/members')
  findMembers(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<HomeMemberView[]> {
    return this.homes.findMembers(id, user);
  }

  /**
   * POST /api/homes/:id/members
   *   { person: { name, dni, ... }, role }  -> crea la persona y la membresía
   *   { userId, role }                      -> suma a alguien del padrón
   *
   * Gestores: titular y familiares. El titular: solo familiares de SU casa,
   * hasta el cupo del barrio (que se chequea ANTES de crear a nadie).
   */
  @Post(':id/members')
  addMember(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddHomeMemberDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<HomeMember> {
    return this.homes.addMember(id, dto, user);
  }

  /** PATCH /api/homes/:id/members/:userId    { status } — suspender/reactivar. */
  @Patch(':id/members/:userId')
  updateMemberStatus(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateHomeMemberStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<HomeMember> {
    return this.homes.suspendMember(id, userId, dto.status, user);
  }

  /**
   * POST /api/homes/:id/transfer-titular    { newTitularUserId }
   * El miembro elegido pasa a TITULAR; el saliente queda como FAMILIAR.
   * Decisión del GESTOR (CPS u organización), no del hogar: por eso acá sí
   * hay @RequireMembership — el titular no puede regalar su casa solo.
   */
  @Post(':id/transfer-titular')
  @RequireMembership(
    {
      accountType: AccountType.COMPANY,
      roles: [UserRole.OWNER, UserRole.ADMIN],
    },
    {
      accountType: AccountType.ORGANIZATION,
      roles: [UserRole.OWNER, UserRole.ADMIN],
    },
  )
  transferTitular(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TransferHomeTitularDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<HomeMemberView[]> {
    return this.homes.transferTitular(id, dto, user);
  }

  /** DELETE /api/homes/:id/members/:userId — al titular no se lo borra: se transfiere. */
  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeMember(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.homes.removeMember(id, userId, user);
  }
}
