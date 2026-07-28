import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { EntityStatus, UserKind } from '../../common/enums';

/** Filtros del padrón de usuarios (solo CPS). */
export class FindUsersQuery {
  /** Busca en nombre, username, dni y email a la vez. */
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'La búsqueda necesita al menos 2 caracteres' })
  search?: string;

  @IsOptional()
  @IsEnum(EntityStatus)
  status?: EntityStatus;

  /** Paginado obligatorio: la tabla crece con cada vecino de cada barrio. */
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

/**
 * v2.2 — tres formas de identidad:
 *  - Usuario de panel: username + password (persona real).
 *  - Usuario institucional (OWNER): username, kind INSTITUTIONAL, sin DNI.
 *    Solo lo crea CPS. SIN password: el sistema genera una clave TEMPORAL
 *    (ver UsersService.create) que hay que cambiar en el primer login — un
 *    admin de CPS no debe conocer la clave permanente de una cuenta ajena.
 *  - Vecino: email (activa la cuenta por mail: fija su propia contraseña), DNI
 *    opcional. username y password NO se mandan acá — ver UsersService.create.
 * Regla de la base: username, dni o email — al menos uno.
 */
export class CreateUserDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name!: string;

  @IsOptional()
  @IsEnum(UserKind)
  kind?: UserKind;

  /** Handle de login del panel. Los vecinos no lo usan (entran por email/DNI). */
  @IsOptional()
  @IsString()
  @MinLength(3, { message: 'El usuario debe tener al menos 3 caracteres' })
  username?: string;

  /** Dato del vecino, opcional. 7-9 dígitos, sin puntos. Sirve además para loguear. */
  @IsOptional()
  @Matches(/^\d{7,9}$/, { message: 'El DNI son 7 a 9 dígitos, sin puntos' })
  dni?: string;

  /**
   * Obligatoria si hay username Y no es institucional (login de panel). Los
   * vecinos no la mandan (activan por mail); un institucional TAMPOCO (recibe
   * una clave temporal generada por el sistema — ver UsersService.create).
   */
  @ValidateIf(
    (dto: CreateUserDto) =>
      dto.username !== undefined && dto.kind !== UserKind.INSTITUTIONAL,
  )
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  password?: string;

  /**
   * Obligatorio para un vecino (sin username): es su identidad de login y a
   * ese correo llega el mail para activar la cuenta. Si hay username, es
   * opcional como cualquier dato de contacto.
   */
  @ValidateIf((dto: CreateUserDto) => !dto.username || dto.email !== undefined)
  @IsNotEmpty({ message: 'El correo es obligatorio para un vecino' })
  @IsEmail({}, { message: 'El correo no es válido' })
  email?: string;

  @IsOptional()
  @IsString()
  telephone?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsEmail({}, { message: 'El correo no es válido' })
  email?: string;

  @IsOptional()
  @IsString()
  telephone?: string;

  /** Suspender a alguien lo deja afuera EN EL ACTO: el guard relee la base. */
  @IsOptional()
  @IsEnum(EntityStatus)
  status?: EntityStatus;
}
