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
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AccountType, UserRole } from '../common/enums';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireMembership } from '../auth/decorators/roles.decorator';
import type {
  MapAccount,
  OnboardCommunityResult,
  OnboardMunicipalResult,
  PagedAccounts,
} from './accounts.service';
import { AccountsService } from './accounts.service';
import {
  AddMemberDto,
  CreateAccountDto,
  FindAccountsQuery,
  OnboardCommunityDto,
  OnboardMunicipalDto,
  SetStaffAssignmentsDto,
  UpdateMemberRoleDto,
  UpdateQuotasDto,
} from './dto/account.dto';
import { AccountUser } from './entities/account-user.entity';
import { Account } from './entities/account.entity';
import { StaffAssignment } from './entities/staff-assignment.entity';

/**
 * Cuentas (el cliente: municipalidad o consorcio), sus membresías y sus CUPOS.
 *
 * v2: ya no hay cuentas HOME — los vecinos entran por home_member (ver homes).
 * OWNER es el usuario institucional (soberanía); ADMIN opera; MONITOR está
 * sujeto a cupo. Los CUPOS son tarifa: solo CPS los toca, siempre auditado.
 */
@ApiTags('accounts')
@ApiBearerAuth()
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  /** POST /api/accounts — solo CPS. COMPANY no se puede crear (es única). */
  @Post()
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  create(
    @Body() dto: CreateAccountDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<Account> {
    return this.accounts.create(dto, actor.id);
  }

  /**
   * POST /api/accounts/onboard-community — SOLO CPS.
   *
   * Alta atómica de una comunidad PRIVATE: cuenta + su único barrio + OWNER
   * institucional (clave temporal, ver `temporaryPassword` en la respuesta,
   * se muestra UNA sola vez) + membresía, en una sola transacción. Para
   * MUNICIPAL seguí usando POST /accounts + POST /users + POST
   * /accounts/:id/members por separado: ahí no hace falta el barrio en el
   * mismo paso (se autogestiona, puede tener varios).
   */
  @Post('onboard-community')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  onboardCommunity(
    @Body() dto: OnboardCommunityDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<OnboardCommunityResult> {
    return this.accounts.onboardCommunity(dto, actor);
  }

  /**
   * POST /api/accounts/onboard-municipal — SOLO CPS.
   *
   * Alta atómica de una MUNICIPAL: cuenta + OWNER institucional (clave
   * temporal, ver `temporaryPassword` en la respuesta, se muestra UNA sola vez)
   * + membresía, en una sola transacción.
   *
   * NO crea barrio ni contrato: la muni carga sus barrios después, contra su
   * cupo, y el contrato es del barrio. Una municipalidad con cero barrios es un
   * estado válido, no un alta a medias.
   */
  @Post('onboard-municipal')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  onboardMunicipal(
    @Body() dto: OnboardMunicipalDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<OnboardMunicipalResult> {
    return this.accounts.onboardMunicipal(dto, actor);
  }

  /**
   * PATCH /api/accounts/:id/quotas — SOLO CPS. Los cupos son la tarifa.
   * Todo cambio queda en audit_log con valor viejo -> nuevo.
   */
  @Patch(':id/quotas')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  updateQuotas(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateQuotasDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<Account> {
    return this.accounts.updateQuotas(id, dto, actor);
  }

  /**
   * GET /api/accounts — CPS ve todas; el resto SOLO las suyas.
   * Los filtros se aplican ENCIMA de ese recorte.
   */
  @Get()
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
  findAll(
    @Query() query: FindAccountsQuery,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<PagedAccounts> {
    return this.accounts.findAll(actor, query);
  }

  /**
   * GET /api/accounts/map — el TABLERO: clientes con sus barrios, sin paginar.
   *
   * Va ANTES de `@Get(':id')` a propósito: Nest resuelve por orden de
   * declaración y, puesta después, "map" entraría como `:id` y el ParseIntPipe
   * devolvería un 400.
   *
   * Mismo alcance que el listado: CPS ve todas, una organización solo la suya
   * (recortado en el servicio, no acá).
   */
  @Get('map')
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
  findForMap(@CurrentUser() actor: AuthenticatedUser): Promise<MapAccount[]> {
    return this.accounts.findForMap(actor);
  }

  /** GET /api/accounts/:id — 403 si la cuenta no es tuya. */
  @Get(':id')
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
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<Account> {
    return this.accounts.findOne(id, actor);
  }

  /** GET /api/accounts/:id/members — idem: solo los de TU cuenta. */
  @Get(':id/members')
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
  findMembers(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AccountUser[]> {
    return this.accounts.findMembers(id, actor);
  }

  /**
   * POST /api/accounts/:id/members    { userId, role }
   *
   * OWNER exige usuario institucional (y es único por cuenta); MONITOR está
   * sujeto al cupo max_monitor_users. El OWNER de la organización puede crear
   * sus propios ADMINs: es exactamente para lo que existe.
   */
  @Post(':id/members')
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
  addMember(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddMemberDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AccountUser> {
    return this.accounts.addMember(id, dto, actor);
  }

  /** PATCH /api/accounts/:id/members/:userId — el rol OWNER no se toca por acá. */
  @Patch(':id/members/:userId')
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
  updateMemberRole(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateMemberRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AccountUser> {
    return this.accounts.updateMemberRole(id, userId, dto, actor);
  }

  /**
   * GET /api/accounts/:id/members/:userId/assignments
   * Barrios asignados a un TECHNICIAN/MONITOR. Sin filas = ve toda su org.
   */
  @Get(':id/members/:userId/assignments')
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
  findStaffAssignments(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<StaffAssignment[]> {
    return this.accounts.findStaffAssignments(id, userId, actor);
  }

  /**
   * PUT /api/accounts/:id/members/:userId/assignments   { neighborhoodIds }
   * Reemplaza el conjunto completo; [] = vuelve a "toda la organización".
   * Asignar un barrio de otra organización es imposible a nivel BASE (FK
   * compuesta): acá llega como 400.
   */
  @Put(':id/members/:userId/assignments')
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
  setStaffAssignments(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: SetStaffAssignmentsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<StaffAssignment[]> {
    return this.accounts.setStaffAssignments(id, userId, dto, actor);
  }

  /** DELETE /api/accounts/:id/members/:userId — al OWNER no se lo puede sacar. */
  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
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
  removeMember(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<void> {
    return this.accounts.removeMember(id, userId, actor);
  }
}
