import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/auth.service';
import { AuditService } from '../common/audit.service';
import {
  AccountType,
  DeviceMilestoneSource,
  DeviceStatus,
  DeviceType,
  MaintenanceStatus,
} from '../common/enums';
import { AccessScope } from '../common/scope.service';
import { Account } from '../accounts/entities/account.entity';
import { Home } from '../homes/entities/home.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import {
  CreateBoardModelDto,
  UpdateBoardModelDto,
} from './dto/board-model.dto';
import { DeviceView, toDeviceView, toDeviceViews } from './dto/device-view';
import { ProvisioningService } from './provisioning.service';
import {
  ClaimDeviceDto,
  CreateDeviceDto,
  CreateMaintenanceDto,
  DeliverDevicesDto,
  InstallationDataDto,
  UpdateDeviceDto,
  UpdateDeviceMilestonesDto,
  UpdateMaintenanceDto,
} from './dto/device.dto';
import { BoardModel } from './entities/board-model.entity';
import { DeviceMaintenance } from './entities/device-maintenance.entity';
import { DeviceState } from './entities/device-state.entity';
import { Device } from './entities/device.entity';
import {
  deriveSerial,
  formatBoardNumber,
  macOui,
  normalizeMac,
  parseBoardNumber,
} from './mac';

/**
 * Alarmas comunitarias (v2), con ciclo de vida completo.
 *
 * Cadena de custodia: fábrica CPS -> stock de organización -> instalada en un
 * barrio. El alta es SOLO de CPS (nadie más fabrica); la instalación la hace
 * un técnico —de CPS o de la organización— RECLAMANDO el equipo con su serial
 * + claim code. Así la muni se autoinstala sin que CPS pierda el stock.
 *
 * Acá solo hay CONFIGURACIÓN. El estado vivo va en device_state, que escribe
 * únicamente el servicio de alarmas; la web lo LEE (GET /devices/:id/state).
 */
@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(DeviceState)
    private readonly states: Repository<DeviceState>,
    @InjectRepository(DeviceMaintenance)
    private readonly maintenances: Repository<DeviceMaintenance>,
    @InjectRepository(Neighborhood)
    private readonly neighborhoods: Repository<Neighborhood>,
    @InjectRepository(Home) private readonly homes: Repository<Home>,
    @InjectRepository(BoardModel)
    private readonly boardModels: Repository<BoardModel>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly audit: AuditService,
    // Circular de verdad: el alta encola la credencial y el encolado necesita
    // resolver el equipo. Nest lo resuelve con forwardRef en los dos lados.
    @Inject(forwardRef(() => ProvisioningService))
    private readonly provisioning: ProvisioningService,
  ) {}

  /** Instaladas en barrios del alcance. El inventario va por /devices/inventory. */
  async findAll(
    scope: AccessScope,
    neighborhoodId?: number,
  ): Promise<DeviceView[]> {
    const barrios = await this.neighborhoodsInScope(scope);

    if (neighborhoodId) {
      this.assertNeighborhood(scope, barrios, neighborhoodId);
      return toDeviceViews(
        await this.devices.find({
          where: { neighborhoodId },
          relations: { boardModel: true },
          order: { name: 'ASC' },
        }),
      );
    }

    if (scope.global) {
      return toDeviceViews(
        await this.devices.find({
          where: { status: In(nonInventoryStatuses()) },
          relations: { boardModel: true },
          order: { name: 'ASC' },
        }),
      );
    }
    if (barrios.length === 0) return [];

    return toDeviceViews(
      await this.devices.find({
        where: { neighborhoodId: In(barrios) },
        relations: { boardModel: true },
        order: { name: 'ASC' },
      }),
    );
  }

  /**
   * El stock: CPS ve todo el inventario (fábrica + stocks de clientes); una
   * organización ve SOLO su propio stock.
   */
  async findInventory(actor: AuthenticatedUser): Promise<DeviceView[]> {
    const esCps = actor.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );
    if (esCps) {
      return toDeviceViews(
        await this.devices.find({
          where: { status: DeviceStatus.INVENTORY },
          relations: { boardModel: true },
          order: { id: 'ASC' },
        }),
      );
    }

    const orgIds = actor.memberships
      .filter((m) => m.accountType === AccountType.ORGANIZATION)
      .map((m) => m.accountId);
    if (orgIds.length === 0) return [];

    return toDeviceViews(
      await this.devices.find({
        where: { status: DeviceStatus.INVENTORY, organizationId: In(orgIds) },
        relations: { boardModel: true },
        order: { id: 'ASC' },
      }),
    );
  }

  async findOne(id: number, scope: AccessScope): Promise<DeviceView> {
    const entidad = await this.devices.findOne({
      where: { id },
      relations: { boardModel: true },
    });
    if (!entidad) throw new NotFoundException(`No existe el dispositivo ${id}`);
    const device = toDeviceView(entidad);

    if (device.neighborhoodId === null) {
      // Inventario: solo CPS lo ve por acá (el stock de una org va por /inventory).
      if (!scope.global) {
        throw new ForbiddenException('No tenés acceso a este dispositivo');
      }
      return this.conEstadoDeCola(device);
    }

    const barrios = await this.neighborhoodsInScope(scope);
    this.assertNeighborhood(scope, barrios, device.neighborhoodId);

    return this.conEstadoDeCola(device);
  }

  /**
   * Completa el estado de la cola de credenciales. Solo en la FICHA: en los
   * listados va null, porque una consulta por equipo sobre una lista de 200 no
   * paga lo que cuesta.
   */
  private async conEstadoDeCola(device: DeviceView): Promise<DeviceView> {
    if (device.provisioning) {
      device.provisioning.queue = await this.provisioning.estadoDe(device.id);
    }
    return device;
  }

  /** Estado vivo (lo escribe el servicio de alarmas; la web solo lee). */
  async findState(id: number, scope: AccessScope): Promise<DeviceState | null> {
    await this.findOne(id, scope);
    return this.states.findOne({ where: { deviceId: id } });
  }

  /**
   * ALTA DE FÁBRICA: SOLO CPS. El equipo nace en INVENTORY con claim code (o
   * directamente instalado si viene neighborhoodId: es CPS instalando).
   *
   * Los dos datos que definen al equipo se LEEN de la placa en la estación de
   * flasheo y no se inventan: la MAC (`esptool read_mac`) y el número impreso
   * (ALOY0043). El serial NO se elige — se deriva de la MAC, porque ese string
   * es también el usuario MQTT y el `<id>` del tópico con el que el equipo va a
   * hablar con el servicio de alarmas.
   */
  async create(dto: CreateDeviceDto, createdBy: number): Promise<DeviceView> {
    // Los otros tipos del enum están reservados y nunca se probaron: dejar
    // entrar uno crearía un equipo sin MAC ni número, esquivando en silencio
    // toda la regla de identidad.
    if (dto.type !== DeviceType.COMMUNITY_ALARM) {
      throw new BadRequestException(
        'Por ahora solo se fabrican alarmas comunitarias. Los otros tipos de ' +
          'equipo están reservados y todavía no tienen alta.',
      );
    }

    const mac = normalizeMac(dto.mac);
    const serial = deriveSerial(mac);
    const { code, seq } = parseBoardNumber(dto.boardNumber);
    const boardModel = await this.resolveBoardModel(code);

    await this.assertMacLibre(mac);
    await this.assertPlacaLibre(boardModel, seq);

    if (dto.neighborhoodId) {
      await this.assertNeighborhoodExists(dto.neighborhoodId);
    }
    if (dto.organizationId && dto.neighborhoodId) {
      throw new BadRequestException(
        'Un equipo instalado no tiene stock: mandá organizationId O neighborhoodId',
      );
    }

    // Se juntan ANTES de guardar porque las dos consultas miran el estado
    // previo del inventario. No bloquean el alta: avisan y el operador decide.
    const warnings = [
      ...(await this.avisoDeOui(mac)),
      ...(await this.avisoDeSalto(boardModel, seq)),
    ];

    const device = await this.devices.save(
      this.devices.create({
        name: dto.name ?? null,
        serial,
        type: dto.type,
        status: dto.neighborhoodId
          ? DeviceStatus.OPERATIONAL
          : DeviceStatus.INVENTORY,
        // El claim code nace con el equipo: es lo que el técnico usa después.
        claimCode: dto.neighborhoodId ? null : generateClaimCode(),
        manufacturedAt: dto.manufacturedAt
          ? new Date(dto.manufacturedAt)
          : new Date(),
        tested: dto.tested ?? false,
        imei: dto.imei ?? null,
        iccid: dto.iccid ?? null,
        mac,
        boardModelId: boardModel.id,
        boardSeq: seq,
        organizationId: dto.organizationId ?? null,
        neighborhoodId: dto.neighborhoodId ?? null,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        installedAt: dto.neighborhoodId ? new Date() : null,
        createdBy,
      }),
    );

    await this.audit.record({
      actorUserId: createdBy,
      action: 'device.create',
      entityType: 'device',
      entityId: device.id,
      neighborhoodId: device.neighborhoodId,
      newValue: {
        serial: device.serial,
        mac,
        boardNumber: formatBoardNumber(boardModel.code, seq),
        status: device.status,
      },
    });

    // El alta de fábrica pide la credencial del broker SOLA: es lo que hace
    // posible fabricar una tanda sin correr un comando por equipo. Si el
    // provisioner está caído, la fila queda pendiente y se toma al arrancar.
    await this.provisioning.encolar(device.id, 'provision', createdBy);

    device.boardModel = boardModel;
    return toDeviceView(device, warnings);
  }

  /**
   * CLAIM: el técnico instala el poste y reclama el equipo con serial + código.
   * - CPS reclama cualquier equipo en inventario, para cualquier barrio que alcance.
   * - El personal de una organización solo reclama equipos de SU stock, para SUS
   *   barrios. El stock de fábrica (sin organización) es reclamable solo por CPS:
   *   primero CPS "entrega" el lote (update organizationId), después la muni instala.
   */
  async claim(
    dto: ClaimDeviceDto,
    actor: AuthenticatedUser,
    scope: AccessScope,
  ): Promise<DeviceView> {
    const device = await this.devices.findOne({
      where: { serial: dto.serial },
    });
    if (!device || device.status !== DeviceStatus.INVENTORY) {
      throw new NotFoundException(
        'No hay un equipo en inventario con ese serial',
      );
    }
    if (!device.claimCode || device.claimCode !== dto.claimCode) {
      throw new ForbiddenException('El código de reclamo no corresponde');
    }

    const barrio = await this.neighborhoods.findOne({
      where: { id: dto.neighborhoodId },
    });
    if (!barrio) {
      throw new NotFoundException(`No existe el barrio ${dto.neighborhoodId}`);
    }
    this.assertNeighborhoodInScope(scope, dto.neighborhoodId);

    const esCps = actor.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );
    if (!esCps) {
      // Solo del stock de la organización dueña del barrio destino.
      if (device.organizationId !== barrio.organizationId) {
        throw new ForbiddenException(
          'Ese equipo no está en el stock de tu organización. Pedile a CPS que lo entregue.',
        );
      }
    }

    await this.devices.update(device.id, {
      status: DeviceStatus.OPERATIONAL,
      neighborhoodId: dto.neighborhoodId,
      organizationId: null, // instalado: ya no es stock de nadie
      claimCode: null, // el código es de un solo uso
      name: dto.name ?? device.name,
      latitude: dto.latitude ?? device.latitude,
      longitude: dto.longitude ?? device.longitude,
      installedAt: new Date(),
      // Los datos de instalación: el mejor momento para cargarlos es ahora,
      // con el técnico parado abajo del poste.
      ...installationChanges(dto, device),
      updatedBy: actor.id,
    });

    await this.audit.record({
      actorUserId: actor.id,
      action: 'device.claim',
      entityType: 'device',
      entityId: device.id,
      accountId: barrio.organizationId,
      neighborhoodId: dto.neighborhoodId,
      oldValue: {
        status: DeviceStatus.INVENTORY,
        organizationId: device.organizationId,
      },
      newValue: {
        status: DeviceStatus.OPERATIONAL,
        neighborhoodId: dto.neighborhoodId,
      },
    });

    return toDeviceView(
      await this.devices.findOneOrFail({
        where: { id: device.id },
        relations: { boardModel: true },
      }),
    );
  }

  /**
   * El `serial` NO se puede cambiar: es la identidad física del equipo.
   *
   * Lo puede llamar CPS o la organización dueña del barrio (el `scope` ya la
   * acota a los suyos): el técnico que instaló la alarma tiene que poder
   * renombrarla, completar los datos del poste y marcarla en mantenimiento sin
   * pedirle permiso a nadie. Lo que NO puede la organización está más abajo.
   */
  async update(
    id: number,
    dto: UpdateDeviceDto,
    scope: AccessScope,
    updatedBy: number,
    esCps: boolean,
  ): Promise<DeviceView> {
    const device = await this.findOne(id, scope);

    if (!esCps) {
      // RETIRED es la baja DEFINITIVA del equipo físico, que sigue siendo del
      // inventario de CPS: la organización lo saca de servicio, no lo da de baja.
      if (dto.status === DeviceStatus.RETIRED) {
        throw new ForbiddenException(
          'La baja definitiva del equipo la hace CPS. Podés marcarlo fuera de servicio.',
        );
      }
      // Mover stock entre organizaciones es una operación comercial de CPS.
      if (dto.organizationId !== undefined) {
        throw new ForbiddenException('La entrega de equipos la hace CPS');
      }
      // `tested` es un hecho de la estación de flasheo.
      if (dto.tested !== undefined) {
        throw new ForbiddenException('El testeo de fábrica lo marca CPS');
      }
    }

    await this.devices.update(id, {
      name: dto.name ?? device.name,
      status: dto.status ?? device.status,
      organizationId:
        dto.organizationId !== undefined
          ? dto.organizationId
          : device.organizationId,
      tested: dto.tested ?? device.tested,
      latitude: dto.latitude ?? device.latitude,
      longitude: dto.longitude ?? device.longitude,
      installedAt: dto.installedAt
        ? new Date(dto.installedAt)
        : device.installedAt,
      ...installationChanges(dto, device),
      updatedBy,
    });

    // Cambiar el estado de un equipo es operativo y hay que poder reconstruirlo:
    // "¿desde cuándo estaba fuera de servicio?" se contesta con esto.
    if (dto.status && dto.status !== device.status) {
      await this.audit.record({
        actorUserId: updatedBy,
        action: 'device.status_change',
        entityType: 'device',
        entityId: id,
        neighborhoodId: device.neighborhoodId,
        oldValue: { status: device.status },
        newValue: { status: dto.status },
      });
    }

    return this.findOne(id, scope);
  }

  /**
   * ENTREGA DE LOTE: fábrica -> organización, todo o nada.
   *
   * Antes eran N llamadas desde el front, cada una con su chance de fallar por
   * la mitad y dejar el lote a medio entregar.
   *
   * Solo mueve equipos que estén en INVENTORY: uno ya instalado pertenece a un
   * barrio, y el CHECK de custodia lo impide igual. Acá el 400 explica cuál.
   */
  async deliver(
    dto: DeliverDevicesDto,
    actorId: number,
  ): Promise<{ delivered: number }> {
    const devices = await this.devices.find({
      where: { id: In(dto.deviceIds) },
    });

    if (devices.length !== dto.deviceIds.length) {
      const encontrados = new Set(devices.map((d) => d.id));
      const faltan = dto.deviceIds.filter((id) => !encontrados.has(id));
      throw new NotFoundException(
        `No existen los equipos: ${faltan.join(', ')}`,
      );
    }

    const enServicio = devices.filter(
      (d) => d.status !== DeviceStatus.INVENTORY,
    );
    if (enServicio.length > 0) {
      throw new BadRequestException(
        `Estos equipos ya están instalados y no se pueden entregar: ${enServicio
          .map((d) => d.serial)
          .join(', ')}`,
      );
    }

    if (dto.organizationId) {
      const org = await this.accounts.findOne({
        where: { id: dto.organizationId },
      });
      if (!org || org.type !== AccountType.ORGANIZATION) {
        throw new NotFoundException(
          `No existe la organización ${dto.organizationId}`,
        );
      }
    }

    const organizationId = dto.organizationId ?? null;

    await this.devices.manager.transaction(async (manager) => {
      await manager.update(
        Device,
        { id: In(dto.deviceIds) },
        { organizationId, updatedBy: actorId },
      );
    });

    // Un registro por equipo: la trazabilidad de un activo es por activo, no
    // por tanda. "¿A quién se le entregó ESTA alarma?" tiene que tener respuesta.
    for (const device of devices) {
      await this.audit.record({
        actorUserId: actorId,
        action: 'device.deliver',
        entityType: 'device',
        entityId: device.id,
        accountId: organizationId ?? undefined,
        oldValue: { organizationId: device.organizationId },
        newValue: { organizationId },
      });
    }

    return { delivered: devices.length };
  }

  /**
   * Hitos de puesta en marcha: etiquetado y primera conexión (SOLO CPS).
   *
   * La primera conexión debería llegar del servicio de alarmas —es un hecho
   * observado por el broker, regla 5 del dominio—, pero el GtD todavía no
   * escribe. Hasta entonces CPS la marca a mano, y por eso el registro guarda
   * que fue MANUAL y quién lo hizo: si más adelante aparece un equipo que
   * "conectó" pero nunca mandó un heartbeat, se puede saber que ese dato lo
   * puso una persona y no el broker.
   *
   * La fecha es siempre la del servidor. Aceptarla del cliente convertiría el
   * hito en una opinión.
   */
  async updateMilestones(
    id: number,
    dto: UpdateDeviceMilestonesDto,
    scope: AccessScope,
    actorId: number,
  ): Promise<DeviceView> {
    if (!scope.global) {
      throw new ForbiddenException('Solo CPS puede marcar hitos de fábrica');
    }

    const device = await this.findOne(id, scope);
    const now = new Date();
    const cambios: Partial<Device> = { updatedBy: actorId };

    if (dto.labeled !== undefined) {
      cambios.labeledAt = dto.labeled ? now : null;
      cambios.labeledBy = dto.labeled ? actorId : null;
    }

    if (dto.connected !== undefined) {
      cambios.firstConnectionAt = dto.connected ? now : null;
      cambios.firstConnectionSource = dto.connected
        ? DeviceMilestoneSource.MANUAL
        : null;
      cambios.firstConnectionBy = dto.connected ? actorId : null;
    }

    await this.devices.update(id, cambios);

    // Se audita solo el override de la conexión: etiquetar es rutina de
    // fábrica, pero afirmar a mano que un equipo conectó es sustituir una
    // medición por un criterio humano, y eso tiene que dejar rastro.
    if (dto.connected !== undefined) {
      await this.audit.record({
        actorUserId: actorId,
        action: dto.connected
          ? 'device.first_connection.manual'
          : 'device.first_connection.clear',
        entityType: 'device',
        entityId: id,
        oldValue: {
          firstConnectionAt: device.firstConnectionAt,
          firstConnectionSource: device.firstConnectionSource,
        },
        newValue: {
          firstConnectionAt: cambios.firstConnectionAt,
          firstConnectionSource: cambios.firstConnectionSource,
        },
      });
    }

    return this.findOne(id, scope);
  }

  // --- Bitácora de mantenimiento --------------------------------------------

  async findMaintenances(
    deviceId: number,
    scope: AccessScope,
  ): Promise<DeviceMaintenance[]> {
    await this.findOne(deviceId, scope); // valida el acceso al device
    return this.maintenances.find({
      where: { deviceId },
      relations: { user: true },
      order: { createdAt: 'DESC' },
    });
  }

  async addMaintenance(
    deviceId: number,
    dto: CreateMaintenanceDto,
    scope: AccessScope,
    createdBy: number,
  ): Promise<DeviceMaintenance> {
    await this.findOne(deviceId, scope);

    return this.maintenances.save(
      this.maintenances.create({
        deviceId,
        type: dto.type,
        status: dto.status ?? MaintenanceStatus.PENDING,
        description: dto.description ?? null,
        performedAt: dto.performedAt ? new Date(dto.performedAt) : null,
        // Por defecto el técnico es quien la carga.
        userId: dto.userId ?? createdBy,
        createdBy,
      }),
    );
  }

  async updateMaintenance(
    deviceId: number,
    maintenanceId: number,
    dto: UpdateMaintenanceDto,
    scope: AccessScope,
    updatedBy: number,
  ): Promise<DeviceMaintenance> {
    await this.findOne(deviceId, scope);

    const maintenance = await this.maintenances.findOne({
      where: { id: maintenanceId, deviceId },
    });
    if (!maintenance) {
      throw new NotFoundException(
        `No existe el mantenimiento ${maintenanceId} en el dispositivo ${deviceId}`,
      );
    }

    await this.maintenances.update(maintenanceId, {
      status: dto.status ?? maintenance.status,
      description: dto.description ?? maintenance.description,
      performedAt: dto.performedAt
        ? new Date(dto.performedAt)
        : maintenance.performedAt,
      updatedBy,
    });

    return this.maintenances.findOneOrFail({ where: { id: maintenanceId } });
  }

  // --- Catálogo de modelos de placa ------------------------------------------

  /** El desplegable de la pantalla de fábrica y la pantalla de administración. */
  findBoardModels(soloActivos = false): Promise<BoardModel[]> {
    return this.boardModels.find({
      where: soloActivos ? { active: true } : {},
      order: { code: 'ASC' },
    });
  }

  async createBoardModel(
    dto: CreateBoardModelDto,
    createdBy: number,
  ): Promise<BoardModel> {
    const code = dto.code.toUpperCase();

    const yaExiste = await this.boardModels.findOne({ where: { code } });
    if (yaExiste) {
      throw new ConflictException(`Ya existe el modelo de placa "${code}"`);
    }

    const model = await this.boardModels.save(
      this.boardModels.create({
        code,
        name: dto.name,
        notes: dto.notes ?? null,
      }),
    );

    await this.audit.record({
      actorUserId: createdBy,
      action: 'board_model.create',
      entityType: 'board_model',
      entityId: model.id,
      newValue: { code: model.code, name: model.name },
    });

    return model;
  }

  /**
   * El `code` no se toca: los equipos ya fabricados componen su número con él
   * (`ALOY` + 0043), así que cambiarlo reescribiría su identidad impresa.
   */
  async updateBoardModel(
    id: number,
    dto: UpdateBoardModelDto,
    updatedBy: number,
  ): Promise<BoardModel> {
    const model = await this.boardModels.findOne({ where: { id } });
    if (!model)
      throw new NotFoundException(`No existe el modelo de placa ${id}`);

    await this.boardModels.update(id, {
      name: dto.name ?? model.name,
      active: dto.active ?? model.active,
      notes: dto.notes !== undefined ? dto.notes : model.notes,
    });

    if (dto.active !== undefined && dto.active !== model.active) {
      await this.audit.record({
        actorUserId: updatedBy,
        action: 'board_model.set_active',
        entityType: 'board_model',
        entityId: id,
        oldValue: { active: model.active },
        newValue: { active: dto.active },
      });
    }

    return this.boardModels.findOneOrFail({ where: { id } });
  }

  // --- Helpers del alta de fábrica -------------------------------------------

  /** El prefijo impreso (`ALOY`) contra el catálogo. */
  private async resolveBoardModel(code: string): Promise<BoardModel> {
    const model = await this.boardModels.findOne({ where: { code } });

    if (!model || !model.active) {
      const validos = (await this.findBoardModels(true)).map((m) => m.code);
      const detalle =
        validos.length > 0
          ? `Los modelos habilitados son: ${validos.join(', ')}.`
          : 'No hay ningún modelo de placa habilitado.';

      throw new BadRequestException(
        model
          ? `El modelo de placa "${code}" está discontinuado. ${detalle}`
          : `No existe el modelo de placa "${code}". ${detalle}`,
      );
    }

    return model;
  }

  /**
   * Si la MAC ya está cargada, el 409 dice DÓNDE está el otro equipo: en la
   * estación de flasheo eso significa o una placa flasheada dos veces o un
   * problema serio de hardware, y en los dos casos el operador necesita saber
   * cuál es el equipo que la tiene. El endpoint es solo-CPS, no hay fuga.
   */
  private async assertMacLibre(mac: string): Promise<void> {
    const existente = await this.devices.findOne({
      where: { mac },
      relations: { neighborhood: true, organization: true },
    });
    if (!existente) return;

    throw new ConflictException(
      `La MAC ya está cargada en el equipo ${existente.serial} (${this.ubicacionDe(existente)})`,
    );
  }

  private async assertPlacaLibre(
    model: BoardModel,
    seq: number,
  ): Promise<void> {
    const existente = await this.devices.findOne({
      where: { boardModelId: model.id, boardSeq: seq },
      relations: { neighborhood: true, organization: true },
    });
    if (!existente) return;

    throw new ConflictException(
      `El número de placa ${formatBoardNumber(model.code, seq)} ya está cargado ` +
        `en el equipo ${existente.serial} (${this.ubicacionDe(existente)})`,
    );
  }

  /**
   * Aviso —no bloqueo— si el fabricante del chip no coincide con ninguno de los
   * equipos ya cargados. Se calibra solo contra el inventario real en vez de
   * contra una lista de OUIs de Espressif: una lista siempre queda vieja, y un
   * aviso que salta en placas legítimas enseña al operador a ignorarlos.
   */
  private async avisoDeOui(mac: string): Promise<string[]> {
    const filas = await this.devices
      .createQueryBuilder('d')
      .select('DISTINCT substring(d.mac from 1 for 6)', 'oui')
      .where('d.mac IS NOT NULL')
      .getRawMany<{ oui: string }>();

    const conocidos = filas.map((f) => f.oui);
    if (conocidos.length === 0 || conocidos.includes(macOui(mac))) return [];

    return [
      `El fabricante del chip (${macOui(mac)}) no coincide con el de ningún equipo ` +
        `ya cargado (${conocidos.join(', ')}). Si no es una placa de otro proveedor, ` +
        'revisá que la MAC esté bien leída.',
    ];
  }

  /**
   * Aviso si la numeración impresa salta. Un salto suele ser una placa que se
   * fabricó y nunca se cargó — vale la pena mirarlo antes de que se pierda.
   */
  private async avisoDeSalto(
    model: BoardModel,
    seq: number,
  ): Promise<string[]> {
    const fila = await this.devices
      .createQueryBuilder('d')
      .select('MAX(d.boardSeq)', 'max')
      .where('d.boardModelId = :id', { id: model.id })
      .getRawOne<{ max: number | string | null }>();

    const ultimo =
      fila?.max === null || fila?.max === undefined ? null : Number(fila.max);
    if (ultimo === null || seq <= ultimo + 1) return [];

    const faltan = seq - ultimo - 1;
    return [
      `El último número cargado de este modelo fue ${formatBoardNumber(model.code, ultimo)} ` +
        `y estás cargando ${formatBoardNumber(model.code, seq)}: quedan ${faltan} ` +
        `placa${faltan === 1 ? '' : 's'} sin registrar en el medio.`,
    ];
  }

  /** Para los mensajes de 409: dónde está el equipo que ya usa ese dato. */
  private ubicacionDe(device: Device): string {
    if (device.neighborhood) return `instalado en ${device.neighborhood.name}`;
    if (device.organization)
      return `en el stock de ${device.organization.name}`;
    return 'en la fábrica CPS';
  }

  // --- Helpers ---------------------------------------------------------------

  /**
   * Los barrios que el usuario alcanza: los que gestiona MÁS los de sus
   * viviendas. Un vecino alcanza las alarmas de su barrio porque son
   * infraestructura compartida, no suya.
   */
  private async neighborhoodsInScope(scope: AccessScope): Promise<number[]> {
    if (scope.global) return [];

    const ids = new Set(scope.neighborhoodIds);

    if (scope.homeIds.length > 0) {
      const homes = await this.homes.find({
        where: { id: In(scope.homeIds) },
        select: { id: true, neighborhoodId: true },
      });
      for (const home of homes) ids.add(home.neighborhoodId);
    }

    return [...ids];
  }

  private assertNeighborhood(
    scope: AccessScope,
    barriosDelUsuario: number[],
    neighborhoodId: number,
  ): void {
    if (scope.global || barriosDelUsuario.includes(neighborhoodId)) return;
    throw new ForbiddenException('No tenés acceso a este dispositivo');
  }

  private assertNeighborhoodInScope(
    scope: AccessScope,
    neighborhoodId: number,
  ): void {
    if (scope.global || scope.neighborhoodIds.includes(neighborhoodId)) return;
    throw new ForbiddenException('No tenés acceso a ese barrio');
  }

  private async assertNeighborhoodExists(id: number): Promise<void> {
    const barrio = await this.neighborhoods.findOne({ where: { id } });
    if (!barrio) throw new NotFoundException(`No existe el barrio ${id}`);
  }
}

/**
 * Los cinco datos de instalación, listos para el UPDATE.
 *
 * `undefined` = no vino en el request y no se toca; **`null` = borrarlo**. Sin
 * esa distinción no habría forma de corregir un poste mal cargado: mandar el
 * campo vacío no haría nada.
 */
function installationChanges(
  dto: InstallationDataDto,
  device: Device,
): Partial<Device> {
  const pick = <T>(nuevo: T | undefined, actual: T): T =>
    nuevo !== undefined ? nuevo : actual;

  return {
    poleNumber: pick(dto.poleNumber, device.poleNumber),
    heightM: pick(dto.heightM, device.heightM),
    reference: pick(dto.reference, device.reference),
    powerPoint: pick(dto.powerPoint, device.powerPoint),
    installNotes: pick(dto.installNotes, device.installNotes),
  };
}

function nonInventoryStatuses(): DeviceStatus[] {
  return Object.values(DeviceStatus).filter(
    (s) => s !== DeviceStatus.INVENTORY,
  );
}

/** 6 caracteres legibles (sin 0/O, 1/I): suficiente junto al serial. */
function generateClaimCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
