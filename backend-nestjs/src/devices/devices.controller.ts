import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
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
import { DeviceConfigService } from './device-config.service';
import { DevicesService } from './devices.service';
import {
  CreateBoardModelDto,
  UpdateBoardModelDto,
} from './dto/board-model.dto';
import {
  DeviceConfigView,
  PublishConfigDto,
  RedWifiRevelada,
} from './dto/device-config.dto';
import { DeviceView } from './dto/device-view';
import {
  ClaimDeviceDto,
  CreateDeviceDto,
  CreateMaintenanceDto,
  DeliverDevicesDto,
  UpdateDeviceDto,
  UpdateDeviceMilestonesDto,
  UpdateMaintenanceDto,
} from './dto/device.dto';
import { BoardModel } from './entities/board-model.entity';
import { DeviceMaintenance } from './entities/device-maintenance.entity';
import { DeviceState } from './entities/device-state.entity';

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
    private readonly deviceConfig: DeviceConfigService,
    private readonly scopes: ScopeService,
  ) {}

  /** GET /api/devices?neighborhoodId= — instaladas, ya filtrado por alcance */
  @Get()
  async findAll(
    @Query() query: FindDevicesQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceView[]> {
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
  findInventory(@CurrentUser() user: AuthenticatedUser): Promise<DeviceView[]> {
    return this.devices.findInventory(user);
  }

  // --- Catálogo de modelos de placa ------------------------------------------
  // Va ANTES de :id o "board-models" entraría por ahí y reventaría el ParseIntPipe.

  /** GET /api/devices/board-models — el desplegable de la pantalla de fábrica. */
  @Get('board-models')
  findBoardModels(): Promise<BoardModel[]> {
    return this.devices.findBoardModels();
  }

  /** POST /api/devices/board-models — SOLO CPS. Un modelo nuevo cada tanto. */
  @Post('board-models')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  createBoardModel(
    @Body() dto: CreateBoardModelDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BoardModel> {
    return this.devices.createBoardModel(dto, user.id);
  }

  /** PATCH /api/devices/board-models/:id — renombrar o discontinuar. Solo CPS. */
  @Patch('board-models/:id')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  updateBoardModel(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBoardModelDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BoardModel> {
    return this.devices.updateBoardModel(id, dto, user.id);
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceView> {
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
   * GET /api/devices/:id/config — la configuración que el equipo DICE que corre.
   *
   * Sale del espejo (`gtd.config_espejo`), que es lo único que sabe qué quedó
   * después de los clamps silenciosos del firmware. NUNCA devuelve passwords:
   * cada red viaja con `tienePassword`.
   */
  @Get(':id/config')
  async findConfig(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceConfigView> {
    return this.deviceConfig.findConfig(id, await this.scopes.forUser(user));
  }

  /**
   * PUT /api/devices/:id/config — publica un patch de configuración.
   *
   * Lo mergea `gtd.publish_config` contra el espejo POR SECCIÓN: mandar
   * `{"modulos":{"rf":true}}` no apaga ds3231, eeprom ni supervisor. Solo quien
   * GESTIONA el barrio (con `managed_by = CPS`, la organización solo mira).
   */
  @Put(':id/config')
  async publishConfig(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PublishConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceConfigView> {
    return this.deviceConfig.publish(
      id,
      dto.patch,
      await this.scopes.forUser(user),
      user.id,
    );
  }

  /**
   * POST /api/devices/:id/config/scan — que el equipo busque redes WiFi.
   *
   * A pedido y nunca automático: el scan interrumpe la máquina de estados del
   * WiFi y, mientras dura, el panel no está siendo una alarma. El resultado no
   * vuelve por acá — llega después por `up t:scan`.
   */
  @Post(':id/config/scan')
  async pedirScan(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ mensaje: string }> {
    return this.deviceConfig.pedirScan(
      id,
      await this.scopes.forUser(user),
      user.id,
    );
  }

  /**
   * POST /api/devices/:id/config/refresh — pedirle su configuración actual.
   * Es el desbloqueo cuando el equipo todavía no reportó su `cfg_full`.
   */
  @Post(':id/config/refresh')
  async pedirRefresh(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ mensaje: string }> {
    return this.deviceConfig.pedirRefresh(
      id,
      await this.scopes.forUser(user),
      user.id,
    );
  }

  /**
   * POST /api/devices/:id/config/reveal-wifi — las passwords en claro.
   *
   * SOLO CPS y siempre auditado. Es el único camino de lectura que existe: para
   * EDITAR una red no hace falta leer su password (una red sin `psw` en el patch
   * conserva la del espejo), así que restringir la lectura no le saca capacidad
   * a nadie.
   */
  @Post(':id/config/reveal-wifi')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  async revelarWifi(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RedWifiRevelada[]> {
    return this.deviceConfig.revelarWifi(
      id,
      await this.scopes.forUser(user),
      user.id,
    );
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
  ): Promise<DeviceView> {
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
  ): Promise<DeviceView> {
    return this.devices.claim(dto, user, await this.scopes.forUser(user));
  }

  /**
   * PATCH /api/devices/:id — el `serial` no se puede cambiar.
   *
   * CPS o la organización dueña del barrio (el scope la acota a los suyos): el
   * técnico que instaló la alarma tiene que poder renombrarla, completar los
   * datos del poste y marcarla en mantenimiento sin pedirle permiso a nadie.
   * Lo que queda para CPS —baja definitiva, entrega, testeo— lo frena el
   * servicio, no este decorador.
   */
  @Patch(':id')
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
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDeviceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceView> {
    return this.devices.update(
      id,
      dto,
      await this.scopes.forUser(user),
      user.id,
      user.memberships.some((m) => m.accountType === AccountType.COMPANY),
    );
  }

  /**
   * POST /api/devices/deliver — entrega de LOTE a una organización. Solo CPS.
   *
   * Existe porque entregar 50 alarmas eran 50 PATCH desde el front, cada uno
   * con su chance de fallar por la mitad. Acá o van todas o no va ninguna.
   */
  @Post('deliver')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  deliver(
    @Body() dto: DeliverDevicesDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ delivered: number }> {
    return this.devices.deliver(dto, user.id);
  }

  /**
   * PATCH /api/devices/:id/milestones — hitos de fábrica. Solo CPS.
   *
   * Va aparte de PATCH /:id porque no es lo mismo corregir un dato del equipo
   * que sellar un hito: acá la fecha la pone el servidor y el override de la
   * primera conexión queda auditado.
   */
  @Patch(':id/milestones')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  async updateMilestones(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDeviceMilestonesDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceView> {
    return this.devices.updateMilestones(
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
