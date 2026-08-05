import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
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
import { PortalCryptoService } from '../common/portal-crypto.service';
import { AccessScope } from '../common/scope.service';
import { Account } from '../accounts/entities/account.entity';
import { Home } from '../homes/entities/home.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import {
  CreateBoardModelDto,
  UpdateBoardModelDto,
} from './dto/board-model.dto';
import { DeviceView, toDeviceView } from './dto/device-view';
import { ProvisioningService } from './provisioning.service';
import {
  AdoptDeviceDto,
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
    private readonly config: ConfigService,
    private readonly portalCrypto: PortalCryptoService,
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
      return this.conEstadosDeCola(
        await this.devices.find({
          where: { neighborhoodId, removedAt: IsNull() },
          relations: { boardModel: true },
          order: { name: 'ASC' },
        }),
      );
    }

    if (scope.global) {
      return this.conEstadosDeCola(
        await this.devices.find({
          where: { status: In(nonInventoryStatuses()), removedAt: IsNull() },
          relations: { boardModel: true },
          order: { name: 'ASC' },
        }),
      );
    }
    if (barrios.length === 0) return [];

    return this.conEstadosDeCola(
      await this.devices.find({
        where: { neighborhoodId: In(barrios), removedAt: IsNull() },
        relations: { boardModel: true },
        order: { name: 'ASC' },
      }),
    );
  }

  /**
   * El STOCK: lo que está listo para entregar o instalar.
   *
   * CPS ve todo el inventario (fábrica + stocks de clientes); una organización
   * ve SOLO su propio stock.
   *
   * ## Solo los APROBADOS
   *
   * Un equipo entra al stock cuando alguien le da el visto bueno de fábrica
   * (`ready_at`), no cuando se fabrica. Antes del visto bueno el equipo existe y
   * se ve en la pantalla de FÁBRICA, que es donde se lo termina de poner a
   * punto; "stock" significa mercadería lista, no mercadería a medio hacer.
   *
   * Decisión del usuario (2026-08-05): es el botón "Listo" el que habilita al
   * equipo en el inventario.
   *
   * Consecuencia a tener presente: un equipo entregado a una organización SIN
   * el visto bueno le queda invisible —no está en su stock y no ve la fábrica—.
   * Hoy no puede pasar por accidente porque la entrega la hace CPS mirando la
   * lista, pero si alguna vez `deliver` se automatiza, ahí hay un agujero.
   *
   * ## Orden
   *
   * Lo ÚLTIMO que entró primero. Estaba al revés y el equipo recién aprobado
   * caía al final de la lista, justo donde nadie lo busca.
   */
  async findInventory(
    actor: AuthenticatedUser,
    incluirSinAprobar = false,
  ): Promise<DeviceView[]> {
    const esCps = actor.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );
    if (esCps) {
      // La pantalla de FÁBRICA necesita ver los equipos ANTES del visto bueno:
      // es donde se los termina de poner a punto. Sin esta salida, el equipo
      // recién fabricado desaparecería de la única pantalla desde la que se lo
      // puede aprobar. Solo CPS, que es la única que ve la fábrica.
      const aprobados = incluirSinAprobar ? undefined : Not(IsNull());

      return this.conEstadosDeCola(
        await this.devices.find({
          where: {
            status: DeviceStatus.INVENTORY,
            removedAt: IsNull(),
            ...(aprobados ? { readyAt: aprobados } : {}),
          },
          relations: { boardModel: true },
          order: { id: 'DESC' },
        }),
      );
    }

    const orgIds = actor.memberships
      .filter((m) => m.accountType === AccountType.ORGANIZATION)
      .map((m) => m.accountId);
    if (orgIds.length === 0) return [];

    return this.conEstadosDeCola(
      await this.devices.find({
        where: {
          status: DeviceStatus.INVENTORY,
          organizationId: In(orgIds),
          removedAt: IsNull(),
          readyAt: Not(IsNull()),
        },
        relations: { boardModel: true },
        order: { id: 'DESC' },
      }),
    );
  }

  async findOne(id: number, scope: AccessScope): Promise<DeviceView> {
    const entidad = await this.devices.findOne({
      where: { id },
      relations: { boardModel: true },
    });
    if (!entidad) throw new NotFoundException(`No existe el dispositivo ${id}`);
    const device = this.vista(entidad);

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
   * La vista de UN equipo, con la password de `admin` descifrada.
   *
   * Solo por acá: los LISTADOS la dejan en null a propósito. La etiqueta se
   * imprime de a un equipo, así que el front pide la ficha antes de imprimir —
   * un request más a cambio de que una lista de 200 equipos no sea un volcado de
   * 200 passwords en una respuesta HTTP.
   */
  private vista(device: Device, warnings: string[] = []): DeviceView {
    return toDeviceView(device, warnings, (blob) =>
      this.portalCrypto.decrypt(blob),
    );
  }

  /** Completa el estado de la cola de credenciales de UN equipo. */
  private async conEstadoDeCola(device: DeviceView): Promise<DeviceView> {
    if (device.provisioning) {
      device.provisioning.queue = await this.provisioning.estadoDe(device.id);
    }
    return device;
  }

  /**
   * Lo mismo para una lista, en una sola consulta.
   *
   * Antes los listados devolvían `queue: null` siempre, y eso hacía que un
   * equipo con la credencial en cola se viera idéntico a uno al que nunca se le
   * pidió nada — justo lo que la tabla de fábrica necesita distinguir.
   */
  private async conEstadosDeCola(
    entidades: Device[],
    warnings: string[] = [],
  ): Promise<DeviceView[]> {
    const vistas = entidades.map((d) => toDeviceView(d, warnings));
    const estados = await this.provisioning.estadosDe(vistas.map((v) => v.id));

    for (const vista of vistas) {
      if (vista.provisioning) {
        vista.provisioning.queue = estados.get(vista.id) ?? null;
      }
    }
    return vistas;
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
   *
   * ES ATÓMICA: no vuelve hasta que el provisioner registró la credencial en el
   * broker Y derivó las del portal local. Si algo de eso falla, el equipo se
   * BORRA y nadie queda a medio fabricar.
   *
   * No puede ser una transacción de base y por eso es una compensación: el
   * provisioner no ve la fila encolada hasta el COMMIT, así que esperar adentro
   * de la transacción sería esperar para siempre. Lo que sobrevive al borrado es
   * el `audit_log` — la fila de la cola se va por CASCADE, y un intento fallido
   * sin rastro es un intento que se repite a ciegas.
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

      // Alta CON barrio es CPS instalando directo, y una alarma instalada sin
      // punto en el mapa no se puede monitorear. Lo impone `chk_device_gps`
      // igual; acá se atrapa antes para que el error se entienda.
      if (dto.latitude === undefined || dto.longitude === undefined) {
        throw new BadRequestException(
          'Un equipo que se instala directo necesita su ubicación en el mapa.',
        );
      }
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
        // El testeo ya no se declara en el alta: es un hito POSTERIOR a la
        // primera conexión (la prueba funcional del equipo andando), y marcarlo
        // acá sería afirmar que se probó algo que todavía no habló con nadie.
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

    await this.fabricar(device, createdBy);

    // Se relee porque las columnas que importan —mqtt_provisioned_at y las dos
    // credenciales cifradas— las escribió el PROVISIONER, no esta transacción.
    // La instancia en memoria no las tiene y devolverla sería mostrar un equipo
    // recién fabricado como si le faltara todo.
    const fresco = await this.devices.findOne({
      where: { id: device.id },
      relations: { boardModel: true },
    });

    return this.vista(fresco ?? device, warnings);
  }

  // --- Papelera de equipos --------------------------------------------------

  /** Los removidos, que no aparecen en ningún otro listado. Solo CPS. */
  async findRemoved(scope: AccessScope): Promise<DeviceView[]> {
    if (!scope.global) {
      throw new ForbiddenException('Solo CPS ve los equipos removidos');
    }
    return this.conEstadosDeCola(
      await this.devices.find({
        where: { removedAt: Not(IsNull()) },
        relations: { boardModel: true },
        order: { removedAt: 'DESC' },
      }),
    );
  }

  /**
   * REMOVER: saca el equipo de circulación y revoca su credencial del broker.
   *
   * Si estaba instalado, lo DESVINCULA del barrio (decisión del usuario,
   * 2026-08-05). Eso significa que una acción de la pantalla de fábrica cambia
   * la infraestructura de un barrio sin que se vea desde allá — por eso queda
   * solo para CPS y siempre con `audit_log`.
   *
   * El equipo no se borra: se puede dar de alta de nuevo desde la papelera.
   */
  async remove(
    id: number,
    actor: AuthenticatedUser,
    scope: AccessScope,
  ): Promise<DeviceView> {
    if (!scope.global) {
      throw new ForbiddenException('Solo CPS puede remover equipos');
    }

    const device = await this.findOne(id, scope);
    if (device.removedAt !== null) {
      throw new ConflictException('Ese equipo ya está removido');
    }

    await this.devices.update(id, {
      removedAt: new Date(),
      removedBy: actor.id,
      updatedBy: actor.id,
      // Vuelve al stock de fábrica: el CHECK de custodia exige que todo lo que
      // no está en INVENTORY tenga barrio, así que desvincular y cambiar el
      // estado son la misma operación, no dos.
      neighborhoodId: null,
      status: DeviceStatus.INVENTORY,
      // Una fecha de instalación en un equipo que ya no está instalado no
      // describe nada: la historia de la instalación vive en la bitácora.
      installedAt: null,
    });

    await this.audit.record({
      actorUserId: actor.id,
      action: 'device.remove',
      entityType: 'device',
      entityId: id,
      neighborhoodId: device.neighborhoodId,
      oldValue: {
        serial: device.serial,
        status: device.status,
        neighborhoodId: device.neighborhoodId,
      },
    });

    // La credencial se da de baja SIEMPRE que se remueve: un equipo fuera de
    // circulación con credencial activa es exactamente el olvido invisible que
    // el spec del provisioner quería evitar. Si el provisioner no está, la fila
    // queda pendiente y se toma cuando arranque.
    await this.provisioning.encolar(id, 'revoke', actor.id);

    return this.findOne(id, scope);
  }

  /**
   * REACTIVAR: lo devuelve a circulación y vuelve a pedir su credencial.
   *
   * Vuelve al stock de fábrica, no al barrio donde estaba: reinstalarlo es un
   * claim, con su técnico y sus datos de instalación.
   */
  async restore(
    id: number,
    actor: AuthenticatedUser,
    scope: AccessScope,
  ): Promise<DeviceView> {
    if (!scope.global) {
      throw new ForbiddenException('Solo CPS puede reactivar equipos');
    }

    const device = await this.findOne(id, scope);
    if (device.removedAt === null) {
      throw new ConflictException('Ese equipo no está removido');
    }

    await this.devices.update(id, {
      removedAt: null,
      removedBy: null,
      updatedBy: actor.id,
      // Sin claim code no se puede instalar, y el anterior se imprimió en una
      // etiqueta que puede andar dando vueltas. Uno nuevo.
      claimCode: generateClaimCode(),
    });

    await this.audit.record({
      actorUserId: actor.id,
      action: 'device.restore',
      entityType: 'device',
      entityId: id,
      newValue: { serial: device.serial },
    });

    // Se re-pide la credencial: al remover se revocó, así que sin esto el
    // equipo volvería a la lista sin poder conectarse a nada.
    await this.provisioning.encolar(id, 'provision', actor.id);

    return this.findOne(id, scope);
  }

  /**
   * BORRADO DEFINITIVO. Solo desde la papelera y solo CPS.
   *
   * Se lleva puesto todo lo que cuelgue del equipo, incluida la bitácora de
   * mantenimiento (decisión del usuario, 2026-08-05: `device_maintenance` es ON
   * DELETE CASCADE).
   *
   * Los EVENTOS no: `event.device_id` es ON DELETE RESTRICT porque son
   * append-only. Un equipo que llegó a reportar algo no se borra, y la base lo
   * rechaza. Acá se traduce ese rechazo a algo que se entienda, en vez de dejar
   * salir un 500 con el nombre de una constraint.
   */
  async hardDelete(
    id: number,
    actor: AuthenticatedUser,
    scope: AccessScope,
  ): Promise<{ mensaje: string }> {
    if (!scope.global) {
      throw new ForbiddenException('Solo CPS puede borrar equipos');
    }

    const device = await this.findOne(id, scope);
    if (device.removedAt === null) {
      throw new ConflictException(
        'Primero remové el equipo. El borrado definitivo solo se hace desde la papelera.',
      );
    }

    // El audit_log va ANTES del borrado: `entity_id` no tiene FK, así que la
    // fila sobrevive al equipo y queda el rastro de qué serial se borró.
    await this.audit.record({
      actorUserId: actor.id,
      action: 'device.hard_delete',
      entityType: 'device',
      entityId: id,
      oldValue: {
        serial: device.serial,
        mac: device.mac,
        boardNumber: device.boardNumber,
      },
    });

    try {
      await this.devices.delete(id);
    } catch (e) {
      if (esViolacionDeClaveForanea(e)) {
        throw new ConflictException(
          `No se puede borrar ${device.serial}: tiene eventos registrados, y los ` +
            'eventos no se borran nunca. El equipo se queda en removidos.',
        );
      }
      throw e;
    }

    return { mensaje: `Se borró ${device.serial} definitivamente.` };
  }

  /**
   * La password del usuario `cps` del portal, en claro. SOLO CPS.
   *
   * Endpoint aparte y no un campo más de la ficha porque es la credencial de
   * nivel fábrica: el firmware manda no imprimirla nunca y no tiene por qué
   * viajar cada vez que alguien abre un equipo. Cada lectura deja `audit_log`
   * con quién y cuándo — si algún día aparece publicada, se puede saber por
   * dónde salió.
   */
  async findPortalCps(
    id: number,
    actor: AuthenticatedUser,
    scope: AccessScope,
  ): Promise<{ usuario: 'cps'; password: string }> {
    const device = await this.findOne(id, scope);

    const password = this.portalCrypto.decrypt(device.portalCpsEnc);
    if (!password) {
      throw new NotFoundException(
        'Este equipo no tiene credenciales del portal derivadas, o la clave ' +
          'de cifrado no las puede leer. Re-fabricá la credencial.',
      );
    }

    await this.audit.record({
      actorUserId: actor.id,
      action: 'device.portal.cps.read',
      entityType: 'device',
      entityId: device.id,
      neighborhoodId: device.neighborhoodId,
      newValue: { serial: device.serial },
    });

    return { usuario: 'cps', password };
  }

  /**
   * Encola la fabricación y espera. Si falla, borra el equipo y tira.
   *
   * El `audit_log` se escribe ANTES del borrado a propósito: `entity_id` no
   * tiene FK, así que la fila sobrevive al equipo y queda el rastro de qué MAC
   * se intentó fabricar y por qué no salió.
   */
  private async fabricar(device: Device, actorUserId: number): Promise<void> {
    const timeout = Number(
      this.config.get<number>('PROVISIONING_TIMEOUT_MS') ?? 30_000,
    );

    let queueId: number;
    try {
      queueId = await this.provisioning.encolar(
        device.id,
        'manufacture',
        actorUserId,
      );
    } catch (e) {
      await this.deshacerFabricacion(device, actorUserId, (e as Error).message);
      throw new ConflictException(
        `No se pudo pedir la fabricación: ${(e as Error).message}`,
      );
    }

    const resultado = await this.provisioning.esperar(queueId, timeout);

    if (resultado?.estado === 'done') return;

    const motivo =
      resultado === null
        ? `el provisioner no contestó en ${Math.round(timeout / 1000)} s`
        : (resultado.detalle ?? 'sin detalle');

    await this.deshacerFabricacion(device, actorUserId, motivo);

    // 503 y no 500: no es un error de la web, es que el servicio del que
    // depende no está. El operador puede reintentar el mismo equipo tal cual.
    throw new ServiceUnavailableException(
      `No se fabricó el equipo: ${motivo}. No quedó nada a medias — ` +
        `revisá que el provisioner esté corriendo y volvé a intentar.`,
    );
  }

  private async deshacerFabricacion(
    device: Device,
    actorUserId: number,
    motivo: string,
  ): Promise<void> {
    await this.audit.record({
      actorUserId,
      action: 'device.manufacture.failed',
      entityType: 'device',
      entityId: device.id,
      neighborhoodId: device.neighborhoodId,
      oldValue: { serial: device.serial, mac: device.mac, motivo },
    });

    // La fila de la cola se va con él (ON DELETE CASCADE). Si el provisioner
    // alcanzó a escribir en el broker, la credencial queda huérfana: la limpia
    // el barrido del provisioner al arrancar.
    await this.devices.delete(device.id);
  }

  /**
   * CLAIM: instalar el equipo en un barrio, con serial + código.
   *
   * Lo que gobierna NO es el código —que es siempre el mismo y nunca se quema—
   * sino DE QUIÉN ES el equipo (2026-08-05):
   *
   *   sin dueño (fábrica CPS)  cualquiera que tenga el código lo reclama
   *   de una organización      solo esa organización, o CPS a un barrio de ella
   *   instalado                nadie: ya está en servicio
   *
   * Esa es la regla que impide que alguien fotografíe la etiqueta de un equipo
   * ajeno y se lo lleve. Antes el corte lo daba el código, que se quemaba al
   * instalar; ahora lo da la propiedad, que es lo que de verdad describe quién
   * puede disponer del equipo.
   */
  async claim(
    dto: ClaimDeviceDto,
    actor: AuthenticatedUser,
    scope: AccessScope,
  ): Promise<DeviceView> {
    const device = await this.reclamable(dto.serial, dto.claimCode);

    const barrio = await this.neighborhoods.findOne({
      where: { id: dto.neighborhoodId },
    });
    if (!barrio) {
      throw new NotFoundException(`No existe el barrio ${dto.neighborhoodId}`);
    }
    this.assertNeighborhoodInScope(scope, dto.neighborhoodId);

    this.assertPuedeDisponer(device, barrio.organizationId, actor);

    await this.devices.update(device.id, {
      status: DeviceStatus.OPERATIONAL,
      neighborhoodId: dto.neighborhoodId,
      organizationId: null, // instalado: ya no es stock de nadie
      // El código NO se quema (2026-08-05): el equipo puede volver al stock si
      // se remueve, y sin código no habría forma de volver a reclamarlo. Lo que
      // impide que un tercero se lo lleve no es el código sino la propiedad.
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
   * ADOPTAR: sumar un equipo al stock propio con serial + código.
   *
   * Es el otro uso del código, además de instalar: la muni recibe una caja,
   * carga el código y el equipo pasa a su inventario sin instalarse todavía.
   *
   * Solo funciona sobre equipos SIN DUEÑO. Un equipo que ya es de alguien no se
   * adopta: o se lo entrega CPS, o no se mueve.
   *
   * Convive con la entrega de lotes y no la reemplaza: la entrega es para el
   * despacho de 50 equipos que todavía no llegaron, esto es para la caja que
   * alguien tiene en la mano.
   */
  async adopt(
    dto: AdoptDeviceDto,
    actor: AuthenticatedUser,
  ): Promise<DeviceView> {
    const device = await this.reclamable(dto.serial, dto.claimCode);

    if (device.organizationId !== null) {
      throw new ConflictException(
        'Ese equipo ya está en el stock de una organización. Si tiene que ' +
          'cambiar de manos, la entrega la hace CPS.',
      );
    }

    const organizationId = this.resolverOrganizacionDestino(actor, dto);

    await this.devices.update(device.id, {
      organizationId,
      updatedBy: actor.id,
    });

    await this.audit.record({
      actorUserId: actor.id,
      action: 'device.adopt',
      entityType: 'device',
      entityId: device.id,
      accountId: organizationId,
      oldValue: { organizationId: null },
      newValue: { organizationId, serial: device.serial },
    });

    // No pasa por `findOne`: ese exige alcance global para ver un equipo de
    // inventario, y quien acaba de adoptarlo puede no ser de CPS. El derecho
    // sobre este equipo ya se validó arriba.
    return this.vista(
      await this.devices.findOneOrFail({
        where: { id: device.id },
        relations: { boardModel: true },
      }),
    );
  }

  /**
   * A qué stock va el equipo adoptado.
   *
   * Una persona de una organización lo suma a la suya y no hay nada que elegir.
   * CPS sí tiene que decirlo: su propio stock ES el de fábrica, así que adoptar
   * "para CPS" no significaría nada — lo hace en nombre de un cliente.
   */
  private resolverOrganizacionDestino(
    actor: AuthenticatedUser,
    dto: AdoptDeviceDto,
  ): number {
    const propias = actor.memberships
      .filter((m) => m.accountType === AccountType.ORGANIZATION)
      .map((m) => m.accountId);

    if (dto.organizationId !== undefined) {
      const esCps = actor.memberships.some(
        (m) => m.accountType === AccountType.COMPANY,
      );
      if (!esCps && !propias.includes(dto.organizationId)) {
        throw new ForbiddenException(
          'No podés sumar equipos al stock de otra organización',
        );
      }
      return dto.organizationId;
    }

    if (propias.length === 1) return propias[0];
    if (propias.length === 0) {
      throw new BadRequestException(
        'Sos de CPS: decí a qué organización va el equipo. El stock de CPS es ' +
          'la fábrica, y ahí ya está.',
      );
    }
    throw new BadRequestException(
      'Pertenecés a más de una organización: decí a cuál va el equipo.',
    );
  }

  /**
   * Un equipo que se puede reclamar con ese código, o el error que explique por
   * qué no. Compartido por instalar y adoptar: las dos puertas usan el código y
   * las dos tienen que rechazar lo mismo.
   */
  private async reclamable(serial: string, claimCode: string): Promise<Device> {
    const device = await this.devices.findOne({ where: { serial } });

    if (!device) {
      throw new NotFoundException(
        `No hay ningún equipo con el serial ${serial}`,
      );
    }
    if (device.removedAt !== null) {
      throw new ConflictException(
        'Ese equipo está removido. Hay que reactivarlo antes de usarlo.',
      );
    }
    if (device.status !== DeviceStatus.INVENTORY) {
      throw new ConflictException(
        'Ese equipo ya está instalado. Para moverlo hay que removerlo primero.',
      );
    }
    if (!device.claimCode || device.claimCode !== claimCode) {
      throw new ForbiddenException('El código de reclamo no corresponde');
    }

    return device;
  }

  /**
   * ¿Puede este usuario disponer del equipo para ESE destino?
   *
   * `destinoOrganizationId` es de quién es el barrio donde se va a instalar.
   *
   * - Sin dueño: cualquiera. Es la primera reclamación y es lo que permite que
   *   una muni ponga en servicio la caja que le llegó sin esperar a que CPS
   *   haga la entrega en el sistema.
   * - Con dueño: solo esa organización, o CPS. Y CPS solo hacia un barrio de
   *   ESA organización — pasar un equipo del cliente A a la infraestructura del
   *   cliente B sería una entrega encubierta, sin registro comercial.
   */
  private assertPuedeDisponer(
    device: Device,
    destinoOrganizationId: number | null,
    actor: AuthenticatedUser,
  ): void {
    const motivo = motivoParaNoDisponer({
      stockDelEquipo: device.organizationId,
      duenoDelBarrio: destinoOrganizationId,
      esCps: actor.memberships.some(
        (m) => m.accountType === AccountType.COMPANY,
      ),
      organizacionesPropias: actor.memberships
        .filter((m) => m.accountType === AccountType.ORGANIZATION)
        .map((m) => m.accountId),
    });

    if (motivo) throw new ForbiddenException(motivo);
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
    }

    await this.devices.update(id, {
      name: dto.name ?? device.name,
      status: dto.status ?? device.status,
      organizationId:
        dto.organizationId !== undefined
          ? dto.organizationId
          : device.organizationId,
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

    if (dto.tested !== undefined) {
      cambios.testedAt = dto.tested ? now : null;
      cambios.testedBy = dto.tested ? actorId : null;
    }

    if (dto.ready !== undefined) {
      cambios.readyAt = dto.ready ? now : null;
      cambios.readyBy = dto.ready ? actorId : null;
    }

    await this.devices.update(id, cambios);

    // LISTO se audita porque es el visto bueno para que el equipo salga de
    // fábrica: si después aparece uno fallado en la calle, hay que poder saber
    // quién lo aprobó. Etiquetar y testear son rutina y no lo necesitan.
    if (dto.ready !== undefined) {
      await this.audit.record({
        actorUserId: actorId,
        action: dto.ready ? 'device.ready' : 'device.ready.clear',
        entityType: 'device',
        entityId: id,
        oldValue: { readyAt: device.readyAt },
        newValue: { readyAt: cambios.readyAt },
      });
    }

    // Se audita el override de la conexión: afirmar a mano que un equipo
    // conectó es sustituir una medición por un criterio humano, y eso tiene
    // que dejar rastro.
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

/**
 * Postgres usa DOS códigos para esto y hay que mirar los dos.
 *
 * `23503` es `foreign_key_violation`, el genérico. Pero un `ON DELETE RESTRICT`
 * —que es justo lo que tiene `event.device_id`— levanta `23001`,
 * `restrict_violation`, que es otro código. Mirando solo el primero, borrar un
 * equipo con eventos se escapaba como un 500 con el nombre de una constraint
 * adentro en vez del mensaje que explica qué pasó. Verificado contra la base.
 *
 * Se mira el código y no el mensaje porque el mensaje viene en el idioma del
 * servidor y cambia entre versiones; el código es parte del contrato de SQL.
 */
function esViolacionDeClaveForanea(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === '23503' || code === '23001';
}

/** Quién puede disponer de un equipo, y por qué no. Ver `assertPuedeDisponer`. */
export interface DisposicionDeEquipo {
  /** De qué stock es el equipo. `null` = fábrica CPS, sin dueño. */
  stockDelEquipo: number | null;
  /** De quién es el barrio donde se va a instalar. */
  duenoDelBarrio: number | null;
  esCps: boolean;
  organizacionesPropias: number[];
}

/**
 * La regla de propiedad, sin Nest ni base de datos.
 *
 * Devuelve el motivo del rechazo, o `null` si puede. Es una función aparte y
 * pura porque es LA regla del flujo de instalación —quién puede llevarse qué
 * equipo a dónde— y una regla así tiene que poder probarse sola, sin levantar
 * media aplicación para averiguar qué pasa con el stock de un tercero.
 */
export function motivoParaNoDisponer(d: DisposicionDeEquipo): string | null {
  // SIN DUEÑO: cualquiera con el código. Es la primera reclamación, y es lo que
  // permite que una muni ponga en servicio la caja que le llegó sin esperar a
  // que CPS haga la entrega en el sistema.
  if (d.stockDelEquipo === null) return null;

  if (d.esCps) {
    // CPS puede usar el stock de un cliente, pero solo PARA ese cliente: pasar
    // un equipo del cliente A a la infraestructura del cliente B sería una
    // entrega encubierta, sin registro comercial.
    if (d.duenoDelBarrio !== d.stockDelEquipo) {
      return (
        'Ese equipo es del stock de otro cliente. Para usarlo en este barrio ' +
        'hay que entregarlo primero.'
      );
    }
    return null;
  }

  if (!d.organizacionesPropias.includes(d.stockDelEquipo)) {
    return 'Ese equipo está en el stock de otra organización.';
  }

  return null;
}
