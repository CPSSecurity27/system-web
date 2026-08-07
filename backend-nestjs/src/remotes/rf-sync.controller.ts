import { Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireMembership } from '../auth/decorators/roles.decorator';
import { ScopeService } from '../common/scope.service';
import { CONFIGURAN_EQUIPOS } from '../devices/device-permissions';
import { EstadoRfView } from './dto/rf-sync.dto';
import { RfSyncService } from './rf-sync.service';

/**
 * La base de controles de un equipo.
 *
 * Cuelga de `devices/:id` porque la pregunta es sobre el EQUIPO —qué llaveros
 * conoce este poste— pero vive en el módulo de controles, que es de donde salen
 * los códigos y quien sabe descifrarlos.
 *
 * **No es configuración**, aunque comparta pantalla con ella: no tiene `cfg_v`,
 * no se mergea y no es retained. Es una cola de comandos con su ack, y por eso
 * el estado se lee acá y no del espejo de config.
 */
@ApiTags('remotes')
@ApiBearerAuth()
@Controller('devices/:id/rf')
export class RfSyncController {
  constructor(
    private readonly rf: RfSyncService,
    private readonly scopes: ScopeService,
  ) {}

  /**
   * GET /api/devices/:id/rf — qué está cargado, qué falta y qué sobra.
   *
   * Solo pide VER el equipo: entender por qué un control no dispara es parte de
   * mirar el equipo, y el MONITOR necesita eso tanto como el técnico. Lo que
   * puede HACER viaja en `puedeSincronizar`, calculado con la misma lista que
   * usa el guard del POST — para que la pantalla no ofrezca un botón que el
   * backend después rechaza.
   */
  @Get()
  async estado(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EstadoRfView> {
    return this.rf.estado(id, await this.scopes.forUser(user), user);
  }

  /**
   * POST /api/devices/:id/rf/sync — carga la base en el equipo.
   *
   * Encola la tanda entera; sale el primer paso y cada ack destraba el
   * siguiente. La respuesta es el estado con la tanda ya en curso, así la
   * pantalla muestra el progreso sin pedir de nuevo.
   */
  @Post('sync')
  @RequireMembership(...CONFIGURAN_EQUIPOS)
  async sincronizar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EstadoRfView> {
    return this.rf.sincronizar(id, await this.scopes.forUser(user), user);
  }
}
