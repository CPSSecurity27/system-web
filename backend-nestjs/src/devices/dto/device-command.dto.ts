import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { COMANDOS, MODOS_ALARMA } from '../device-commands';

/**
 * Un comando al panel.
 *
 * `params` es libre y lo valida `armarComando` contra el catálogo del firmware:
 * cada tipo lleva los suyos y el DTO no puede expresar eso sin una unión
 * discriminada que habría que mantener sincronizada a mano con el `switch`.
 */
export class SendCommandDto {
  @ApiProperty({ enum: COMANDOS, example: 'restart' })
  @IsIn(COMANDOS)
  tipo!: (typeof COMANDOS)[number];

  @ApiPropertyOptional({
    description: 'Parámetros del comando. Depende del tipo.',
    example: { fuente: 'auto' },
  })
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;

  /**
   * El serial tipeado por la persona. SOLO lo mira `factory`.
   *
   * El backend sabe el serial y podría completarlo solo. Se pide igual porque
   * la fricción es el punto: `factory` deja el equipo sin WiFi y obliga a ir
   * físicamente hasta el poste.
   */
  @ApiPropertyOptional({ example: 'AV-A842E38FCA6C' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  confirmacion?: string;
}

/** Disparar o apagar la alarma a distancia. */
export class TriggerAlarmDto {
  @ApiProperty({ enum: MODOS_ALARMA, example: 'emergency' })
  @IsIn(MODOS_ALARMA)
  modo!: (typeof MODOS_ALARMA)[number];
}

/**
 * La cola con los permisos ya resueltos.
 *
 * No es un array pelado a propósito: la pantalla tiene DOS matrices distintas
 * —los comandos de infraestructura excluyen al MONITOR, el disparo de alarma lo
 * incluye— y cada una depende también del barrio (`managed_by`). Que el front
 * las dedujera de la sesión sería volver a inventar del lado del navegador una
 * regla que ya vive en el backend, y equivocarse en la copia.
 */
export interface ColaComandosView {
  comandos: ComandoView[];
  /** Reiniciar, volver a fábrica, diagnóstico. */
  puedeOperar: boolean;
  /** Disparar o apagar la alarma a distancia (el MONITOR también). */
  puedeDisparar: boolean;
  /**
   * Actualizar el firmware. Es SOLO CPS y por eso es una tercera matriz: el
   * OTA instala software en la infraestructura, no configura un barrio.
   */
  puedeActualizar: boolean;
}

export interface ComandoView {
  cid: string;
  tipo: string;
  payload: Record<string, unknown>;
  /** `pending` | `sent` | `ok` | `error` | `cancelled` (`chk_commands_estado`). */
  estado: string;
  detalle: string | null;
  creadoEn: string;
  enviadoEn: string | null;
  confirmadoEn: string | null;
  pedidoPor: string | null;
  /** Solo mientras sigue en la cola: lo publicado ya no se puede desmandar. */
  cancelable: boolean;
}
