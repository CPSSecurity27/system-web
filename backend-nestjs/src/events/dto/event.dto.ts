import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  EventOrigin,
  EventScope,
  EventStatus,
  LocationMode,
} from '../../common/enums';

export class FindEventsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  neighborhoodId?: number;

  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;
}

/**
 * Alta manual desde el panel (origin PANEL) o desde la app (origin APP).
 * El servicio de alarmas NO usa este endpoint: inserta directo en la base
 * (arquitectura de dos programas, §8 del diseño).
 */
export class CreateEventDto {
  @IsInt()
  @Min(1)
  neighborhoodId!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  deviceId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  homeId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  remoteId?: number;

  @IsEnum(EventOrigin)
  origin!: EventOrigin;

  @IsOptional()
  @IsEnum(EventScope)
  scope?: EventScope;

  /** Catálogo del hardware: cps001, cps002... */
  @IsOptional()
  @IsString()
  triggerMode?: string;

  @IsOptional()
  @IsLatitude()
  gpsLat?: number;

  @IsOptional()
  @IsLongitude()
  gpsLng?: number;

  @IsOptional()
  @IsEnum(LocationMode)
  locationMode?: LocationMode;
}

/** El MONITOR cierra el evento: resuelto o falsa alarma. */
export class ResolveEventDto {
  @IsEnum(EventStatus, { message: 'RESOLVED o FALSE_ALARM' })
  status!: EventStatus;
}

export class RespondEventDto {
  @IsOptional()
  @IsString()
  note?: string;
}
