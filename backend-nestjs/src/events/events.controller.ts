import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ScopeService } from '../common/scope.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  CreateEventDto,
  FindEventsQuery,
  RespondEventDto,
  ResolveEventDto,
} from './dto/event.dto';
import { EventResponse } from './entities/event-response.entity';
import { Event } from './entities/event.entity';
import type { PagedEvents } from './events.service';
import { EventsService } from './events.service';

/**
 * Eventos: el tablero del monitoreo.
 *
 * Sin @RequireMembership de tipo/rol: el alcance por barrio y el permiso de
 * resolución se validan en el servicio (los vecinos también participan — crean
 * eventos desde la app y responden — y no tienen cuenta de panel).
 */
@ApiTags('events')
@ApiBearerAuth()
@Controller('events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly scopes: ScopeService,
  ) {}

  /** GET /api/events?neighborhoodId=&status=&limit=&offset= */
  @Get()
  async findAll(
    @Query() query: FindEventsQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PagedEvents> {
    return this.events.findAll(await this.scopes.forUser(user), query);
  }

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Event> {
    return this.events.findOne(id, await this.scopes.forUser(user));
  }

  /** POST /api/events — alta desde panel o app. Los de las alarmas van directo a la base. */
  @Post()
  create(
    @Body() dto: CreateEventDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Event> {
    return this.events.create(dto, user);
  }

  /** PATCH /api/events/:id/resolve — el monitoreo cierra: RESOLVED o FALSE_ALARM. */
  @Patch(':id/resolve')
  resolve(
    @Param('id') id: string,
    @Body() dto: ResolveEventDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Event> {
    return this.events.resolve(id, dto, user);
  }

  /** POST /api/events/:id/responses — "estoy yendo". Una por persona. */
  @Post(':id/responses')
  respond(
    @Param('id') id: string,
    @Body() dto: RespondEventDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EventResponse> {
    return this.events.respond(id, dto, user);
  }
}
