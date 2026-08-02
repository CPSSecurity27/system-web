import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { EntityStatus, ManagedBy } from '../../common/enums';

export class CreateNeighborhoodDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name!: string;

  @IsInt()
  @Min(1)
  localityId!: number;

  /**
   * La organización cliente. Obligatorio para CPS; el admin de una organización
   * lo puede omitir (se usa la suya) y no puede indicar una ajena.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  organizationId?: number;

  /** Solo CPS lo pisa; el default sale del subtipo de la organización. */
  @IsOptional()
  @IsEnum(ManagedBy)
  managedBy?: ManagedBy;

  @IsOptional()
  @IsLatitude({ message: 'Latitud inválida' })
  latitude?: number;

  @IsOptional()
  @IsLongitude({ message: 'Longitud inválida' })
  longitude?: number;
}

export class UpdateNeighborhoodDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  localityId?: number;

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

/** CUPOS del barrio = tarifa. Solo CPS. */
export class UpdateNeighborhoodQuotasDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  maxFamilyMembers?: number;

  @IsOptional()
  @IsBoolean()
  remoteControlsEnabled?: boolean;

  /** Disparar TODAS las alarmas del barrio desde la app del vecino. */
  @IsOptional()
  @IsBoolean()
  communityScopeEnabled?: boolean;
}

/** Transferencia de comunidad. Solo CPS. La operación más sensible del negocio. */
export class TransferNeighborhoodDto {
  @IsInt()
  @Min(1)
  organizationId!: number;

  /** Opcional: default según el subtipo de la organización destino. */
  @IsOptional()
  @IsEnum(ManagedBy)
  managedBy?: ManagedBy;
}
