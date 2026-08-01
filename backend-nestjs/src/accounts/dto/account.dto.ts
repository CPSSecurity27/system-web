import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsDefined,
  IsEmail,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
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
  JurisdictionLevel,
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
 * El contrato que se firma junto con el alta de un cliente. Es de la CUENTA:
 * el sistema se vende a nivel municipal, la muni paga por N barrios y no le
 * revende a cada uno.
 *
 * NO lleva `accountId`: la cuenta se está creando en el mismo acto y todavía no
 * tiene id. Pedirlo sería pedirle al cliente un dato que no puede conocer.
 */
export class OnboardContractDto {
  /** NUMERIC(12,2) en la base. Es dinero: nunca punto flotante del lado servidor. */
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El precio admite hasta 2 decimales' },
  )
  @Min(0, { message: 'El precio no puede ser negativo' })
  price!: number;

  @IsDateString({}, { message: 'Fecha de inicio inválida (AAAA-MM-DD)' })
  startDate!: string;

  /**
   * OBLIGATORIA: el precio es por EL PERÍODO del contrato, así que sin fecha de
   * fin el número no significa nada. El período (trimestral, anual…) no se
   * manda ni se guarda: se deriva de las dos fechas.
   */
  @IsDateString({}, { message: 'Fecha de fin inválida (AAAA-MM-DD)' })
  endDate!: string;

  @IsOptional()
  @IsString()
  description?: string;
}

/**
 * Hasta dónde llega el cliente. Se pregunta SOLO en el alta municipal: la
 * comunitaria la deriva de su único barrio (siempre LOCALITY).
 *
 * El id que corresponde según el nivel lo valida el servicio: acá los dos son
 * opcionales porque cuál va depende de `level`.
 */
export class JurisdictionDto {
  @IsEnum(JurisdictionLevel, {
    message: 'Nivel de jurisdicción inválido (LOCALITY o DEPARTMENT)',
  })
  level!: JurisdictionLevel;

  @IsOptional()
  @IsInt()
  @Min(1)
  localityId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  departmentId?: number;

  /** Domicilio en el mapa. Opcional: ubica al cliente, no valida nada. */
  @IsOptional()
  @IsLatitude({ message: 'Latitud inválida' })
  latitude?: number;

  @IsOptional()
  @IsLongitude({ message: 'Longitud inválida' })
  longitude?: number;
}

/**
 * Alta atómica de una organización COMMUNITY: cuenta + su único barrio + OWNER
 * institucional + membresía + CONTRATO, en una sola transacción
 * (AccountsService #onboardCommunity). Solo CPS (controller). No pide `subtype`
 * ni `maxNeighborhoods`: una comunitaria SIEMPRE es COMMUNITY con cupo 1 —
 * pedirlo sería abrir la puerta a un valor inconsistente que el servicio de
 * todos modos va a pisar.
 *
 * El contrato es OBLIGATORIO acá y solo acá: la comunitaria nace con su barrio,
 * así que hay contra qué contratar. Una MUNICIPAL nace sin barrios y por eso su
 * alta (OnboardMunicipalDto) no lo pide.
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

  /** Opcional: si está, el OWNER puede recuperar su contraseña solo. */
  @IsOptional()
  @IsEmail({}, { message: 'Correo inválido' })
  ownerEmail?: string;

  /**
   * OJO con el `@IsDefined()`: sin él, `@ValidateNested()` sobre una propiedad
   * AUSENTE no valida nada —class-validator la saltea en silencio— y el objeto
   * llega al servicio como `undefined`. Resultado: 500 en vez de 400.
   */
  @IsDefined({ message: 'Falta el barrio de la comunidad' })
  @ValidateNested()
  @Type(() => OnboardCommunityNeighborhoodDto)
  neighborhood!: OnboardCommunityNeighborhoodDto;

  @IsDefined({ message: 'Una comunitaria no se puede crear sin contrato' })
  @ValidateNested()
  @Type(() => OnboardContractDto)
  contract!: OnboardContractDto;
}

/**
 * Alta atómica de una organización MUNICIPAL: cuenta + jurisdicción + OWNER
 * institucional + membresía + CONTRATO, en una sola transacción. Solo CPS.
 *
 * NO crea barrio: la municipalidad los crea después, contra su cupo. Un cliente
 * municipal con cero barrios es un estado VÁLIDO — el contrato es de la cuenta,
 * así que no depende de que exista un barrio.
 *
 * Existe para cerrar un bug real: antes el front encadenaba tres llamadas
 * (cuenta -> usuario -> membresía) y si fallaba una del medio quedaba una
 * cuenta creada SIN OWNER, que nadie podía administrar.
 */
export class OnboardMunicipalDto {
  /** Nombre de la cuenta Y del usuario institucional OWNER. */
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name!: string;

  /** Hasta dónde llega: una localidad o un departamento entero. */
  @IsDefined({ message: 'Falta la jurisdicción del cliente' })
  @ValidateNested()
  @Type(() => JurisdictionDto)
  jurisdiction!: JurisdictionDto;

  @IsDefined({ message: 'Un cliente no se puede crear sin contrato' })
  @ValidateNested()
  @Type(() => OnboardContractDto)
  contract!: OnboardContractDto;

  /** Igual que en CreateAccountDto: los cupos salen de acá o de los campos de abajo. */
  @IsOptional()
  @IsInt()
  @Min(1)
  planId?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(1, { message: 'Una municipalidad necesita al menos 1 barrio de cupo' })
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

  @IsString()
  @MinLength(3, { message: 'El usuario debe tener al menos 3 caracteres' })
  ownerUsername!: string;

  /** Opcional: si está, el OWNER puede recuperar su contraseña solo. */
  @IsOptional()
  @IsEmail({}, { message: 'Correo inválido' })
  ownerEmail?: string;
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
