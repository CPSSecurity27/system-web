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

  /**
   * OBLIGATORIAS: el barrio sale en el tablero de clientes y en el mapa del
   * monitoreo, y un punto opcional deja el mapa a medias. Lo exige también la
   * base (NOT NULL desde `MandatoryCoordinates`); acá se valida antes para que
   * el error sea uno de negocio y no un 500 del driver.
   */
  @IsLatitude({ message: 'Marcá el barrio en el mapa (latitud inválida)' })
  latitude!: number;

  @IsLongitude({ message: 'Marcá el barrio en el mapa (longitud inválida)' })
  longitude!: number;

  /**
   * ACTIVACIÓN COMUNITARIA con la que nace el barrio: si el vecino puede
   * activar todas las alarmas o una distinta de la de su vivienda.
   *
   * Ausente = hereda el valor de la cuenta, que es lo que se le vendió.
   *
   * Es un CUPO, así que SOLO CPS puede mandarlo (regla 4): el servicio rechaza
   * con 403 al admin de una organización que intente fijarlo. Sin ese chequeo,
   * un cliente se auto-otorgaría en el alta lo que no puede cambiar después
   * por `/quotas`.
   */
  @IsOptional()
  @IsBoolean({ message: 'Activación comunitaria: verdadero o falso' })
  communityScopeEnabled?: boolean;
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
