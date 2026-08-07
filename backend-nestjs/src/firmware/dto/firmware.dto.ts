import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { FIRMWARE_SLOTS } from '../entities/firmware-channel.entity';
import type { FirmwareSlot } from '../entities/firmware-channel.entity';
import { MAX_VERSION_CHARS } from '../firmware-catalog';
import type { ConfirmacionView, OtaProgresoView } from '../ota-estados';

/**
 * El alta de un firmware. Va como `multipart/form-data`: el `.bin` en el campo
 * `archivo` y estos dos como campos de texto.
 *
 * La versión se escribe a mano y no se lee del binario. No es comodidad: el
 * `CMakeLists.txt` del firmware no define `PROJECT_VER`, así que la imagen
 * declara el `git describe` (`f1a0459-dirty`), que no sirve para nombrar nada.
 * Todo lo demás —proyecto, tamaño, sha256— sí sale del archivo.
 */
export class UploadFirmwareDto {
  @ApiProperty({
    example: 'new_0_7_0',
    description:
      'Formato <canal>_<X>_<Y>_<Z>. El canal (new/stable) es registro: el equipo nunca bloquea por eso.',
  })
  @IsString()
  @MaxLength(MAX_VERSION_CHARS)
  version!: string;

  @ApiPropertyOptional({ description: 'Qué trae esta versión, en castellano.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/** En qué base del equipo se publica. */
export class PublishFirmwareDto {
  @ApiProperty({
    enum: FIRMWARE_SLOTS,
    description:
      'new = la que baja un cmd t:ota automático. emergency = el último bueno conocido que el equipo baja SOLO cuando decide que está roto.',
  })
  @IsIn(FIRMWARE_SLOTS)
  slot!: FirmwareSlot;
}

export interface FirmwareReleaseView {
  id: number;
  version: string;
  channel: string;
  hwModel: string;
  /** Lo que el equipo verifica antes de activar la partición. */
  projectName: string;
  sizeBytes: number;
  sha256: string;
  notes: string | null;
  subidoPor: string | null;
  creadoEn: string;
  /** La base que hay que pegar en el campo de URL manual para bajar ESTA versión. */
  url: string;
  /** En qué ranuras está publicada ahora mismo. */
  publicadoEn: FirmwareSlot[];
}

export interface RanuraView {
  slot: FirmwareSlot;
  version: string;
  releaseId: number;
  url: string;
  actualizadoPor: string | null;
  actualizadoEn: string;
}

/**
 * Una alarma en el gestor de actualizaciones.
 *
 * `fw` es lo que el equipo DICE estar corriendo, y llega por el `status`
 * retained: se refresca cuando el panel republica su presencia, no en cada
 * telemetría. Un equipo que nunca conectó no tiene `fw` y por eso el estado
 * `desconocido` existe — no es lo mismo que estar atrasado.
 */
export interface EquipoFirmwareView {
  deviceId: number;
  serial: string;
  nombre: string | null;
  barrioId: number | null;
  barrio: string | null;
  cuenta: string | null;
  fw: string | null;
  estado: 'al_dia' | 'atrasado' | 'desconocido';
  online: boolean;
  /** Hasta cuándo avisó que duerme. Un equipo dormido no está caído. */
  durmiendoHasta: string | null;
  /**
   * El modo de energía. **El equipo rechaza el OTA si no está en ACTIVE_***:
   * no lo encola ni lo difiere, contesta `error` y se termina ahí.
   */
  modoEnergia: string | null;
  /** Si hay un `cmd t:ota` sin cerrar, en qué quedó **el pedido**. */
  otaEnCurso: {
    cid: string;
    estado: string;
    detalle: string | null;
    creadoEn: string;
  } | null;
  /**
   * Lo que contó el EQUIPO de su propia actualización (`up t:ota`).
   *
   * No es lo mismo que lo de arriba: el ack de un comando dice "acepté el
   * pedido", y entre eso y tener el firmware corriendo hay una descarga de
   * 1,2 MB, un sha256 y un reinicio. Un comando `ok` con un progreso `falló` es
   * exactamente el caso que antes no se veía.
   */
  progreso: OtaProgresoView | null;
  /**
   * Hasta dónde se puede AFIRMAR que la última actualización funcionó.
   *
   * Existe porque `fw === publicada` no alcanza y llegó a mostrar un falso
   * "actualizada": esa versión es una etiqueta de nuestro propio manifiesto que
   * el equipo devuelve, y lo único que su self-test comprueba es que consiguió
   * internet en 10 minutos.
   */
  confirmacion: ConfirmacionView | null;
}

export class ActualizarFlotaDto {
  @ApiProperty({
    type: [Number],
    description: 'Los equipos a actualizar. Cada uno recibe su propio comando.',
    example: [12, 15, 18],
  })
  deviceIds!: number[];
}

/**
 * Qué pasó con cada equipo. Nunca un "listo" global: la mitad de los pedidos
 * puede rebotar por energía o por alcance, y decir "actualizado" sobre eso es
 * mentir en la única pantalla donde importa.
 */
export interface ResultadoActualizacionView {
  deviceId: number;
  serial: string;
  encolado: boolean;
  cid: string | null;
  motivo: string | null;
}
