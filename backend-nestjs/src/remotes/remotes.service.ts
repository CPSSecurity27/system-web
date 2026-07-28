import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/auth.service';
import { AuditService } from '../common/audit.service';
import { AccountType, RemoteStatus } from '../common/enums';
import { CryptoService } from '../common/crypto.service';
import { AccessScope, ScopeService } from '../common/scope.service';
import { Device } from '../devices/entities/device.entity';
import { HomeMember } from '../homes/entities/home-member.entity';
import { Home } from '../homes/entities/home.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import {
  AddRemoteCodeDto,
  AssignRemoteDto,
  CreateRemoteDto,
  UpdateRemoteDto,
} from './dto/remote.dto';
import { RemoteCode } from './entities/remote-code.entity';
import { Remote } from './entities/remote.entity';

/** Vista de un código SIN el valor: es lo que ve cualquiera que no sea CPS. */
export interface RemoteCodeSummary {
  id: number;
  position: number;
  createdAt: Date;
}

/**
 * Controles remotos (v2): cadena de custodia fábrica -> stock org -> hogar,
 * y dentro del hogar DUEÑO (la vivienda) != PORTADOR (el usuario).
 *
 * Invariantes de servicio:
 *  - El portador pertenece al HOGAR (home_member) — ya no via cuentas.
 *  - La alarma del control es del mismo barrio que la vivienda.
 *  - Alta bloqueada si el barrio no tiene controles habilitados (CUPO §5.2,
 *    vive en neighborhood — ya no en el contrato).
 */
@Injectable()
export class RemotesService {
  private readonly logger = new Logger(RemotesService.name);

  constructor(
    @InjectRepository(Remote) private readonly remotes: Repository<Remote>,
    @InjectRepository(RemoteCode)
    private readonly codes: Repository<RemoteCode>,
    @InjectRepository(Home) private readonly homes: Repository<Home>,
    @InjectRepository(HomeMember)
    private readonly members: Repository<HomeMember>,
    @InjectRepository(Neighborhood)
    private readonly neighborhoods: Repository<Neighborhood>,
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    private readonly scopes: ScopeService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async findAll(scope: AccessScope, homeId?: number): Promise<Remote[]> {
    if (homeId) {
      const home = await this.getHome(homeId);
      this.scopes.assertHome(scope, homeId, home.neighborhoodId);
      return this.remotes.find({
        where: { homeId },
        relations: { assignedToUser: true },
        order: { id: 'ASC' },
      });
    }

    if (scope.global) {
      return this.remotes.find({
        relations: { assignedToUser: true },
        order: { id: 'ASC' },
      });
    }

    // Las viviendas que alcanza: la suya, o todas las de su barrio si gestiona.
    const homes = await this.homesInScope(scope);
    if (homes.length === 0) return [];

    return this.remotes.find({
      where: { homeId: In(homes) },
      relations: { assignedToUser: true },
      order: { id: 'ASC' },
    });
  }

  /** El stock de controles: CPS todo; una organización solo el suyo. */
  findInventory(actor: AuthenticatedUser): Promise<Remote[]> {
    const esCps = actor.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );
    if (esCps) {
      return this.remotes.find({
        where: { status: RemoteStatus.INVENTORY },
        order: { id: 'ASC' },
      });
    }

    const orgIds = actor.memberships
      .filter((m) => m.accountType === AccountType.ORGANIZATION)
      .map((m) => m.accountId);
    if (orgIds.length === 0) return Promise.resolve([]);

    return this.remotes.find({
      where: { status: RemoteStatus.INVENTORY, organizationId: In(orgIds) },
      order: { id: 'ASC' },
    });
  }

  async findOne(id: number, scope: AccessScope): Promise<Remote> {
    const remote = await this.remotes.findOne({
      where: { id },
      relations: { assignedToUser: true },
    });
    if (!remote) throw new NotFoundException(`No existe el control ${id}`);

    if (remote.homeId === null) {
      // Inventario: solo CPS por esta vía.
      if (!scope.global) {
        throw new ForbiddenException('No tenés acceso a este control');
      }
      return remote;
    }

    const home = await this.getHome(remote.homeId);
    this.scopes.assertHome(scope, remote.homeId, home.neighborhoodId);

    return remote;
  }

  /**
   * Alta. Con homeId: control del hogar (CPS o gestor del barrio). Sin homeId:
   * stock (SOLO CPS; organizationId opcional = entrega directa del lote).
   */
  async create(
    dto: CreateRemoteDto,
    scope: AccessScope,
    createdBy: number,
  ): Promise<Remote> {
    if (!dto.homeId) {
      if (!scope.global) {
        throw new ForbiddenException('Solo CPS carga controles al inventario');
      }
      return this.remotes.save(
        this.remotes.create({
          name: dto.name,
          status: RemoteStatus.INVENTORY,
          organizationId: dto.organizationId ?? null,
          createdBy,
        }),
      );
    }

    const home = await this.getHome(dto.homeId);
    this.scopes.assertHome(scope, dto.homeId, home.neighborhoodId);

    // El CUPO manda: si el barrio no incluye controles, no se dan de alta.
    await this.assertRemotesEnabled(home.neighborhoodId);

    if (dto.assignedToUserId) {
      await this.assertUserBelongsToHome(dto.homeId, dto.assignedToUserId);
    }
    if (dto.deviceId) {
      await this.assertDeviceInSameNeighborhood(dto.deviceId, home);
    }

    return this.remotes.save(
      this.remotes.create({
        name: dto.name,
        homeId: dto.homeId,
        assignedToUserId: dto.assignedToUserId ?? null,
        deviceId: dto.deviceId ?? null,
        status: RemoteStatus.ACTIVE,
        createdBy,
      }),
    );
  }

  /**
   * Asignar un control del STOCK a una vivienda (la entrega física). A partir
   * de acá la vivienda es dueña y el homeId no se toca más.
   */
  async assign(
    id: number,
    dto: AssignRemoteDto,
    actor: AuthenticatedUser,
    scope: AccessScope,
  ): Promise<Remote> {
    const remote = await this.remotes.findOne({ where: { id } });
    if (!remote) throw new NotFoundException(`No existe el control ${id}`);
    if (remote.status !== RemoteStatus.INVENTORY || remote.homeId !== null) {
      throw new BadRequestException(
        'Ese control ya pertenece a una vivienda: el dueño no se cambia',
      );
    }

    const home = await this.getHome(dto.homeId);
    this.scopes.assertHome(scope, dto.homeId, home.neighborhoodId);
    await this.assertRemotesEnabled(home.neighborhoodId);

    const esCps = actor.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );
    if (!esCps) {
      // Solo del stock de la organización dueña del barrio de la vivienda.
      const barrio = await this.neighborhoods.findOneOrFail({
        where: { id: home.neighborhoodId },
      });
      if (remote.organizationId !== barrio.organizationId) {
        throw new ForbiddenException(
          'Ese control no está en el stock de tu organización',
        );
      }
    }

    await this.remotes.update(id, {
      status: RemoteStatus.ACTIVE,
      homeId: dto.homeId,
      organizationId: null, // entregado: ya no es stock
      updatedBy: actor.id,
    });

    await this.audit.record({
      actorUserId: actor.id,
      action: 'remote.assign',
      entityType: 'remote',
      entityId: id,
      neighborhoodId: home.neighborhoodId,
      oldValue: {
        status: RemoteStatus.INVENTORY,
        organizationId: remote.organizationId,
      },
      newValue: { status: RemoteStatus.ACTIVE, homeId: dto.homeId },
    });

    return this.remotes.findOneOrFail({ where: { id } });
  }

  /**
   * El `homeId` NO se puede cambiar: la vivienda es DUEÑA del control. Lo que
   * sí se reasigna libremente es el PORTADOR (assignedToUserId).
   */
  async update(
    id: number,
    dto: UpdateRemoteDto,
    scope: AccessScope,
    updatedBy: number,
  ): Promise<Remote> {
    const remote = await this.findOne(id, scope);

    if (dto.assignedToUserId !== undefined && dto.assignedToUserId !== null) {
      if (remote.homeId === null) {
        throw new BadRequestException(
          'Un control en stock no tiene portador: asignalo a una vivienda primero',
        );
      }
      await this.assertUserBelongsToHome(remote.homeId, dto.assignedToUserId);
    }
    if (dto.deviceId && remote.homeId !== null) {
      const home = await this.getHome(remote.homeId);
      await this.assertDeviceInSameNeighborhood(dto.deviceId, home);
    }

    await this.remotes.update(id, {
      name: dto.name ?? remote.name,
      status: dto.status ?? remote.status,
      // `null` explícito = desasignar. `undefined` = no tocar. Por eso no se usa ??
      assignedToUserId:
        dto.assignedToUserId !== undefined
          ? dto.assignedToUserId
          : remote.assignedToUserId,
      deviceId: dto.deviceId !== undefined ? dto.deviceId : remote.deviceId,
      updatedBy,
    });

    return this.findOne(id, scope);
  }

  // --- Códigos RF (SENSIBLE) -------------------------------------------------

  /**
   * Lista los códigos SIN el valor: solo posición y fecha. Es lo que puede ver
   * el titular — cuántos códigos tiene grabados, no cuáles son.
   */
  async findCodes(
    remoteId: number,
    scope: AccessScope,
  ): Promise<RemoteCodeSummary[]> {
    await this.findOne(remoteId, scope);

    const codes = await this.codes.find({
      where: { remoteId },
      order: { position: 'ASC' },
    });

    return codes.map((c) => ({
      id: c.id,
      position: c.position,
      createdAt: c.createdAt,
    }));
  }

  /**
   * Graba un código RF. Se cifra con AES-256-GCM ANTES de tocar la base.
   * El tope de 4 por control (M2) lo impone el ESQUEMA, no un if acá.
   */
  async addCode(
    remoteId: number,
    dto: AddRemoteCodeDto,
    scope: AccessScope,
  ): Promise<RemoteCodeSummary> {
    await this.findOne(remoteId, scope);

    const ocupada = await this.codes.findOne({
      where: { remoteId, position: dto.position },
    });
    if (ocupada) {
      throw new BadRequestException(
        `La posición ${dto.position} ya tiene un código. Borralo primero.`,
      );
    }

    const code = await this.codes.save(
      this.codes.create({
        remoteId,
        position: dto.position,
        codeEncrypted: this.crypto.encrypt(dto.code),
      }),
    );

    // El código en claro NUNCA se loguea. Ni acá ni en ningún lado.
    this.logger.log(
      `Código grabado en el control ${remoteId}, posición ${dto.position}`,
    );

    return { id: code.id, position: code.position, createdAt: code.createdAt };
  }

  /**
   * Descifra y devuelve el código EN CLARO. La única función del sistema que lo
   * hace; solo CPS. Cada llamada queda en el log Y en audit_log (D9).
   */
  async revealCode(
    remoteId: number,
    codeId: number,
    actorUserId: number,
  ): Promise<{ position: number; code: string }> {
    const code = await this.codes.findOne({
      where: { id: codeId, remoteId },
      // codeEncrypted tiene select:false: hay que pedirlo explícito.
      select: { id: true, position: true, codeEncrypted: true },
    });
    if (!code) {
      throw new NotFoundException(
        `No existe el código ${codeId} en el control ${remoteId}`,
      );
    }

    this.logger.warn(
      `Código RF revelado: control ${remoteId}, posición ${code.position}`,
    );
    await this.audit.record({
      actorUserId,
      action: 'remote_code.reveal',
      entityType: 'remote_code',
      entityId: codeId,
      metadata: { remoteId, position: code.position },
    });

    try {
      return {
        position: code.position,
        code: this.crypto.decrypt(code.codeEncrypted),
      };
    } catch {
      // GCM es cifrado AUTENTICADO: si el descifrado falla, el dato fue
      // ALTERADO o la clave cambió. Es un incidente, no un bug cualquiera.
      this.logger.error(
        `INTEGRIDAD: el código ${codeId} del control ${remoteId} no se puede ` +
          `descifrar. O fue alterado en la base, o REMOTE_CODES_KEY cambió.`,
      );
      throw new InternalServerErrorException(
        'El código guardado está corrupto o la clave de cifrado no corresponde. ' +
          'Hay que reprogramar el control.',
      );
    }
  }

  async removeCode(
    remoteId: number,
    codeId: number,
    scope: AccessScope,
  ): Promise<void> {
    await this.findOne(remoteId, scope);

    const code = await this.codes.findOne({ where: { id: codeId, remoteId } });
    if (!code) {
      throw new NotFoundException(
        `No existe el código ${codeId} en el control ${remoteId}`,
      );
    }

    await this.codes.delete(codeId);
  }

  // --- Invariantes -----------------------------------------------------------

  /**
   * El portador debe ser MIEMBRO del hogar (v2: home_member, ya no cuentas).
   * Sin esto, le asignarías el control de una casa a un vecino de otro barrio.
   */
  private async assertUserBelongsToHome(
    homeId: number,
    userId: number,
  ): Promise<void> {
    const pertenece = await this.members.findOne({
      where: { homeId, userId },
    });
    if (!pertenece) {
      throw new BadRequestException(
        'El usuario no es miembro de esta vivienda',
      );
    }
  }

  /** CUPO del barrio (§5.2): habilita o no los controles. Vive en neighborhood. */
  private async assertRemotesEnabled(neighborhoodId: number): Promise<void> {
    const barrio = await this.neighborhoods.findOne({
      where: { id: neighborhoodId },
    });
    if (!barrio) {
      throw new NotFoundException(`No existe el barrio ${neighborhoodId}`);
    }
    if (!barrio.remoteControlsEnabled) {
      throw new BadRequestException(
        'Este barrio no tiene controles remotos habilitados. Para incluirlos, contactá a CPS.',
      );
    }
  }

  /**
   * La alarma donde se graba el control tiene que ser del MISMO barrio que la
   * vivienda: el RF no llega a otro barrio, y si llegara sería peor.
   */
  private async assertDeviceInSameNeighborhood(
    deviceId: number,
    home: Home,
  ): Promise<void> {
    const device = await this.devices.findOne({ where: { id: deviceId } });
    if (!device) {
      throw new NotFoundException(`No existe el dispositivo ${deviceId}`);
    }
    if (device.neighborhoodId !== home.neighborhoodId) {
      throw new BadRequestException(
        'Esa alarma es de otro barrio: no se puede grabar este control en ella',
      );
    }
  }

  private async getHome(id: number): Promise<Home> {
    const home = await this.homes.findOne({ where: { id } });
    if (!home) throw new NotFoundException(`No existe la vivienda ${id}`);
    return home;
  }

  private async homesInScope(scope: AccessScope): Promise<number[]> {
    const ids = new Set(scope.homeIds);

    if (scope.neighborhoodIds.length > 0) {
      const homes = await this.homes.find({
        where: { neighborhoodId: In(scope.neighborhoodIds) },
        select: { id: true },
      });
      for (const home of homes) ids.add(home.id);
    }

    return [...ids];
  }
}
