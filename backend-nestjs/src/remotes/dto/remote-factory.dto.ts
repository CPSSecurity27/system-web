import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CODE_MAX, CODE_MIN, MAX_CODIGOS } from '../remote-codes';

export class CreateRemoteModelDto {
  @ApiProperty({ example: 'CR2' })
  @Matches(/^[A-Za-z0-9]{2,8}$/, {
    message: 'El código del modelo son 2 a 8 letras o números',
  })
  code!: string;

  @ApiProperty({ example: 'Control de 2 botones' })
  @IsString()
  @MaxLength(80)
  name!: string;

  /**
   * Cuántos botones tiene. Es lo que decide cuántos códigos se cargan.
   *
   * Se admite más de 4, pero el panel registra 4: un modelo de 6 botones va a
   * tener dos teclas que no disparan nada. La restricción no es nuestra —
   * `MQTT_RF_CODES_PER_CLI` en el firmware— y por eso el DTO no la esconde.
   */
  @ApiProperty({ example: 2, minimum: 1, maximum: 8 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8)
  buttons!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class UpdateRemoteModelDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /** `false` lo discontinúa. Un modelo no se borra. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ManufactureRemoteDto {
  @ApiProperty({
    description: 'Modelo del catálogo. Decide cuántos códigos lleva.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  modelId!: number;

  /**
   * Numeración CORRELATIVA en vez de al azar.
   *
   * Al azar es el default y es lo correcto para que un código no se pueda
   * adivinar. Correlativo existe porque al grabar una tanda en la mesa se
   * verifica de un vistazo que quedaron en orden. Los tomados se saltean igual.
   *
   * No hay apodo acá: en la fábrica se trabaja por número de serie. El nombre lo
   * pone la familia cuando el control llega a una casa.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  correlativo?: boolean;

  /**
   * Los códigos, en orden de posición. **Vacío = los genera el sistema**, que es
   * el camino normal: los elige CPS y se graban en el control, así que no hay
   * nada que tipear ni que equivocarse.
   *
   * Se aceptan cargados a mano para el caso en que el hardware no se deje
   * programar y haya que copiar los que ya trae. O van todos, o no va ninguno:
   * mezclar generados con tipeados haría que la pantalla muestre números que
   * nadie sabe si están grabados.
   */
  @ApiPropertyOptional({ example: [123456, 123457, 123458, 123459] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CODIGOS)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(CODE_MIN, { each: true })
  @Max(CODE_MAX, { each: true })
  codigos?: number[];
}

/** El visto bueno de fábrica. Se puede desmarcar: el error común es marcar de más. */
export class MarkReadyDto {
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  listo?: boolean;
}

/** Un código con lo que hace su botón. La posición NO es un orden: es el botón. */
export interface CodigoDeControl {
  position: number;
  codigo: number;
  boton: string;
  modo: string;
  label: string;
}

export interface ModeloDeControl {
  id: number;
  code: string;
  name: string;
  buttons: number;
}

/** Lo que devuelve la fábrica: incluye los códigos, porque hay que grabarlos. */
export interface RemoteFabricado {
  id: number;
  serial: string;
  /** Va impreso en la etiqueta: con esto un cliente lo suma a su stock. */
  claimCode: string | null;
  name: string | null;
  modelo: ModeloDeControl;
  manufacturedAt: string;
  codigos: CodigoDeControl[];
}

/**
 * Un control encontrado por serial o por código.
 *
 * NO trae los códigos. Quien busca por código ya lo tiene —lo leyó de la
 * etiqueta o de un log— y devolverlo sería un camino de lectura sin auditar,
 * justo al lado del que sí lo está (`/label`).
 */
export interface ResultadoBusqueda {
  id: number;
  serial: string | null;
  status: string;
  homeId: number | null;
  modelo: ModeloDeControl | null;
  /** Por qué apareció. `codigo` gana sobre `serial`: es la coincidencia exacta. */
  coincidePor: 'serial' | 'codigo';
  /** Visto bueno de fábrica. null = todavía no puede salir al stock. */
  readyAt: string | null;
  /** Fuera de circulación. Ojo: NO impide que el control siga disparando. */
  removedAt: string | null;
  /** Qué posición coincidió, cuando se buscó por código. */
  position: number | null;
  boton: string | null;
}

/** Los datos de la etiqueta. Los códigos van en claro: solo CPS, auditado. */
export interface EtiquetaControl {
  id: number;
  serial: string;
  claimCode: string | null;
  modelo: ModeloDeControl;
  codigos: CodigoDeControl[];
}
