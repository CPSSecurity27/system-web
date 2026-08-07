import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';
import { AccountType, UserRole } from '../common/enums';
import { ScopeService } from '../common/scope.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireMembership } from '../auth/decorators/roles.decorator';
import { DeviceCommandsService } from './device-commands.service';
import { DeviceConfigService } from './device-config.service';
import {
  CONFIGURAN_EQUIPOS,
  DISPARAN_ALARMA,
  VEN_PASSWORDS_WIFI,
} from './device-permissions';
import {
  ColaComandosView,
  SendCommandDto,
  TriggerAlarmDto,
} from './dto/device-command.dto';
import { ProvisioningService } from './provisioning.service';
import { DevicesService } from './devices.service';
import {
  CreateBoardModelDto,
  UpdateBoardModelDto,
} from './dto/board-model.dto';
import {
  DeviceConfigView,
  FuenteConfigView,
  PublishConfigDto,
  RedWifiRevelada,
} from './dto/device-config.dto';
import { DeviceView } from './dto/device-view';
import {
  AdoptDeviceDto,
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

class FindInventoryQuery {
  /**
   * Traer también los equipos sin el visto bueno de fábrica. Lo usa la pantalla
   * de FÁBRICA; el servicio lo ignora si el usuario no es de CPS.
   */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  incluirSinAprobar?: boolean;
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
    private readonly commands: DeviceCommandsService,
    private readonly provisioning: ProvisioningService,
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

  /**
   * GET /api/devices/removed — la papelera. Solo CPS.
   *
   * Va ANTES de :id, como board-models, o "removed" entraría por ahí y reventaría
   * el ParseIntPipe.
   */
  @Get('removed')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  async findRemoved(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceView[]> {
    return this.devices.findRemoved(await this.scopes.forUser(user));
  }

  /**
   * GET /api/devices/inventory — el STOCK: lo que está listo para entregar o
   * instalar. CPS ve todo; una organización, el suyo.
   *
   * Solo trae equipos con el visto bueno de fábrica: un equipo entra al stock
   * cuando alguien lo aprueba, no cuando se fabrica.
   *
   * `?incluirSinAprobar=true` trae también los que no lo tienen. Lo usa la
   * pantalla de FÁBRICA, que es donde se los termina de poner a punto — sin eso,
   * un equipo recién fabricado desaparecería de la única pantalla desde la que
   * se lo puede aprobar. El servicio lo ignora si el usuario no es de CPS.
   */
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
  findInventory(
    @Query() query: FindInventoryQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceView[]> {
    return this.devices.findInventory(user, query.incluirSinAprobar === true);
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
    return this.deviceConfig.findConfig(
      id,
      await this.scopes.forUser(user),
      user,
    );
  }

  /**
   * GET /api/devices/:id/config/sources — de qué otros equipos se puede copiar.
   *
   * Los del MISMO barrio que ya reportaron su configuración. Copiar de otro
   * barrio sería copiar redes WiFi que ahí no existen.
   */
  @Get(':id/config/sources')
  async findConfigSources(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<FuenteConfigView[]> {
    return this.deviceConfig.fuentesParaCopiar(
      id,
      await this.scopes.forUser(user),
    );
  }

  /**
   * PUT /api/devices/:id/config — publica un patch de configuración.
   *
   * Lo mergea `gtd.publish_config` contra el espejo POR SECCIÓN: mandar
   * `{"modulos":{"rf":true}}` no apaga ds3231, eeprom ni supervisor.
   *
   * Dos ejes, los dos obligatorios: el ROL dice qué (el MONITOR mira, no
   * configura) y el ALCANCE dice dónde (`assertManagesNeighborhood`, en el
   * servicio: con `managed_by = CPS` la organización solo mira).
   */
  @Put(':id/config')
  @RequireMembership(...CONFIGURAN_EQUIPOS)
  async publishConfig(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PublishConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceConfigView> {
    return this.deviceConfig.publish(
      id,
      dto.patch,
      await this.scopes.forUser(user),
      user,
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
  @RequireMembership(...CONFIGURAN_EQUIPOS)
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
  @RequireMembership(...CONFIGURAN_EQUIPOS)
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
  @RequireMembership(...VEN_PASSWORDS_WIFI)
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

  // --- Comandos al panel -----------------------------------------------------

  /**
   * GET /api/devices/:id/commands — los últimos 20, con su estado.
   *
   * Solo pide VER el equipo. Sin esta lista, un comando que quedó `pending`
   * porque el equipo duerme es indistinguible de uno que nunca se mandó.
   */
  @Get(':id/commands')
  async findCommands(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ColaComandosView> {
    return this.commands.listar(id, await this.scopes.forUser(user), user);
  }

  /**
   * POST /api/devices/:id/commands — encola un comando de infraestructura.
   *
   * Los dos ejes de siempre: el ROL acá y el ALCANCE
   * (`assertManagesNeighborhood`) adentro del servicio. El MONITOR queda afuera
   * —reiniciar un poste no es monitorear— salvo para disparar la alarma, que
   * tiene su propia ruta.
   */
  @Post(':id/commands')
  @RequireMembership(...CONFIGURAN_EQUIPOS)
  async sendCommand(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SendCommandDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ColaComandosView> {
    return this.commands.mandar(
      id,
      dto.tipo,
      dto.params ?? {},
      dto.confirmacion,
      await this.scopes.forUser(user),
      user,
    );
  }

  /**
   * POST /api/devices/:id/commands/:cid/cancel — sacarlo de la cola.
   *
   * Solo mientras sigue `pending`: lo que ya se publicó en el broker el panel lo
   * va a recibir igual, así que un comando enviado no se cancela, se compensa.
   */
  @Post(':id/commands/:cid/cancel')
  @RequireMembership(...CONFIGURAN_EQUIPOS)
  async cancelCommand(
    @Param('id', ParseIntPipe) id: number,
    @Param('cid') cid: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ColaComandosView> {
    return this.commands.cancelar(
      id,
      cid,
      await this.scopes.forUser(user),
      user,
    );
  }

  /**
   * POST /api/devices/:id/alarm — disparar o apagar la alarma a distancia.
   *
   * Ruta aparte de los comandos porque NO es infraestructura: es la operación, y
   * es la única acción sobre el equipo que suma al MONITOR. Lo que realmente
   * pasó no vuelve por acá: llega después como `up t:alarma` y termina en un
   * `event` igual que si lo hubiera disparado un vecino.
   */
  @Post(':id/alarm')
  @RequireMembership(...DISPARAN_ALARMA)
  async triggerAlarm(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TriggerAlarmDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ColaComandosView> {
    return this.commands.disparar(
      id,
      dto.modo,
      await this.scopes.forUser(user),
      user,
    );
  }

  /**
   * GET /api/devices/:id/portal-cps — la password del usuario `cps`.
   *
   * Endpoint aparte de la ficha, y con menos roles que ella: `cps` es la
   * credencial de nivel FÁBRICA del portal del equipo, el firmware manda no
   * imprimirla nunca, y un técnico no la necesita para trabajar. Solo OWNER y
   * ADMIN de CPS, y cada lectura deja `audit_log`.
   *
   * La de `admin` no pasa por acá: viene en la ficha, porque va impresa en la
   * etiqueta que queda pegada al equipo.
   */
  @Get(':id/portal-cps')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  async passwordCps(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ usuario: 'cps'; password: string }> {
    return this.devices.findPortalCps(
      id,
      user,
      await this.scopes.forUser(user),
    );
  }

  /**
   * POST /api/devices/:id/remove — a la papelera. Solo CPS.
   *
   * Saca el equipo de todas las listas y REVOCA su credencial del broker: un
   * equipo fuera de circulación con credencial activa es el olvido invisible que
   * el spec del provisioner quería evitar.
   *
   * Si estaba instalado lo DESVINCULA del barrio. Eso cambia la infraestructura
   * de ese barrio desde una pantalla de fábrica, y es la razón por la que esto
   * es solo de CPS y deja `audit_log`.
   */
  @Post(':id/remove')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  async remover(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceView> {
    return this.devices.remove(id, user, await this.scopes.forUser(user));
  }

  /**
   * POST /api/devices/:id/restore — de vuelta a circulación. Solo CPS.
   *
   * Vuelve al STOCK DE FÁBRICA, no al barrio donde estaba: reinstalarlo es un
   * claim, con su técnico y sus datos de instalación. Se le genera un claim code
   * nuevo —el anterior quedó impreso en una etiqueta que puede andar dando
   * vueltas— y se vuelve a pedir su credencial del broker.
   */
  @Post(':id/restore')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  async reactivar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceView> {
    return this.devices.restore(id, user, await this.scopes.forUser(user));
  }

  /**
   * DELETE /api/devices/:id — borrado DEFINITIVO. Solo desde la papelera.
   *
   * Se lleva la bitácora de mantenimiento. Un equipo con EVENTOS no se puede
   * borrar: son append-only y la base lo rechaza; el servicio traduce ese
   * rechazo a un mensaje que se entienda.
   *
   * Solo OWNER: es la única operación del módulo que destruye algo sin vuelta.
   */
  @Delete(':id')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER],
  })
  async borrarDefinitivo(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ mensaje: string }> {
    return this.devices.hardDelete(id, user, await this.scopes.forUser(user));
  }

  /**
   * POST /api/devices/:id/provision — pedir el alta de la credencial.
   *
   * Sirve para reintentar un alta fallida y para los equipos que ya existen sin
   * registrar: no hace falta un backfill aparte. El alta de fábrica ya encola
   * sola, así que esto es la excepción, no el camino normal.
   */
  @Post(':id/provision')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  async pedirProvision(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ mensaje: string }> {
    return this.provisioning.pedir(
      id,
      'provision',
      await this.scopes.forUser(user),
      user.id,
    );
  }

  /**
   * POST /api/devices/:id/revoke-credential — dar de baja la credencial.
   *
   * SIEMPRE manual, nunca automático: ningún cambio de estado del equipo revoca
   * nada (decisión de negocio, 2026-08-04). Es el camino para un equipo robado,
   * reemplazado o dado de baja.
   */
  @Post(':id/revoke-credential')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  async revocarCredencial(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ mensaje: string }> {
    return this.provisioning.pedir(
      id,
      'revoke',
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
   * POST /api/devices/adopt — sumar un equipo al stock propio (serial + código).
   *
   * El otro uso del código además de instalar: la muni recibe una caja, carga el
   * código y el equipo pasa a su inventario sin instalarse todavía. Solo sobre
   * equipos SIN DUEÑO — uno que ya es de alguien se entrega, no se adopta.
   *
   * Convive con la entrega de lotes: aquella es para el despacho de 50 equipos
   * que todavía no llegaron; esto, para la caja que alguien tiene en la mano.
   */
  @Post('adopt')
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
  adopt(
    @Body() dto: AdoptDeviceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceView> {
    return this.devices.adopt(dto, user);
  }

  /**
   * POST /api/devices/claim — instalación por reclamo (serial + código).
   *
   * Lo que gobierna es de QUIÉN ES el equipo, no el código: sin dueño lo reclama
   * cualquiera, con dueño solo esa organización o CPS hacia un barrio de ella.
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
