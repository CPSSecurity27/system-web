import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/auth.service';
import { AuditService } from '../common/audit.service';
import { AccountType, DeviceStatus, MaintenanceStatus } from '../common/enums';
import { AccessScope } from '../common/scope.service';
import { Home } from '../homes/entities/home.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
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
    private readonly audit: AuditService,
  ) {}

  /** Instaladas en barrios del alcance. El inventario va por /devices/inventory. */
  async findAll(
    scope: AccessScope,
    neighborhoodId?: number,
  ): Promise<Device[]> {
    const barrios = await this.neighborhoodsInScope(scope);

    if (neighborhoodId) {
      this.assertNeighborhood(scope, barrios, neighborhoodId);
      return this.devices.find({
        where: { neighborhoodId },
        order: { name: 'ASC' },
      });
    }

    if (scope.global) {
      return this.devices.find({
        where: { status: In(nonInventoryStatuses()) },
        order: { name: 'ASC' },
      });
    }
    if (barrios.length === 0) return [];

    return this.devices.find({
      where: { neighborhoodId: In(barrios) },
      order: { name: 'ASC' },
    });
  }

  /**
   * El stock: CPS ve todo el inventario (fábrica + stocks de clientes); una
   * organización ve SOLO su propio stock.
   */
  findInventory(actor: AuthenticatedUser): Promise<Device[]> {
    const esCps = actor.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );
    if (esCps) {
      return this.devices.find({
        where: { status: DeviceStatus.INVENTORY },
        order: { id: 'ASC' },
      });
    }

    const orgIds = actor.memberships
      .filter((m) => m.accountType === AccountType.ORGANIZATION)
      .map((m) => m.accountId);
    if (orgIds.length === 0) return Promise.resolve([]);

    return this.devices.find({
      where: { status: DeviceStatus.INVENTORY, organizationId: In(orgIds) },
      order: { id: 'ASC' },
    });
  }

  async findOne(id: number, scope: AccessScope): Promise<Device> {
    const device = await this.devices.findOne({ where: { id } });
    if (!device) throw new NotFoundException(`No existe el dispositivo ${id}`);

    if (device.neighborhoodId === null) {
      // Inventario: solo CPS lo ve por acá (el stock de una org va por /inventory).
      if (!scope.global) {
        throw new ForbiddenException('No tenés acceso a este dispositivo');
      }
      return device;
    }

    const barrios = await this.neighborhoodsInScope(scope);
    this.assertNeighborhood(scope, barrios, device.neighborhoodId);

    return device;
  }

  /** Estado vivo (lo escribe el servicio de alarmas; la web solo lee). */
  async findState(id: number, scope: AccessScope): Promise<DeviceState | null> {
    await this.findOne(id, scope);
    return this.states.findOne({ where: { deviceId: id } });
  }

  /**
   * Alta: SOLO CPS. El equipo nace en INVENTORY con claim code (o directamente
   * instalado si viene neighborhoodId: es CPS instalando en el momento).
   */
  async create(dto: CreateDeviceDto, createdBy: number): Promise<Device> {
    const yaExiste = await this.devices.findOne({
      where: { serial: dto.serial },
    });
    if (yaExiste) {
      throw new ConflictException(
        `Ya existe un dispositivo con el serial "${dto.serial}"`,
      );
    }

    if (dto.neighborhoodId) {
      await this.assertNeighborhoodExists(dto.neighborhoodId);
    }
    if (dto.organizationId && dto.neighborhoodId) {
      throw new BadRequestException(
        'Un equipo instalado no tiene stock: mandá organizationId O neighborhoodId',
      );
    }

    const device = await this.devices.save(
      this.devices.create({
        name: dto.name ?? null,
        serial: dto.serial,
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
        mac: dto.mac ?? null,
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
      newValue: { serial: device.serial, status: device.status },
    });

    return device;
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
  ): Promise<Device> {
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

    return this.devices.findOneOrFail({ where: { id: device.id } });
  }

  /**
   * El `serial` NO se puede cambiar: es la identidad física del equipo. Mover
   * stock de fábrica a una organización ("entrega del lote") también pasa por
   * acá (organizationId, solo mientras está en INVENTORY — el CHECK lo cuida).
   */
  async update(
    id: number,
    dto: UpdateDeviceDto,
    scope: AccessScope,
    updatedBy: number,
  ): Promise<Device> {
    const device = await this.findOne(id, scope);

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
      updatedBy,
    });

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
