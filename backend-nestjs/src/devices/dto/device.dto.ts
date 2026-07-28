import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import {
  DeviceStatus,
  DeviceType,
  MaintenanceStatus,
  MaintenanceType,
} from '../../common/enums';

/**
 * Alta: SOLO CPS. Sin neighborhoodId el equipo nace en INVENTORY (fábrica o
 * stock de una organización) con claim code generado; con neighborhoodId es
 * CPS instalando directo.
 */
export class CreateDeviceDto {
  /** Etiqueta humana. En stock puede faltar; se pone al instalar. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  /**
   * Identidad física del equipo. De acá se DERIVA la identidad en el canal de
   * tiempo real, así que se restringe el formato.
   */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{3,64}$/, {
    message:
      'El serial solo admite letras, números, guiones y guión bajo (3-64)',
  })
  serial!: string;

  @IsOptional()
  @IsEnum(DeviceType, { message: 'Tipo de dispositivo inválido' })
  type: DeviceType = DeviceType.ALARM_PANEL;

  /** Stock de una organización (entrega del lote). Incompatible con neighborhoodId. */
  @IsOptional()
  @IsInt()
  @Min(1)
  organizationId?: number;

  /** Instalación directa por CPS. Si falta, el equipo queda en inventario. */
  @IsOptional()
  @IsInt()
  @Min(1)
  neighborhoodId?: number;

  @IsOptional()
  @IsDateString({}, { message: 'Fecha de fabricación inválida' })
  manufacturedAt?: string;

  @IsOptional()
  @IsBoolean()
  tested?: boolean;

  @IsOptional()
  @IsString()
  imei?: string;

  @IsOptional()
  @IsString()
  iccid?: string;

  @IsOptional()
  @IsString()
  mac?: string;

  @IsOptional()
  @IsLatitude({ message: 'Latitud inválida' })
  latitude?: number;

  @IsOptional()
  @IsLongitude({ message: 'Longitud inválida' })
  longitude?: number;
}

/**
 * CLAIM: el técnico (de CPS o de la organización dueña del stock) vincula el
 * equipo a SU barrio con serial + código. El código es de un solo uso.
 */
export class ClaimDeviceDto {
  @IsString()
  @IsNotEmpty()
  serial!: string;

  @IsString()
  @IsNotEmpty()
  claimCode!: string;

  @IsInt()
  @Min(1)
  neighborhoodId!: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsLatitude({ message: 'Latitud inválida' })
  latitude?: number;

  @IsOptional()
  @IsLongitude({ message: 'Longitud inválida' })
  longitude?: number;
}

/** El `serial` NO está: es la identidad física del equipo y no se cambia. */
export class UpdateDeviceDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsEnum(DeviceStatus, { message: 'Estado de dispositivo inválido' })
  status?: DeviceStatus;

  /**
   * Entrega de stock: fábrica -> organización (`null` = devolver a fábrica).
   * Solo tiene efecto mientras el equipo está en INVENTORY (CHECK de la base).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  organizationId?: number | null;

  @IsOptional()
  @IsBoolean()
  tested?: boolean;

  @IsOptional()
  @IsLatitude({ message: 'Latitud inválida' })
  latitude?: number;

  @IsOptional()
  @IsLongitude({ message: 'Longitud inválida' })
  longitude?: number;

  @IsOptional()
  @IsDateString({}, { message: 'Fecha de instalación inválida' })
  installedAt?: string;
}

export class CreateMaintenanceDto {
  @IsEnum(MaintenanceType, { message: 'Tipo de mantenimiento inválido' })
  type!: MaintenanceType;

  @IsOptional()
  @IsEnum(MaintenanceStatus, { message: 'Estado de mantenimiento inválido' })
  status?: MaintenanceStatus;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Fecha inválida' })
  performedAt?: string;

  /** El técnico. Si no se manda, se asume el que carga la entrada. */
  @IsOptional()
  @IsInt()
  @Min(1)
  userId?: number;
}

export class UpdateMaintenanceDto {
  @IsOptional()
  @IsEnum(MaintenanceStatus, { message: 'Estado de mantenimiento inválido' })
  status?: MaintenanceStatus;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Fecha inválida' })
  performedAt?: string;
}
