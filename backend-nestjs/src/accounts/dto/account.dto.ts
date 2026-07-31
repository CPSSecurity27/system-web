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
  ManagedBy,
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

  /** MUNICIPAL o COMMUNITY. Obligatorio para ORGANIZATION (la base lo impone). */
  @IsEnum(OrgSubtype, { message: 'Subtipo inválido (MUNICIPAL o COMMUNITY)' })
  subtype!: OrgSubtype;

  /**
   * El plan del que se COPIAN los cupos. Opcional: sin plan hay que mandar los
   * cuatro a mano (el servicio lo exige y dice cuáles faltan). Con plan, cada
   * cupo explícito de abajo lo pisa — es el caso real de vender un plan con un
   * ajuste puntual sin inventar un plan nuevo.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  planId?: number;

  /**
   * CUPO (tarifa): no existe "sin límite" (2026-07-23) — toda organización
   * paga por una cantidad concreta de barrios. Después solo se toca por
   * /quotas. Si subtype es COMMUNITY, el servicio exige 1 sin excepciones.
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(1, {
    message:
      'El cupo de barrios tiene que ser al menos 1: no existe "sin límite"',
  })
  maxNeighborhoods?: number;

  /**
   * Cupos de PERSONAL. Acá el 0 SÍ vale y quiere decir algo preciso: "esta
   * cuenta no tiene ese rol". Con eso, una comunitaria sin técnicos propios
   * (el campo lo hace CPS) se configura con el mismo mecanismo que todo lo
   * demás, en vez de con una regla especial escrita en otro lado.
   */
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
 * Alta atómica de una organización COMMUNITY: cuenta + su único barrio + OWNER
 * institucional + membresía, en una sola transacción (AccountsService
 * #onboardCommunity). Solo CPS (controller). No pide `subtype` ni
 * `maxNeighborhoods`: una comunitaria SIEMPRE es COMMUNITY con cupo 1 —
 * pedirlo sería abrir la puerta a un valor inconsistente que el servicio de
 * todos modos va a pisar.
 */
export class OnboardCommunityDto {
  /** Nombre de la cuenta (la comunidad/consorcio) Y del usuario institucional OWNER. */
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name!: string;

  /**
   * La MODALIDAD DE VENTA, obligatoria: quién opera el barrio.
   *   CPS          -> llave en mano: CPS carga viviendas, vecinos y equipos.
   *   ORGANIZATION -> autogestión: la comunidad opera su barrio.
   * Sin default a propósito: es una decisión comercial y adivinarla dejaría a
   * un cliente sin poder tocar su propio barrio (o al revés) sin que nadie lo
   * haya decidido.
   */
  @IsEnum(ManagedBy, {
    message: 'Modalidad de gestión inválida (CPS u ORGANIZATION)',
  })
  managedBy!: ManagedBy;

  /** Igual que en CreateAccountDto: los cupos salen de acá o de los campos de abajo. */
  @IsOptional()
  @IsInt()
  @Min(1)
  planId?: number;

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

  /** Los de personal admiten 0 = "esta cuenta no tiene ese rol". */
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
