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
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireMembership } from '../auth/decorators/roles.decorator';
import { AccountType, UserRole } from '../common/enums';
import { CreatePlanDto, FindPlansQuery, UpdatePlanDto } from './dto/plan.dto';
import { Plan } from './entities/plan.entity';
import { PlansService } from './plans.service';

/**
 * Planes: el catálogo comercial de CPS. TODO el módulo es solo-CPS, incluido
 * el GET — un cliente no tiene por qué ver la grilla de precios ni qué le
 * vendieron a otro. Lo que sí ve de su plan son sus propios cupos, que están
 * en su cuenta.
 *
 * No hay DELETE: un plan se DISCONTINÚA (PATCH { active: false }) y sigue
 * existiendo. Borrarlo perdería la etiqueta histórica de todas las cuentas
 * que se vendieron con él, que es justamente para lo que sirve.
 */
@ApiTags('plans')
@ApiBearerAuth()
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  findAll(@Query() query: FindPlansQuery): Promise<Plan[]> {
    return this.plans.findAll(query);
  }

  @Get(':id')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  findOne(@Param('id', ParseIntPipe) id: number): Promise<Plan> {
    return this.plans.findOne(id);
  }

  /** GET /api/plans/:id/accounts-count — cuántos clientes se vendieron con este plan. */
  @Get(':id/accounts-count')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  async countAccounts(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ count: number }> {
    await this.plans.findOne(id); // 404 si no existe, antes de contar
    return { count: await this.plans.countAccounts(id) };
  }

  @Post()
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  create(
    @Body() dto: CreatePlanDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<Plan> {
    return this.plans.create(dto, actor);
  }

  /**
   * PATCH /api/plans/:id — cambia la vidriera, NO lo ya vendido: los cupos de
   * las cuentas que compraron este plan son copias y no se mueven.
   */
  @Patch(':id')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePlanDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<Plan> {
    return this.plans.update(id, dto, actor);
  }
}
