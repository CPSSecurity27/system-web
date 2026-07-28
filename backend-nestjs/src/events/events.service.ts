import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/auth.service';
import {
  AccountType,
  EventOrigin,
  EventScope,
  EventStatus,
  UserRole,
} from '../common/enums';
import { AccessScope, ScopeService } from '../common/scope.service';
import { Home } from '../homes/entities/home.entity';
import {
  CreateEventDto,
  FindEventsQuery,
  RespondEventDto,
  ResolveEventDto,
} from './dto/event.dto';
import { EventResponse } from './entities/event-response.entity';
import { Event } from './entities/event.entity';

export interface PagedEvents {
  items: Event[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Eventos (v2): el corazón operativo. Append-only e ILIMITADOS.
 *
 * Por la web entran los eventos de PANEL y APP; el servicio de alarmas (programa
 * aparte) inserta los suyos directo en la base. La resolución es SIEMPRE de la
 * web (MONITOR/ADMIN): el servicio de alarmas no resuelve nada.
 *
 * El activador queda como SNAPSHOT congelado (nombre y teléfono del momento):
 * el evento histórico no cambia aunque el vecino cambie de número.
 */
@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventResponse)
    private readonly responses: Repository<EventResponse>,
    @InjectRepository(Home) private readonly homes: Repository<Home>,
    private readonly scopes: ScopeService,
  ) {}

  async findAll(
    scope: AccessScope,
    query: FindEventsQuery,
  ): Promise<PagedEvents> {
    const barrios = await this.neighborhoodsInScope(scope);

    if (query.neighborhoodId) {
      if (!scope.global && !barrios.includes(query.neighborhoodId)) {
        return {
          items: [],
          total: 0,
          limit: query.limit,
          offset: query.offset,
        };
      }
    } else if (!scope.global && barrios.length === 0) {
      return { items: [], total: 0, limit: query.limit, offset: query.offset };
    }

    const where = {
      ...(query.neighborhoodId
        ? { neighborhoodId: query.neighborhoodId }
        : scope.global
          ? {}
          : { neighborhoodId: In(barrios) }),
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await this.events.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: query.limit,
      skip: query.offset,
    });

    return { items, total, limit: query.limit, offset: query.offset };
  }

  async findOne(id: string, scope: AccessScope): Promise<Event> {
    const event = await this.events.findOne({
      where: { id },
      relations: { responses: { user: true } },
    });
    if (!event) throw new NotFoundException(`No existe el evento ${id}`);

    const barrios = await this.neighborhoodsInScope(scope);
    if (!scope.global && !barrios.includes(event.neighborhoodId)) {
      throw new ForbiddenException('No tenés acceso a este evento');
    }

    return event;
  }

  /**
   * Alta desde la web. PANEL: cualquier gestor/monitor del barrio. APP: el
   * vecino, sobre su barrio (su activación es el caso de uso central de la app).
   * Snapshot del activador congelado acá, en el momento del evento.
   */
  async create(dto: CreateEventDto, actor: AuthenticatedUser): Promise<Event> {
    const scope = await this.scopes.forUser(actor);
    const barrios = await this.neighborhoodsInScope(scope);
    if (!scope.global && !barrios.includes(dto.neighborhoodId)) {
      throw new ForbiddenException('No tenés acceso a ese barrio');
    }

    if (dto.origin === EventOrigin.DEVICE) {
      throw new BadRequestException(
        'Los eventos DEVICE los inserta el servicio de alarmas, no la web',
      );
    }

    const event = await this.events.save(
      this.events.create({
        neighborhoodId: dto.neighborhoodId,
        deviceId: dto.deviceId ?? null,
        homeId: dto.homeId ?? null,
        remoteId: dto.remoteId ?? null,
        origin: dto.origin,
        scope: dto.scope ?? EventScope.SINGLE,
        triggerMode: dto.triggerMode ?? null,
        gpsLat: dto.gpsLat ?? null,
        gpsLng: dto.gpsLng ?? null,
        locationMode: dto.locationMode ?? null,
        activatorUserId: actor.id,
        // SNAPSHOT congelado: criterio factura.
        activatorName: actor.name,
        activatorPhone: null,
        status: EventStatus.OPEN,
      }),
    );

    return event;
  }

  /**
   * Resolución: SOLO panel (MONITOR/ADMIN/OWNER de la organización del barrio,
   * o CPS). OPEN -> RESOLVED | FALSE_ALARM, con snapshot del resolutor.
   */
  async resolve(
    id: string,
    dto: ResolveEventDto,
    actor: AuthenticatedUser,
  ): Promise<Event> {
    if (
      dto.status !== EventStatus.RESOLVED &&
      dto.status !== EventStatus.FALSE_ALARM
    ) {
      throw new BadRequestException(
        'Un evento se cierra RESOLVED o FALSE_ALARM',
      );
    }

    const scope = await this.scopes.forUser(actor);
    const event = await this.findOne(id, scope);

    const puedeResolver =
      scope.global ||
      actor.memberships.some(
        (m) =>
          m.accountType === AccountType.ORGANIZATION &&
          (m.role === UserRole.MONITOR ||
            m.role === UserRole.ADMIN ||
            m.role === UserRole.OWNER) &&
          scope.neighborhoodIds.includes(event.neighborhoodId),
      );
    if (!puedeResolver) {
      throw new ForbiddenException('Resolver eventos es tarea del monitoreo');
    }

    if (event.status !== EventStatus.OPEN) {
      throw new BadRequestException('El evento ya está cerrado');
    }

    await this.events.update(id, {
      status: dto.status,
      resolvedByUserId: actor.id,
      resolverName: actor.name, // snapshot, mismo criterio que el activador
      resolvedAt: new Date(),
    });

    return this.findOne(id, scope);
  }

  /** Un vecino del barrio responde ("estoy yendo"). Una respuesta por persona. */
  async respond(
    id: string,
    dto: RespondEventDto,
    actor: AuthenticatedUser,
  ): Promise<EventResponse> {
    const scope = await this.scopes.forUser(actor);
    const event = await this.findOne(id, scope);

    if (event.status !== EventStatus.OPEN) {
      throw new BadRequestException('El evento ya está cerrado');
    }

    const yaRespondio = await this.responses.findOne({
      where: { eventId: id, userId: actor.id },
    });
    if (yaRespondio) return yaRespondio;

    return this.responses.save(
      this.responses.create({
        eventId: id,
        userId: actor.id,
        note: dto.note ?? null,
      }),
    );
  }

  /** Barrios que alcanza, incluidos los de sus viviendas (el vecino ve su barrio). */
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
}
