import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  AccountType,
  EntityStatus,
  OrgSubtype,
  UserRole,
} from '../../common/enums';

export class FindAccountsQuery {
  /** Busca por nombre. Ojo: los nombres se repiten. */
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'La búsqueda necesita al menos 2 caracteres' })
  search?: string;

  @IsOptional()
  @IsEnum(AccountType, { message: 'Tipo de cuenta inválido' })
  type?: AccountType;

  @IsOptional()
  @IsEnum(EntityStatus)
  status?: EntityStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;
}

export class CreateAccountDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name!: string;

  /** COMPANY no: existe una sola (CPS) y la crea el bootstrap. */
  @IsEnum(AccountType, { message: 'Tipo de cuenta inválido' })
  type!: AccountType;

  /** MUNICIPAL o PRIVATE. Obligatorio para ORGANIZATION (la base lo impone). */
  @IsEnum(OrgSubtype, { message: 'Subtipo inválido (MUNICIPAL o PRIVATE)' })
  subtype!: OrgSubtype;

  /**
   * CUPO (tarifa), obligatorio: no existe "sin límite" (2026-07-23) — toda
   * organización paga por una cantidad concreta de barrios. Después solo se
   * toca por /quotas. Si subtype es PRIVATE, el servicio lo fija en 1 sin
   * excepciones (una comunidad privada es dueña de un único barrio) y rechaza
   * cualquier otro valor explícito.
   */
  @IsInt()
  @Min(1, {
    message:
      'El cupo de barrios tiene que ser al menos 1: no existe "sin límite"',
  })
  maxNeighborhoods!: number;

  /** Igual que arriba: obligatorio, sin "sin límite". */
  @IsInt()
  @Min(1, {
    message:
      'El cupo de monitores tiene que ser al menos 1: no existe "sin límite"',
  })
  maxMonitorUsers!: number;
}

export class OnboardCommunityNeighborhoodDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre del barrio es obligatorio' })
  name!: string;

  @IsInt()
  @Min(1)
  localityId!: number;

  @IsOptional()
  @IsLatitude({ message: 'Latitud inválida' })
  latitude?: number;

  @IsOptional()
  @IsLongitude({ message: 'Longitud inválida' })
  longitude?: number;
}

/**
 * Alta atómica de una comunidad PRIVATE: cuenta + su único barrio + OWNER
 * institucional + membresía, en una sola transacción (AccountsService
 * #onboardCommunity). Solo CPS (controller). No pide `subtype` ni
 * `maxNeighborhoods`: una comunidad SIEMPRE es PRIVATE con cupo 1 — pedirlo
 * sería abrir la puerta a un valor inconsistente que el servicio de todos
 * modos va a pisar.
 */
export class OnboardCommunityDto {
  /** Nombre de la cuenta (la comunidad/consorcio) Y del usuario institucional OWNER. */
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name!: string;

  @IsInt()
  @Min(1, {
    message:
      'El cupo de monitores tiene que ser al menos 1: no existe "sin límite"',
  })
  maxMonitorUsers!: number;

  @IsString()
  @MinLength(3, { message: 'El usuario debe tener al menos 3 caracteres' })
  ownerUsername!: string;

  @ValidateNested()
  @Type(() => OnboardCommunityNeighborhoodDto)
  neighborhood!: OnboardCommunityNeighborhoodDto;
}

/**
 * CUPOS = tarifa. Solo CPS. Si vienen, tienen que ser >= 1 (no existe "sin
 * límite"); ausente = no tocar ese cupo en este PATCH.
 *
 * OJO: `@IsOptional()` en class-validator salta la validación tanto si el
 * valor es `undefined` COMO si es `null` — con eso solo, un PATCH mandando
 * `{ maxNeighborhoods: null }` se colaría sin pasar por `@IsInt()`/`@Min()` y
 * reintroduciría el "sin límite" que se acaba de sacar. `@ValidateIf` con
 * `!== undefined` es lo que hace que `null` SÍ se valide (y lo rechaza).
 */
export class UpdateQuotasDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(1, {
    message:
      'El cupo de barrios tiene que ser al menos 1: no existe "sin límite"',
  })
  maxNeighborhoods?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(1, {
    message:
      'El cupo de monitores tiene que ser al menos 1: no existe "sin límite"',
  })
  maxMonitorUsers?: number;
}

export class AddMemberDto {
  @IsInt()
  @Min(1)
  userId!: number;

  /**
   * OWNER solo para usuarios INSTITUCIONALES (y viceversa). MONITOR está
   * sujeto al cupo max_monitor_users de la cuenta.
   */
  @IsEnum(UserRole, { message: 'Rol inválido' })
  role!: UserRole;
}

export class SetStaffAssignmentsDto {
  /**
   * El conjunto COMPLETO de barrios asignados (reemplaza al anterior).
   * Lista vacía = sin asignaciones = ve todos los barrios de su organización.
   */
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  neighborhoodIds!: number[];
}

export class UpdateMemberRoleDto {
  /** OWNER no se asigna ni se quita por acá: es la soberanía de la cuenta. */
  @IsEnum(UserRole, { message: 'Rol inválido' })
  role!: UserRole;
}
