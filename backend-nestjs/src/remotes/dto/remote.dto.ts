import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { RemoteStatus } from '../../common/enums';

export class CreateRemoteDto {
  /** Etiqueta humana: "llavero cocina", "Control (stock)". */
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name!: string;

  /**
   * La vivienda DUEÑA. Si falta, el control nace en INVENTARIO (solo CPS) y
   * después se entrega con /remotes/:id/assign.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  homeId?: number;

  /** Stock de una organización (entrega del lote). Solo sin homeId. */
  @IsOptional()
  @IsInt()
  @Min(1)
  organizationId?: number;

  /** El PORTADOR: quién lo lleva encima. Se reasigna libremente. */
  @IsOptional()
  @IsInt()
  @Min(1)
  assignedToUserId?: number;

  /** La alarma donde está grabado el RF. Tiene que ser del mismo barrio. */
  @IsOptional()
  @IsInt()
  @Min(1)
  deviceId?: number;
}

/** Entrega física: control del stock -> una vivienda. Desde ahí el dueño no cambia. */
export class AssignRemoteDto {
  @IsInt()
  @Min(1)
  homeId!: number;
}

/** `homeId` NO está: la vivienda es DUEÑA del control y eso no se transfiere. */
export class UpdateRemoteDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsEnum(RemoteStatus, { message: 'Estado de control inválido' })
  status?: RemoteStatus;

  /** `null` = desasignar (el control queda en la casa, sin portador). */
  @IsOptional()
  @IsInt()
  @Min(1)
  assignedToUserId?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  deviceId?: number | null;
}

export class AddRemoteCodeDto {
  /**
   * El código RF EN CLARO. Se cifra con AES-256-GCM antes de tocar la base y
   * nunca se loguea. Este es el único momento en que viaja en claro.
   */
  @IsString()
  @Matches(/^[A-Za-z0-9]{4,32}$/, {
    message: 'El código admite 4 a 32 caracteres alfanuméricos',
  })
  code!: string;

  /** 1..4 (M2: el hardware tiene 4 códigos). El tope lo impone el esquema. */
  @IsInt()
  @Min(1, { message: 'La posición va de 1 a 4' })
  @Max(4, { message: 'La posición va de 1 a 4' })
  position!: number;
}
