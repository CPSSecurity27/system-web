import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';
import { OrgSubtype } from '../../common/enums';

export class FindPlansQuery {
  /** Por default se listan TODOS, incluidos los discontinuados: la pantalla de CPS los administra. */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsEnum(OrgSubtype, { message: 'Subtipo inválido (MUNICIPAL o COMMUNITY)' })
  appliesTo?: OrgSubtype;
}

export class CreatePlanDto {
  /**
   * Identificador estable, en MAYÚSCULAS. Existe para poder hablar del plan
   * (en un contrato, en un audit_log, con el equipo comercial) sin depender
   * del nombre de vidriera, que se cambia sin avisar.
   */
  @IsString()
  @Matches(/^[A-Z0-9_]{2,32}$/, {
    message:
      'El código va en MAYÚSCULAS, sin espacios (letras, números y guión bajo), de 2 a 32 caracteres',
  })
  code!: string;

  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(OrgSubtype, { message: 'Subtipo inválido (MUNICIPAL o COMMUNITY)' })
  appliesTo!: OrgSubtype;

  /** Precio de LISTA. El que se cobra es el del contrato, congelado al firmar. */
  @IsOptional()
  @IsNumberString({}, { message: 'El precio de referencia debe ser un número' })
  priceReference?: string;

  /** COMMUNITY exige 1: lo valida el servicio y también un CHECK de la base. */
  @IsInt()
  @Min(1, {
    message:
      'El cupo de barrios tiene que ser al menos 1: no existe "sin límite"',
  })
  maxNeighborhoods!: number;

  /** Los de personal admiten 0 = "este plan no incluye ese rol". */
  @IsInt()
  @Min(0, { message: 'El cupo de administradores no puede ser negativo' })
  maxAdminUsers!: number;

  @IsInt()
  @Min(0, { message: 'El cupo de técnicos no puede ser negativo' })
  maxTechnicianUsers!: number;

  @IsInt()
  @Min(0, { message: 'El cupo de monitores no puede ser negativo' })
  maxMonitorUsers!: number;

  @IsInt()
  @Min(0, { message: 'El cupo de familiares no puede ser negativo' })
  maxFamilyMembers!: number;

  /** Disparar TODAS las alarmas del barrio desde la app del vecino. */
  @IsBoolean()
  communityScopeEnabled!: boolean;
}

/**
 * Editar un plan cambia la VIDRIERA, no lo vendido: los cupos de las cuentas
 * que ya lo compraron son copias suyas y no se mueven (ver Plan). Por eso el
 * PATCH no necesita ninguna precaución especial más allá de la auditoría.
 *
 * `code` no se edita: es el identificador estable con el que se lo nombra en
 * contratos y auditoría. Para un código distinto, va un plan nuevo.
 */
export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'El nombre no puede quedar vacío' })
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumberString({}, { message: 'El precio de referencia debe ser un número' })
  priceReference?: string;

  /** false = discontinuado: no se puede vender más, los que lo tienen siguen igual. */
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(1, {
    message:
      'El cupo de barrios tiene que ser al menos 1: no existe "sin límite"',
  })
  maxNeighborhoods?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0, { message: 'El cupo de administradores no puede ser negativo' })
  maxAdminUsers?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0, { message: 'El cupo de técnicos no puede ser negativo' })
  maxTechnicianUsers?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0, { message: 'El cupo de monitores no puede ser negativo' })
  maxMonitorUsers?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0, { message: 'El cupo de familiares no puede ser negativo' })
  maxFamilyMembers?: number;

  @IsOptional()
  @IsBoolean()
  communityScopeEnabled?: boolean;
}
