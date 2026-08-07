import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, Min } from 'class-validator';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireMembership } from '../auth/decorators/roles.decorator';
import { ScopeService } from '../common/scope.service';
import {
  ActualizarFlotaDto,
  FirmwareReleaseView,
  PublishFirmwareDto,
  RanuraView,
  UploadFirmwareDto,
} from './dto/firmware.dto';
import { FirmwareFleetService } from './firmware-fleet.service';
import { GESTIONAN_FIRMWARE } from './firmware-permissions';
import { MAX_BIN_BYTES } from './firmware-catalog';
import { FirmwareService } from './firmware.service';

class FlotaQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  neighborhoodId?: number;
}

class ActualizarBody implements ActualizarFlotaDto {
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  deviceIds!: number[];
}

/**
 * El gestor de actualizaciones. **Todo el controlador es solo-CPS.**
 *
 * Un firmware publicado corre en los postes de todos los clientes: no es una
 * configuración de un barrio, es el software de la infraestructura. Mismo
 * criterio que la fábrica de equipos.
 *
 * Los endpoints de acá no llevan `:id` de un equipo salvo el de actualizar, y
 * ese delega en `DeviceCommandsService.mandar`, que valida el alcance del barrio
 * equipo por equipo. El listado de flota sale recortado por alcance aunque hoy
 * solo lo vea CPS.
 */
@ApiTags('firmware')
@ApiBearerAuth()
@Controller('firmware')
@RequireMembership(...GESTIONAN_FIRMWARE)
export class FirmwareController {
  constructor(
    private readonly firmware: FirmwareService,
    private readonly fleet: FirmwareFleetService,
    private readonly scopes: ScopeService,
  ) {}

  // ── Catálogo ─────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'El catálogo de firmwares subidos' })
  listar(): Promise<FirmwareReleaseView[]> {
    return this.firmware.listar();
  }

  @Get('slots')
  @ApiOperation({
    summary: 'Qué versión está publicada en cada base del equipo',
  })
  ranuras(): Promise<RanuraView[]> {
    return this.firmware.ranuras();
  }

  @Get('check')
  @ApiOperation({
    summary: 'Verifica que el disco tenga lo que la base dice que tiene',
    description:
      'El modo de falla del OTA es silencioso: si nginx no sirve /firmware/ o FIRMWARE_ROOT apunta a otro lado, todo se ve bien hasta que un poste baja un 404.',
  })
  verificar() {
    return this.firmware.verificar();
  }

  @Post()
  @ApiOperation({ summary: 'Sube un .bin y lo siembra en el servidor' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['archivo', 'version'],
      properties: {
        archivo: { type: 'string', format: 'binary' },
        version: { type: 'string', example: 'new_0_7_0' },
        notes: { type: 'string' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('archivo', {
      // El tope real lo vuelve a chequear el servicio con un mensaje que explica
      // por qué; esto es la barrera de memoria, para no bufferear cualquier cosa.
      limits: { fileSize: MAX_BIN_BYTES },
    }),
  )
  subir(
    @UploadedFile() archivo: { buffer: Buffer; originalname?: string },
    @Body() body: UploadFirmwareDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<FirmwareReleaseView> {
    return this.firmware.subir(archivo, body, user);
  }

  @Post(':id/publish')
  @ApiOperation({
    summary: 'Publica una versión en una de las dos bases del firmware',
    description:
      'new = la que baja un cmd t:ota automático. emergency = el último bueno conocido que el equipo baja SOLO cuando decide que está roto: no es "la última".',
  })
  publicar(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: PublishFirmwareDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RanuraView[]> {
    return this.firmware.publicar(id, body.slot, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Saca una versión del catálogo y del disco' })
  borrar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.firmware.borrar(id, user);
  }

  // ── La flota ─────────────────────────────────────────────────────

  @Get('fleet')
  @ApiOperation({
    summary: 'Qué versión corre cada poste, contra la publicada en new',
  })
  async flota(
    @Query() query: FlotaQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const scope = await this.scopes.forUser(user);
    return this.fleet.flota(scope, { neighborhoodId: query.neighborhoodId });
  }

  @Get('fleet/:deviceId/progress')
  @ApiOperation({
    summary: 'El último up t:ota de un equipo, traducido',
    description:
      'Lo que contó el propio equipo, que no es lo mismo que el ack del comando: entre "acepté" y "lo tengo corriendo" hay una descarga de 1,2 MB, un sha256 y un reinicio.',
  })
  async progreso(
    @Param('deviceId', ParseIntPipe) deviceId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const scope = await this.scopes.forUser(user);
    return this.fleet.progreso(deviceId, scope);
  }

  @Post('fleet/update')
  @ApiOperation({
    summary: 'Manda el OTA a los equipos elegidos, de a uno',
    description:
      'No es un broadcast: cada equipo recibe su propio comando con su propio cid, y pasa por las mismas validaciones que desde su ficha. Un fallo no cancela al resto y se informa equipo por equipo.',
  })
  async actualizar(
    @Body() body: ActualizarBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const scope = await this.scopes.forUser(user);
    return this.fleet.actualizar(body.deviceIds, scope, user);
  }
}
