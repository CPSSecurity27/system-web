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
  AddRemoteCodeDto,
  AssignRemoteDto,
  CreateRemoteDto,
  UpdateRemoteDto,
} from './dto/remote.dto';
import { Remote } from './entities/remote.entity';
import { RemoteCodeSummary, RemotesService } from './remotes.service';

class FindRemotesQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  homeId?: number;
}

/**
 * Controles remotos (v2): custodia fábrica -> stock org -> hogar.
 *
 * DUEÑO != PORTADOR: la vivienda es dueña (`homeId`, no se cambia), el
 * portador (`assignedToUserId`) se reasigna libre — y debe ser MIEMBRO del
 * hogar (home_member).
 *
 * El PATCH del titular (reasignar portador en su casa) no lleva
 * @RequireMembership: el titular ya no tiene cuenta; el servicio valida su
 * membresía de hogar vía scope. Los CÓDIGOS RF siguen siendo solo-CPS.
 */
@ApiTags('remotes')
@ApiBearerAuth()
@Controller('remotes')
export class RemotesController {
  constructor(
    private readonly remotes: RemotesService,
    private readonly scopes: ScopeService,
  ) {}

  /** GET /api/remotes?homeId= — el titular ve los de su casa, y nada más. */
  @Get()
  async findAll(
    @Query() query: FindRemotesQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Remote[]> {
    return this.remotes.findAll(await this.scopes.forUser(user), query.homeId);
  }

  /** GET /api/remotes/inventory — CPS: todo el stock; organización: SU stock. */
  @Get('inventory')
  @RequireMembership(
    {
      accountType: AccountType.COMPANY,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
    {
      accountType: AccountType.ORGANIZATION,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
  )
  findInventory(@CurrentUser() user: AuthenticatedUser): Promise<Remote[]> {
    return this.remotes.findInventory(user);
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Remote> {
    return this.remotes.findOne(id, await this.scopes.forUser(user));
  }

  /**
   * POST /api/remotes — CPS o el gestor del barrio. Sin homeId: alta a stock
   * (solo CPS). Falla si el barrio no tiene controles habilitados (cupo).
   */
  @Post()
  @RequireMembership(
    {
      accountType: AccountType.COMPANY,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
    {
      accountType: AccountType.ORGANIZATION,
      roles: [UserRole.OWNER, UserRole.ADMIN],
    },
  )
  async create(
    @Body() dto: CreateRemoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Remote> {
    return this.remotes.create(dto, await this.scopes.forUser(user), user.id);
  }

  /** POST /api/remotes/:id/assign — entrega física: stock -> vivienda. */
  @Post(':id/assign')
  @RequireMembership(
    {
      accountType: AccountType.COMPANY,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
    {
      accountType: AccountType.ORGANIZATION,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
  )
  async assign(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignRemoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Remote> {
    return this.remotes.assign(id, dto, user, await this.scopes.forUser(user));
  }

  /**
   * PATCH /api/remotes/:id
   *
   * Gestores, o el TITULAR sobre los controles de SU casa (darle el llavero al
   * hijo, reportarlo perdido). El alcance lo resuelve el servicio; el portador
   * debe ser miembro del hogar.
   */
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRemoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Remote> {
    return this.remotes.update(
      id,
      dto,
      await this.scopes.forUser(user),
      user.id,
    );
  }

  // --- Códigos RF (SENSIBLE) -------------------------------------------------

  /** GET /api/remotes/:id/codes — posición y fecha, NUNCA el código. */
  @Get(':id/codes')
  async findCodes(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RemoteCodeSummary[]> {
    return this.remotes.findCodes(id, await this.scopes.forUser(user));
  }

  /** POST /api/remotes/:id/codes — solo CPS. Se cifra antes de insertar. */
  @Post(':id/codes')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  async addCode(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddRemoteCodeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RemoteCodeSummary> {
    return this.remotes.addCode(id, dto, await this.scopes.forUser(user));
  }

  /**
   * GET /api/remotes/:id/codes/:codeId/reveal — ÚNICO endpoint que devuelve un
   * código RF EN CLARO. Solo CPS. Cada llamada queda en el log Y en audit_log.
   */
  @Get(':id/codes/:codeId/reveal')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  revealCode(
    @Param('id', ParseIntPipe) id: number,
    @Param('codeId', ParseIntPipe) codeId: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ position: number; code: string }> {
    return this.remotes.revealCode(id, codeId, user.id);
  }

  @Delete(':id/codes/:codeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  async removeCode(
    @Param('id', ParseIntPipe) id: number,
    @Param('codeId', ParseIntPipe) codeId: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.remotes.removeCode(id, codeId, await this.scopes.forUser(user));
  }
}
