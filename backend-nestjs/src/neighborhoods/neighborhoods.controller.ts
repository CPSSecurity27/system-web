import {
  Body,
  Controller,
  Get,
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
  CreateNeighborhoodDto,
  TransferNeighborhoodDto,
  UpdateNeighborhoodDto,
  UpdateNeighborhoodQuotasDto,
} from './dto/neighborhood.dto';
import { Neighborhood } from './entities/neighborhood.entity';
import { NeighborhoodsService } from './neighborhoods.service';

class FindNeighborhoodsQuery {
  /** El id INTERNO de la localidad (no el georef_id). Sale de /api/geography. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  localityId?: number;
}

/**
 * Barrios (v2).
 *
 * LECTURA: cualquier usuario logueado, pero SOLO los barrios que alcanza (el
 * alcance sale de la estructura: organización dueña + asignaciones de personal
 * + hogares del vecino — ya no de contratos).
 *
 * ALTA y EDICIÓN: CPS para cualquier organización, o el OWNER/ADMIN de una
 * organización MUNICIPAL para la suya (autogestión, contra su cupo
 * max_neighborhoods). Un consorcio PRIVATE NO gestiona su barrio — nace y
 * vive administrado por CPS (negocio-redisenado.md §2.2) — el service lo
 * rechaza aunque el rol alcance.
 *
 * CUPOS y TRANSFERENCIA: solo CPS. Son la tarifa y la operación más sensible.
 */
@ApiTags('neighborhoods')
@ApiBearerAuth()
@Controller('neighborhoods')
export class NeighborhoodsController {
  constructor(
    private readonly neighborhoods: NeighborhoodsService,
    private readonly scopes: ScopeService,
  ) {}

  /** GET /api/neighborhoods?localityId= -> los barrios que este usuario puede ver */
  @Get()
  async findAll(
    @Query() query: FindNeighborhoodsQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Neighborhood[]> {
    return this.neighborhoods.findAll(
      await this.scopes.forUser(user),
      query.localityId,
    );
  }

  /** GET /api/neighborhoods/:id -> 403 si el barrio no es tuyo */
  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Neighborhood> {
    return this.neighborhoods.findOne(id, await this.scopes.forUser(user));
  }

  /**
   * POST /api/neighborhoods
   * CPS (cualquier organización) o el OWNER/ADMIN de la organización (la suya,
   * contra su cupo). El barrio nace operativo — autonomía total (decisión A).
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
  create(
    @Body() dto: CreateNeighborhoodDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Neighborhood> {
    return this.neighborhoods.create(dto, user);
  }

  /** PATCH /api/neighborhoods/:id — CPS o el admin del barrio (solo el SUYO). */
  @Patch(':id')
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
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateNeighborhoodDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Neighborhood> {
    return this.neighborhoods.update(
      id,
      dto,
      await this.scopes.forUser(user),
      user,
    );
  }

  /** PATCH /api/neighborhoods/:id/quotas — SOLO CPS: los cupos son la tarifa. */
  @Patch(':id/quotas')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  updateQuotas(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateNeighborhoodQuotasDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Neighborhood> {
    return this.neighborhoods.updateQuotas(id, dto, user);
  }

  /**
   * POST /api/neighborhoods/:id/transfer — SOLO CPS.
   * Privada -> municipal o viceversa: cambia cliente y/o gestor; hogares,
   * vecinos, equipos e historial quedan intactos. Auditado siempre.
   */
  @Post(':id/transfer')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  transfer(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TransferNeighborhoodDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Neighborhood> {
    return this.neighborhoods.transfer(id, dto, user);
  }
}
