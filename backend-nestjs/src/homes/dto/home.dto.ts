import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { EntityStatus, HomeMemberRole } from '../../common/enums';

/**
 * Una persona que vive en la casa: titular o familiar, mismos campos.
 *
 * Nombre y DNI y nada más obligatorio. El DNI es la identidad de login del
 * vecino, así que se valida en serio (7 a 9 dígitos, sin puntos): en el modelo
 * viejo había DNIs de 4 dígitos y eso, con el DNI como llave de entrada, es un
 * problema y no un dato feo.
 */
export class ResidentDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name!: string;

  @Matches(/^\d{7,9}$/, { message: 'El DNI son 7 a 9 dígitos, sin puntos' })
  dni!: string;

  /** Viaja al evento como `activator_phone`. */
  @IsOptional()
  @IsString()
  telephone?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Fecha de nacimiento inválida (YYYY-MM-DD)' })
  birthDate?: string;

  /** Si está, se le manda el mail de activación como atajo. */
  @IsOptional()
  @IsEmail({}, { message: 'El correo no es válido' })
  email?: string;
}

/**
 * Alta de vivienda: es UN SOLO ACTO que termina en una casa con titular. No
 * existe la vivienda sin dueño, así que `titular` no es opcional.
 *
 * La DIRECCIÓN identifica la vivienda (no hay `name`) y el GPS es obligatorio:
 * sale en el mapa del monitoreo y en el `gps` del evento.
 */
export class CreateHomeDto {
  @IsString()
  @IsNotEmpty({ message: 'La dirección es obligatoria' })
  address!: string;

  /** El barrio: la comunidad a la que pertenece la vivienda. */
  @IsInt()
  @Min(1)
  neighborhoodId!: number;

  @IsLatitude({ message: 'Marcá la ubicación de la vivienda en el mapa' })
  latitude!: number;

  @IsLongitude({ message: 'Marcá la ubicación de la vivienda en el mapa' })
  longitude!: number;

  /** Teléfono DEL HOGAR (sobrevive a cambios de titular). */
  @IsOptional()
  @IsString()
  contactPhone?: string;

  /** Alarma preferida para eventos SINGLE. Debe ser del mismo barrio. */
  @IsOptional()
  @IsInt()
  @Min(1)
  defaultDeviceId?: number;

  /** El titular. Se crea junto con la vivienda, en la misma transacción. */
  @ValidateNested()
  @Type(() => ResidentDto)
  titular!: ResidentDto;
}

export class UpdateHomeDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'La dirección es obligatoria' })
  address?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  neighborhoodId?: number;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  /** `null` explícito = quitar la preferencia. */
  @IsOptional()
  @IsInt()
  @Min(1)
  defaultDeviceId?: number | null;

  @IsOptional()
  @IsLatitude({ message: 'Latitud inválida' })
  latitude?: number;

  @IsOptional()
  @IsLongitude({ message: 'Longitud inválida' })
  longitude?: number;

  @IsOptional()
  @IsEnum(EntityStatus)
  status?: EntityStatus;
}

/**
 * Alta de miembro, en dos formas:
 *  - `person`: la persona todavía no existe (el caso normal — un familiar que
 *    se carga por primera vez). Se crea el usuario y la membresía juntos.
 *  - `userId`: la persona YA existe en el padrón.
 *
 * Una de las dos, no las dos. El servicio lo valida porque class-validator no
 * expresa bien un "exactamente uno de estos dos campos".
 */
export class AddHomeMemberDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ResidentDto)
  person?: ResidentDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  userId?: number;

  /**
   * TITULAR: uno por hogar, lo asigna el gestor. FAMILIAR: hasta el cupo del
   * barrio; el titular puede darlos de alta desde la app.
   */
  @IsEnum(HomeMemberRole, { message: 'Rol inválido (TITULAR o FAMILIAR)' })
  role!: HomeMemberRole;
}

export class UpdateHomeMemberStatusDto {
  @IsEnum(EntityStatus)
  status!: EntityStatus;
}

export class TransferHomeTitularDto {
  /** Miembro ACTIVO del hogar que recibe la titularidad; el saliente queda FAMILIAR. */
  @IsInt()
  @Min(1)
  newTitularUserId!: number;
}
