import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
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
} from 'class-validator';
import {
  DeviceStatus,
  DeviceType,
  MaintenanceStatus,
  MaintenanceType,
} from '../../common/enums';

/**
 * Alta de fábrica: SOLO CPS. Los dos datos obligatorios —`mac` y `boardNumber`—
 * se LEEN del equipo físico en la estación de flasheo; no se inventan.
 *
 * El `serial` NO está: en una alarma comunitaria se deriva de la MAC
 * (`AV-<12 hex>`) y es también el usuario MQTT y el `<id>` del tópico.
 *
 * Sin neighborhoodId el equipo nace en INVENTORY (fábrica o stock de una
 * organización) con claim code generado; con neighborhoodId es CPS instalando
 * directo.
 */
export class CreateDeviceDto {
  /** Etiqueta humana. En stock puede faltar; se pone al instalar. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  /**
   * MAC STA del equipo, tal como la devuelve `esptool read_mac`. Se acepta con
   * o sin separadores y en cualquier caja; el backend la normaliza y valida.
   */
  @IsString()
  @IsNotEmpty({ message: 'Falta la MAC del equipo' })
  mac!: string;

  /**
   * El número impreso en la placa, completo: `ALOY0043`. El modelo va adentro
   * del string —un solo campo, no dos— y el backend resuelve el prefijo contra
   * el catálogo de modelos.
   */
  @IsString()
  @IsNotEmpty({ message: 'Falta el número de placa (por ejemplo ALOY0043)' })
  boardNumber!: string;

  @IsOptional()
  @IsEnum(DeviceType, { message: 'Tipo de dispositivo inválido' })
  type: DeviceType = DeviceType.COMMUNITY_ALARM;

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
  @IsLatitude({ message: 'Latitud inválida' })
  latitude?: number;

  @IsOptional()
  @IsLongitude({ message: 'Longitud inválida' })
  longitude?: number;
}

/**
 * Los datos de INSTALACIÓN, compartidos por el reclamo y la edición.
 *
 * Todos OPCIONALES —nadie mide la altura exacta colgado de una escalera— pero
 * recomendados: es lo que un técnico necesita saber ANTES de subirse. Se cargan
 * al instalar y se completan o corrigen después.
 */
export class InstallationDataDto {
  /** Número de poste o columna. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  poleNumber?: string;

  /** Altura de montaje en metros. El CHECK de la base la acota a (0, 30]. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 }, { message: 'La altura admite 1 decimal' })
  @Min(0.1, { message: 'La altura tiene que ser mayor a 0' })
  @Max(30, { message: 'La altura no puede superar los 30 metros' })
  heightM?: number;

  /** La esquina, entre qué calles. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  reference?: string;

  /** De qué luminaria o tablero toma energía. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  powerPoint?: string;

  /** Lo que no entra en los otros cuatro. */
  @IsOptional()
  @IsString()
  installNotes?: string;
}

/**
 * CLAIM: el técnico (de CPS o de la organización dueña del stock) vincula el
 * equipo a SU barrio con serial + código. El código es de un solo uso.
 *
 * Hereda los datos de instalación: el mejor momento para cargarlos es cuando el
 * técnico está parado abajo del poste.
 */
export class ClaimDeviceDto extends InstallationDataDto {
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

/**
 * El `serial` NO está: es la identidad física del equipo y no se cambia.
 *
 * Hereda los datos de instalación: se completan y corrigen después, que es como
 * pasa en la realidad.
 */
export class UpdateDeviceDto extends InstallationDataDto {
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

/**
 * ENTREGA DE LOTE: fábrica -> organización, en UNA llamada.
 *
 * Existe porque entregar 50 alarmas eran 50 PATCH desde el front, cada uno con
 * su chance de fallar por la mitad y dejar el lote a medio entregar. Acá o van
 * todas o no va ninguna.
 *
 * `organizationId: null` devuelve a fábrica.
 */
export class DeliverDevicesDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Elegí al menos un equipo' })
  @ArrayMaxSize(500, { message: 'Máximo 500 equipos por entrega' })
  @IsInt({ each: true })
  @Min(1, { each: true })
  deviceIds!: number[];

  /** La organización que recibe. `null` = vuelve al stock de fábrica. */
  @IsOptional()
  @IsInt()
  @Min(1)
  organizationId?: number | null;
}

/**
 * Marcar o desmarcar hitos de puesta en marcha (solo CPS, desde la fábrica).
 *
 * `true` sella el hito con la hora del servidor; `false` lo borra (se cargó el
 * equipo equivocado, y sin poder deshacerlo la única salida sería un UPDATE a
 * mano en la base). La fecha NO se acepta del cliente: un hito con fecha
 * elegida por quien lo carga deja de ser evidencia de nada.
 *
 * Los otros dos hitos no están acá a propósito: `createdAt` es el alta y
 * `provisionedAt` lo escribe el provisioning cuando registra la credencial.
 */
export class UpdateDeviceMilestonesDto {
  @IsOptional()
  @IsBoolean()
  labeled?: boolean;

  /**
   * Override MANUAL de la primera conexión. Lo normal es que lo informe el
   * servicio de alarmas (regla 5); esto existe porque el GtD todavía no
   * escribe, y queda registrado como manual y auditado.
   */
  @IsOptional()
  @IsBoolean()
  connected?: boolean;
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
