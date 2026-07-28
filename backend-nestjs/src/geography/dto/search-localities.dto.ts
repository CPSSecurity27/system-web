import { Type } from 'class-transformer';
import { IsInt, IsString, Max, Min, MinLength } from 'class-validator';

export class SearchLocalitiesDto {
  /** Mínimo 2 caracteres: un LIKE '%a%' sobre 4026 filas no le sirve a nadie. */
  @IsString()
  @MinLength(2, { message: 'La búsqueda necesita al menos 2 caracteres' })
  search!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}
