import {
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { EntityStatus, HomeMemberRole } from '../../common/enums';

export class CreateHomeDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name!: string;

  @IsInt()
  @Min(1)
  neighborhoodId!: number;

  @IsOptional()
  @IsString()
  address?: string;

  /** Teléfono DEL HOGAR (sobrevive a cambios de titular). */
  @IsOptional()
  @IsString()
  contactPhone?: string;

  /** Alarma preferida para eventos SINGLE. Debe ser del mismo barrio. */
  @IsOptional()
  @IsInt()
  @Min(1)
  defaultDeviceId?: number;

  @IsOptional()
  @IsLatitude({ message: 'Latitud inválida' })
  latitude?: number;

  @IsOptional()
  @IsLongitude({ message: 'Longitud inválida' })
  longitude?: number;
}

export class UpdateHomeDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  neighborhoodId?: number;

  @IsOptional()
  @IsString()
  address?: string;

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

export class AddHomeMemberDto {
  @IsInt()
  @Min(1)
  userId!: number;

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
