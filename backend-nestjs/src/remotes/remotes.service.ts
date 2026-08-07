import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/auth.service';
import { AuditService } from '../common/audit.service';
import { AccountType, RemoteStatus } from '../common/enums';
import { CryptoService } from '../common/crypto.service';
import { AccessScope, ScopeService } from '../common/scope.service';
import { Account } from '../accounts/entities/account.entity';
import { Device } from '../devices/entities/device.entity';
import { HomeMember } from '../homes/entities/home-member.entity';
import { Home } from '../homes/entities/home.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import {
  AddRemoteCodeDto,
  AdoptRemoteDto,
  AssignRemoteDto,
  CreateRemoteDto,
  DeliverRemotesDto,
  FindRemotesQuery,
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
 * Una página de controles. Cada item viene con `home`, `home.neighborhood`,
 * `home.neighborhood.organization` y `assignedToUser` PARCIALES: solo las
 * columnas que la tabla muestra.
 */
export interface PagedRemotes {
  items: Remote[];
  total: number;
  limit: number;
  offset: number;
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
    // La entrega y la adopción validan que el destino sea una ORGANIZATION.
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly scopes: ScopeService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Los controles ENTREGADOS, filtrados y paginados.
   *
   * Solo los que están en una vivienda: el stock tiene su propia pantalla
   * (`findInventory`) y sus filas no tienen ni barrio ni cliente ni portador, o
   * sea nada de lo que esta pantalla filtra. Los removidos tampoco salen —el
   * `removed_at` los saca de todas las listas, y hasta ahora esta se lo salteaba.
   *
   * ## Por qué QueryBuilder y no `find()`
   *
   * La pantalla necesita cliente, barrio, dirección y DNI del portador en cada
   * fila. Con `find()` eso se resolvía bajando TODAS las viviendas al front para
   * traducir `homeId -> dirección`, y con 12.000 controles eso no termina más.
   * Acá los joins traen solo las columnas que la tabla muestra: nada de entidades
   * enteras (el `passwordHash` del portador ni se nombra).
   *
   * ## El alcance se INTERSECTA, nunca se ensancha
   *
   * Los filtros se aplican ENCIMA de la condición de alcance. Pedir el barrio de
   * otro cliente no devuelve 403 sino vacío: decir "existe pero no lo ves" ya es
   * contar algo.
   */
  async findAll(
    scope: AccessScope,
    query: FindRemotesQuery,
  ): Promise<PagedRemotes> {
    const { limit, offset } = query;
    const vacio: PagedRemotes = { items: [], total: 0, limit, offset };

    // Sin barrios ni viviendas no hay nada que ver: la consulta daría vacío
    // igual, pero un `IN ()` de TypeORM con array vacío es un error de SQL.
    if (
      !scope.global &&
      scope.neighborhoodIds.length === 0 &&
      scope.homeIds.length === 0
    ) {
      return vacio;
    }

    const qb = this.remotes
      .createQueryBuilder('remote')
      .innerJoin('remote.home', 'home')
      .addSelect([
        'home.id',
        'home.address',
        'home.neighborhoodId',
        'home.defaultDeviceId',
      ])
      .innerJoin('home.neighborhood', 'barrio')
      .addSelect(['barrio.id', 'barrio.name', 'barrio.organizationId'])
      .innerJoin('barrio.organization', 'cliente')
      .addSelect(['cliente.id', 'cliente.name', 'cliente.subtype'])
      .leftJoin('remote.assignedToUser', 'portador')
      .addSelect(['portador.id', 'portador.name', 'portador.dni'])
      .where('remote.removed_at IS NULL');

    if (!scope.global) {
      // La suya, o todas las de su barrio si gestiona. Se resuelve en el SQL:
      // bajar los ids de vivienda para armar un IN de miles era la versión vieja.
      const partes: string[] = [];
      if (scope.neighborhoodIds.length > 0) {
        partes.push('home.neighborhood_id IN (:...barriosDelAlcance)');
        qb.setParameter('barriosDelAlcance', scope.neighborhoodIds);
      }
      if (scope.homeIds.length > 0) {
        partes.push('remote.home_id IN (:...casasDelAlcance)');
        qb.setParameter('casasDelAlcance', scope.homeIds);
      }
      qb.andWhere(`(${partes.join(' OR ')})`);
    }

    if (query.organizationId) {
      qb.andWhere('barrio.organization_id = :organizationId', {
        organizationId: query.organizationId,
      });
    }
    if (query.neighborhoodId) {
      qb.andWhere('home.neighborhood_id = :neighborhoodId', {
        neighborhoodId: query.neighborhoodId,
      });
    }
    if (query.homeId) {
      qb.andWhere('remote.home_id = :homeId', { homeId: query.homeId });
    }
    if (query.defaultDeviceId) {
      qb.andWhere('home.default_device_id = :defaultDeviceId', {
        defaultDeviceId: query.defaultDeviceId,
      });
    }
    if (query.status) {
      qb.andWhere('remote.status = :status', { status: query.status });
    }

    const q = query.q?.trim();
    if (q) {
      // Un solo buscador para las cuatro formas de nombrar un control: por su
      // etiqueta (serial), por dónde vive (dirección) o por quién lo lleva
      // (nombre o DNI). El DNI se compara sin puntos: en la base va limpio,
      // pero el que busca lo escribe como se lo dictaron.
      const patron = `%${q.toLowerCase()}%`;
      const soloDigitos = q.replace(/\D/g, '');
      qb.andWhere(
        `(LOWER(remote.serial) LIKE :patron
          OR LOWER(remote.name) LIKE :patron
          OR LOWER(home.address) LIKE :patron
          OR LOWER(portador.name) LIKE :patron
          ${soloDigitos ? 'OR portador.dni LIKE :dni' : ''})`,
        soloDigitos ? { patron, dni: `%${soloDigitos}%` } : { patron },
      );
    }

    // Barrio -> dirección -> serial: los controles de una misma casa caen
    // juntos, que es la lectura agrupada sin pagar el precio de un acordeón.
    const [items, total] = await qb
      .orderBy('barrio.name', 'ASC')
      .addOrderBy('home.address', 'ASC')
      .addOrderBy('remote.serial', 'ASC')
      .addOrderBy('remote.id', 'ASC')
      .take(limit)
      .skip(offset)
      .getManyAndCount();

    return { items, total, limit, offset };
  }

  /** El stock de controles: CPS todo; una organización solo el suyo. */
  findInventory(actor: AuthenticatedUser): Promise<Remote[]> {
    const esCps = actor.memberships.some(
      (m) => m.accountType === AccountType.COMPANY,
    );
    // Solo los que tienen el visto bueno de fábrica. Un control recién
    // fabricado ya está en INVENTORY —el CHECK de custodia lo exige mientras no
    // tenga vivienda— así que sin este filtro aparecería en el stock antes de
    // tener los códigos grabados, y alguien podría entregar un llavero que
    // todavía no es nada.
    if (esCps) {
      return this.remotes.find({
        where: {
          status: RemoteStatus.INVENTORY,
          readyAt: Not(IsNull()),
          removedAt: IsNull(),
        },
        // El modelo viaja con el control: la pantalla de stock muestra cuántos
        // botones tiene, y sin la relación esa columna salía vacía.
        relations: { model: true },
        order: { id: 'ASC' },
      });
    }

    const orgIds = actor.memberships
      .filter((m) => m.accountType === AccountType.ORGANIZATION)
      .map((m) => m.accountId);
    if (orgIds.length === 0) return Promise.resolve([]);

    return this.remotes.find({
      where: {
        status: RemoteStatus.INVENTORY,
        organizationId: In(orgIds),
        readyAt: Not(IsNull()),
        removedAt: IsNull(),
      },
      relations: { model: true },
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
   * ENTREGA DE LOTE: del stock de CPS al de una organización. Solo CPS.
   *
   * Existe por lo mismo que en alarmas: pasarle 50 controles a una muni eran 50
   * llamadas, cada una con su chance de fallar por la mitad. Acá o van todos o
   * no va ninguno.
   *
   * `organizationId: null` los devuelve al stock de fábrica.
   */
  async deliver(
    dto: DeliverRemotesDto,
    actorUserId: number,
  ): Promise<{ delivered: number }> {
    const controles = await this.remotes.find({
      where: { id: In(dto.remoteIds) },
    });
    if (controles.length !== dto.remoteIds.length) {
      throw new NotFoundException('Alguno de los controles no existe');
    }

    for (const control of controles) {
      if (control.removedAt !== null) {
        throw new BadRequestException(
          `${control.serial ?? control.id} está removido`,
        );
      }
      if (
        control.status !== RemoteStatus.INVENTORY ||
        control.homeId !== null
      ) {
        throw new BadRequestException(
          `${control.serial ?? control.id} ya está en una vivienda`,
        );
      }
      // Un control sin el visto bueno todavía no tiene los códigos grabados.
      if (control.serial !== null && control.readyAt === null) {
        throw new BadRequestException(
          `${control.serial} todavía no tiene el visto bueno de fábrica`,
        );
      }
    }

    if (dto.organizationId !== null) {
      await this.assertOrganizacion(dto.organizationId);
    }

    await this.remotes.update(
      { id: In(dto.remoteIds) },
      { organizationId: dto.organizationId, updatedBy: actorUserId },
    );

    await this.audit.record({
      actorUserId,
      action: 'remote.deliver',
      entityType: 'remote',
      accountId: dto.organizationId,
      newValue: {
        organizationId: dto.organizationId,
        seriales: controles.map((c) => c.serial),
      },
    });

    return { delivered: controles.length };
  }

  /**
   * ADOPTAR: sumar un control al stock propio con serial + código.
   *
   * El otro camino al stock además del lote: la bolsa que alguien ya tiene en la
   * mano. Solo sobre controles SIN DUEÑO — uno que ya es de alguien se entrega,
   * no se adopta.
   */
  async adopt(dto: AdoptRemoteDto, actor: AuthenticatedUser): Promise<Remote> {
    const control = await this.remotes.findOne({
      where: { serial: dto.serial.trim().toUpperCase() },
    });
    // Mismo mensaje para "no existe" y "código equivocado": distinguirlos
    // convierte el endpoint en una forma de averiguar qué seriales existen.
    if (
      !control ||
      control.claimCode === null ||
      control.claimCode !== dto.claimCode.trim().toUpperCase()
    ) {
      throw new NotFoundException(
        'No hay ningún control con ese serial y código',
      );
    }
    if (control.removedAt !== null) {
      throw new BadRequestException('Ese control está removido');
    }
    if (control.homeId !== null) {
      throw new ConflictException('Ese control ya está en una vivienda');
    }
    if (control.organizationId !== null) {
      throw new ConflictException(
        'Ese control ya está en el stock de una organización. Si tiene que ' +
          'cambiar de manos, la entrega la hace CPS.',
      );
    }
    if (control.readyAt === null) {
      throw new BadRequestException(
        'Ese control todavía no tiene el visto bueno de fábrica',
      );
    }

    const organizationId = this.resolverOrganizacion(actor, dto.organizationId);
    await this.assertOrganizacion(organizationId);

    await this.remotes.update(control.id, {
      organizationId,
      updatedBy: actor.id,
    });

    await this.audit.record({
      actorUserId: actor.id,
      action: 'remote.adopt',
      entityType: 'remote',
      entityId: control.id,
      accountId: organizationId,
      newValue: { organizationId, serial: control.serial },
    });

    return this.remotes.findOneOrFail({ where: { id: control.id } });
  }

  /**
   * DEVOLVER al stock: la familia entregó el control.
   *
   * Vuelve al inventario de la organización dueña del barrio —o al de fábrica si
   * el barrio lo opera CPS— y se le saca el portador. Desde ahí se lo puede
   * asignar a otra casa.
   *
   * **Ojo con lo que esto NO hace**: sus códigos siguen grabados en los paneles
   * del barrio. Mientras no exista la sincronización de la base RF, el llavero
   * devuelto sigue disparando la alarma de esa gente hasta que se lo entregue a
   * otro y se recarguen los códigos.
   */
  async devolver(
    id: number,
    actor: AuthenticatedUser,
    scope: AccessScope,
  ): Promise<Remote> {
    const remote = await this.remotes.findOne({ where: { id } });
    if (!remote) throw new NotFoundException(`No existe el control ${id}`);
    if (remote.homeId === null) {
      throw new BadRequestException('Ese control ya está en el stock');
    }

    const home = await this.getHome(remote.homeId);
    this.scopes.assertHome(scope, remote.homeId, home.neighborhoodId);

    const barrio = await this.neighborhoods.findOneOrFail({
      where: { id: home.neighborhoodId },
    });

    await this.remotes.update(id, {
      status: RemoteStatus.INVENTORY,
      homeId: null,
      assignedToUserId: null,
      // Vuelve al stock de quien opera ese barrio. Si el barrio es de una
      // organización, es suyo; si lo opera CPS, vuelve a fábrica.
      organizationId: barrio.organizationId,
      updatedBy: actor.id,
    });

    await this.audit.record({
      actorUserId: actor.id,
      action: 'remote.return',
      entityType: 'remote',
      entityId: id,
      neighborhoodId: home.neighborhoodId,
      oldValue: {
        homeId: remote.homeId,
        assignedToUserId: remote.assignedToUserId,
      },
      newValue: { organizationId: barrio.organizationId },
    });

    return this.remotes.findOneOrFail({ where: { id } });
  }

  /** La cuenta destino tiene que existir y ser una ORGANIZATION. */
  private async assertOrganizacion(id: number | null): Promise<void> {
    if (id === null) return;
    const cuenta = await this.accounts.findOne({ where: { id } });
    if (!cuenta || cuenta.type !== AccountType.ORGANIZATION) {
      throw new BadRequestException(`La cuenta ${id} no es una organización`);
    }
  }

  /** A qué stock va: el que se pidió, o el único propio si hay uno solo. */
  private resolverOrganizacion(
    actor: AuthenticatedUser,
    pedida: number | undefined,
  ): number {
    const propias = actor.memberships
      .filter((m) => m.accountType === AccountType.ORGANIZATION)
      .map((m) => m.accountId);

    if (pedida !== undefined) {
      const esCps = actor.memberships.some(
        (m) => m.accountType === AccountType.COMPANY,
      );
      if (!esCps && !propias.includes(pedida)) {
        throw new ForbiddenException('No podés adoptar para otra organización');
      }
      return pedida;
    }

    if (propias.length === 1) return propias[0];
    throw new BadRequestException(
      'Decí a qué organización va el control: pertenecés a más de una',
    );
  }

  /**
   * Asignar un control del STOCK a una vivienda (la entrega física). A partir
   * de acá la vivienda es dueña; para moverlo hay que devolverlo al stock.
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
        'Ese control ya está en una vivienda. Si tiene que ir a otra, primero ' +
          'devolvelo al stock.',
      );
    }
    if (remote.removedAt !== null) {
      throw new BadRequestException('Ese control está removido');
    }
    // El visto bueno de fábrica. Sin él, el control puede no tener todavía los
    // códigos grabados: entregarlo sería darle a un vecino un llavero mudo.
    if (remote.serial !== null && remote.readyAt === null) {
      throw new BadRequestException(
        'Ese control todavía no tiene el visto bueno de fábrica',
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

    // El portador es obligatorio al entregar y tiene que ser de ESA casa: el
    // `dni` que viaja en la alarma sale de acá, así que un control entregado
    // sin nombre es un evento que después no se le puede atribuir a nadie.
    await this.assertUserBelongsToHome(dto.homeId, dto.assignedToUserId);
    await this.assertPortadorLibre(dto.assignedToUserId);

    await this.remotes.update(id, {
      status: RemoteStatus.ACTIVE,
      homeId: dto.homeId,
      assignedToUserId: dto.assignedToUserId,
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
      newValue: {
        status: RemoteStatus.ACTIVE,
        homeId: dto.homeId,
        assignedToUserId: dto.assignedToUserId,
      },
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
      await this.assertPortadorLibre(dto.assignedToUserId, id);
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

    // La huella determinística, igual que en la fábrica: si este camino no la
    // escribiera, el duplicado que la fábrica frena entraría por acá — y un
    // código repetido es una alarma atribuida a la casa equivocada.
    const codeHmac = this.crypto.fingerprint(dto.code);
    const repetido = await this.codes.findOne({
      where: { codeHmac },
      select: { id: true },
    });
    if (repetido) {
      // Sin decir de qué control es: cargar códigos de a uno no puede ser una
      // forma de sondear los de la flota.
      throw new ConflictException('Ese código ya está cargado en otro control');
    }

    const code = await this.codes.save(
      this.codes.create({
        remoteId,
        position: dto.position,
        codeEncrypted: this.crypto.encrypt(dto.code),
        codeHmac,
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

  /**
   * UNA PERSONA, UN CONTROL.
   *
   * No es una regla nuestra: la base del panel se indexa por DNI y guarda un
   * registro por persona (hasta 4 códigos), así que un segundo control del mismo
   * portador **nunca podría cargarse** — el equipo lo rechaza con `EE_DUP`.
   * Permitirlo en la web sería entregar un llavero que no va a disparar nada.
   *
   * La base lo garantiza con `uq_remote_one_per_carrier`; esto existe para que
   * el mensaje diga CUÁL es el otro control en vez de un 500 con el nombre de
   * un índice adentro.
   */
  private async assertPortadorLibre(
    userId: number,
    exceptoRemoteId?: number,
  ): Promise<void> {
    const otro = await this.remotes.findOne({
      where: { assignedToUserId: userId, removedAt: IsNull() },
      select: { id: true, serial: true },
    });
    if (!otro || otro.id === exceptoRemoteId) return;

    throw new ConflictException(
      `Esa persona ya lleva el control ${otro.serial ?? `#${otro.id}`}. Una ` +
        'persona lleva un solo control: la alarma guarda un registro por DNI, ' +
        'así que el segundo no se podría cargar en el equipo. Cambiale el ' +
        'portador a uno de los dos.',
    );
  }

  /** CUPO del barrio (§5.2): habilita o no los controles. Vive en neighborhood. */
  private async assertRemotesEnabled(neighborhoodId: number): Promise<void> {
    const barrio = await this.neighborhoods.findOne({
      where: { id: neighborhoodId },
    });
    if (!barrio) {
      throw new NotFoundException(`No existe el barrio ${neighborhoodId}`);
    }
    // Antes acá había una puerta: si el barrio no tenía `remote_controls_enabled`
    // se rechazaba la asignación. El cupo se eliminó (2026-08-03, migración
    // DropRemoteControlsQuota): los controles dejaron de habilitarse barrio por
    // barrio, así que CUALQUIER barrio puede tenerlos.
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
}
