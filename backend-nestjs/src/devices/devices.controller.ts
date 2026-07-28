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
import { DevicesService } from './devices.service';
import {
  ClaimDeviceDto,
  CreateDeviceDto,
  CreateMaintenanceDto,
  UpdateDeviceDto,
  UpdateMaintenanceDto,
} from './dto/device.dto';
import { DeviceMaintenance } from './entities/device-maintenance.entity';
import { DeviceState } from './entities/device-state.entity';
import { Device } from './entities/device.entity';

class FindDevicesQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  neighborhoodId?: number;
}

/**
 * Alarmas comunitarias (v2): infraestructura del BARRIO, con inventario.
 *
 * - Alta (fabricación): SOLO CPS. El equipo nace en INVENTORY con claim code.
 * - Entrega del lote: CPS mueve stock a una organización (PATCH organizationId).
 * - Instalación: el técnico —de CPS o de la organización— RECLAMA el equipo
 *   (serial + código) y queda vinculado a SU barrio.
 * - Estado vivo: GET /devices/:id/state (lo escribe el servicio de alarmas).
 */
@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly scopes: ScopeService,
  ) {}

  /** GET /api/devices?neighborhoodId= — instaladas, ya filtrado por alcance */
  @Get()
  async findAll(
    @Query() query: FindDevicesQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Device[]> {
    return this.devices.findAll(
      await this.scopes.forUser(user),
      query.neighborhoodId,
    );
  }

  /** GET /api/devices/inventory — CPS: todo el stock; organización: SU stock. */
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
  findInventory(@CurrentUser() user: AuthenticatedUser): Promise<Device[]> {
    return this.devices.findInventory(user);
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Device> {
    return this.devices.findOne(id, await this.scopes.forUser(user));
  }

  /** GET /api/devices/:id/state — estado vivo (online, disparada). Solo lectura. */
  @Get(':id/state')
  async findState(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceState | null> {
    return this.devices.findState(id, await this.scopes.forUser(user));
  }

  /**
   * POST /api/devices — SOLO CPS (fabricación / instalación directa).
   * Sin neighborhoodId nace en INVENTORY con claim code.
   */
  @Post()
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  create(
    @Body() dto: CreateDeviceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Device> {
    return this.devices.create(dto, user.id);
  }

  /**
   * POST /api/devices/claim — instalación por reclamo (serial + código).
   * Técnicos de CPS (cualquier equipo) o de la organización (su stock, sus barrios).
   */
  @Post('claim')
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
  async claim(
    @Body() dto: ClaimDeviceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Device> {
    return this.devices.claim(dto, user, await this.scopes.forUser(user));
  }

  /** PATCH /api/devices/:id — el `serial` no se puede cambiar. Solo CPS. */
  @Patch(':id')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDeviceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Device> {
    return this.devices.update(
      id,
      dto,
      await this.scopes.forUser(user),
      user.id,
    );
  }

  // --- Bitácora de mantenimiento --------------------------------------------

  /** GET /api/devices/:id/maintenances — la lee también el gestor del barrio. */
  @Get(':id/maintenances')
  async findMaintenances(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceMaintenance[]> {
    return this.devices.findMaintenances(id, await this.scopes.forUser(user));
  }

  /** POST /api/devices/:id/maintenances — técnicos de CPS o de la organización. */
  @Post(':id/maintenances')
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
  async addMaintenance(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateMaintenanceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceMaintenance> {
    return this.devices.addMaintenance(
      id,
      dto,
      await this.scopes.forUser(user),
      user.id,
    );
  }

  @Patch(':id/maintenances/:maintenanceId')
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
  async updateMaintenance(
    @Param('id', ParseIntPipe) id: number,
    @Param('maintenanceId', ParseIntPipe) maintenanceId: number,
    @Body() dto: UpdateMaintenanceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceMaintenance> {
    return this.devices.updateMaintenance(
      id,
      maintenanceId,
      dto,
      await this.scopes.forUser(user),
      user.id,
    );
  }
}
