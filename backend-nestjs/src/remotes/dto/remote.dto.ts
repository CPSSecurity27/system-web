import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RemoteStatus } from '../../common/enums';

/**
 * Filtros del listado de controles ENTREGADOS (el de Operar).
 *
 * Todos son opcionales y todos se INTERSECTAN con el alcance del que pregunta:
 * pedir el barrio del vecino de al lado no amplía nada, devuelve vacío.
 *
 * La paginación no es un lujo: un barrio con 10 alarmas puede tener ~1200
 * controles y una municipal con 10 barrios se va a ~12.000. Traer eso en un
 * array era la pantalla anterior.
 */
export class FindRemotesQuery {
  /** El CLIENTE dueño del barrio (account ORGANIZATION: muni o comunidad). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  organizationId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  neighborhoodId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  homeId?: number;

  /**
   * La alarma PREFERIDA de la vivienda (`home.default_device_id`), no la alarma
   * donde están grabados los códigos del control (`remote.device_id`). Son dos
   * preguntas distintas y esta es la que pide el operador: "qué controles
   * dependen de este poste".
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  defaultDeviceId?: number;

  @IsOptional()
  @IsEnum(RemoteStatus, { message: 'Estado de control inválido' })
  status?: RemoteStatus;

  /** Un solo buscador: DNI, serial, dirección o nombre del portador. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

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

  /**
   * Quién lo lleva encima. OBLIGATORIO (decisión del 2026-08-05).
   *
   * El modelo admite `null` —"en el cajón de la casa"— y así queda cuando el
   * portador se saca después. Pero al ENTREGAR se exige: un control que sale
   * sin nombre es un control del que después nadie sabe quién lo tiene, y ese
   * dato es el que viaja en la alarma cuando alguien aprieta el botón.
   *
   * Tiene que ser miembro de ESA vivienda; lo valida el servicio.
   */
  @IsInt()
  @Min(1)
  assignedToUserId!: number;
}

/** Entrega de LOTE: stock de CPS -> stock de una organización. Solo CPS. */
export class DeliverRemotesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  remoteIds!: number[];

  /** `null` = vuelven al stock de fábrica. */
  @IsOptional()
  @IsInt()
  @Min(1)
  organizationId!: number | null;
}

/**
 * ADOPTAR: sumar un control al stock propio con serial + código.
 *
 * El código es lo que demuestra que el control está físicamente en tus manos.
 * El serial solo no alcanzaría: está impreso a la vista y viaja en los listados.
 */
export class AdoptRemoteDto {
  @IsString()
  @IsNotEmpty()
  serial!: string;

  @IsString()
  @IsNotEmpty()
  claimCode!: string;

  /** Se omite si pertenecés a una sola organización. CPS SÍ tiene que mandarlo. */
  @IsOptional()
  @IsInt()
  @Min(1)
  organizationId?: number;
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
