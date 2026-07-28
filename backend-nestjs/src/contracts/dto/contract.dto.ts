import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ContractStatus } from '../../common/enums';

/**
 * v2: el contrato es SIEMPRE organización -> barrio y es comercial PURO.
 * Los cupos (max_family_members, controles, etc.) NO viven acá: van en la
 * cuenta y en el barrio, y solo CPS los toca (/accounts/:id/quotas y el barrio).
 */
export class CreateContractDto {
  @IsInt()
  @Min(1)
  accountId!: number;

  @IsInt()
  @Min(1)
  neighborhoodId!: number;

  /** Se CONGELA al firmar: si mañana sube la tarifa, este contrato no cambia. */
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El precio admite 2 decimales' },
  )
  @Min(0, { message: 'El precio no puede ser negativo' })
  price!: number;

  @IsDateString({}, { message: 'Fecha de inicio inválida (YYYY-MM-DD)' })
  startDate!: string;

  /** Nullable: un contrato abierto o autorrenovable no tiene fecha de fin. */
  @IsOptional()
  @IsDateString({}, { message: 'Fecha de fin inválida (YYYY-MM-DD)' })
  endDate?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

/**
 * NO se pueden cambiar precio, cuenta ni destino: están congelados. Para
 * cambiar eso se cancela el contrato y se firma otro — así queda el historial.
 */
export class UpdateContractDto {
  @IsOptional()
  @IsEnum(ContractStatus, { message: 'Estado de contrato inválido' })
  status?: ContractStatus;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Fecha de fin inválida (YYYY-MM-DD)' })
  endDate?: string;
}
