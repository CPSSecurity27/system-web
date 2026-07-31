import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

/**
 * Alta de un modelo de placa (SOLO CPS). Es una acción rara —un modelo nuevo
 * cada tanto, no 50 por día— así que el código se tipea a mano y se valida la
 * forma: solo el prefijo, sin dígitos (los 4 dígitos son de cada placa).
 */
export class CreateBoardModelDto {
  @IsString()
  @Matches(/^[A-Za-z]{2,8}$/, {
    message:
      'El código del modelo es solo el prefijo, de 2 a 8 letras y sin números (por ejemplo ALOY)',
  })
  code!: string;

  @IsString()
  @IsNotEmpty({ message: 'Falta el nombre del modelo' })
  name!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

/** El `code` NO está: cambiarlo dejaría huérfanos los equipos ya fabricados. */
export class UpdateBoardModelDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  /** `false` discontinúa el modelo: no se puede fabricar más, los viejos siguen. */
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}
