import { Type } from 'class-transformer';
import {
  IsDateString,
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
 * v2.3 (2026-08-02) — tres formas de identidad:
 *  - Usuario de panel: username + password (persona real).
 *  - Usuario institucional (OWNER): username, kind INSTITUTIONAL, sin DNI.
 *    Solo lo crea CPS. SIN password: el sistema genera una clave TEMPORAL
 *    (ver UsersService.create) que hay que cambiar en el primer login — un
 *    admin de CPS no debe conocer la clave permanente de una cuenta ajena.
 *  - **Vecino: nombre + DNI**. El DNI es su identidad de login, como en el
 *    modelo viejo. El email pasó a ser un dato de contacto más: si está, se le
 *    manda el mail de activación; si no, la activación la resuelve la app.
 *    username y password NO se mandan acá — ver UsersService.create.
 *
 * Regla de la base: username, dni o email — al menos uno.
 */
export class CreateUserDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  name!: string;

  @IsOptional()
  @IsEnum(UserKind)
  kind?: UserKind;

  /** Handle de login del panel. Los vecinos no lo usan (entran por DNI). */
  @IsOptional()
  @IsString()
  @MinLength(3, { message: 'El usuario debe tener al menos 3 caracteres' })
  username?: string;

  /**
   * OBLIGATORIO para un vecino (sin username): es su identidad de login.
   * 7 a 9 dígitos sin puntos — si con esto se entra al sistema, no se afloja.
   */
  @ValidateIf((dto: CreateUserDto) => !dto.username || dto.dni !== undefined)
  @IsNotEmpty({ message: 'El DNI es obligatorio para un vecino' })
  @Matches(/^\d{7,9}$/, { message: 'El DNI son 7 a 9 dígitos, sin puntos' })
  dni?: string;

  /**
   * Obligatoria si hay username Y no es institucional (login de panel). Los
   * vecinos no la mandan (la fijan al activar); un institucional TAMPOCO
   * (recibe una clave temporal del sistema — ver UsersService.create).
   */
  @ValidateIf(
    (dto: CreateUserDto) =>
      dto.username !== undefined && dto.kind !== UserKind.INSTITUTIONAL,
  )
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  password?: string;

  /** Dato de contacto. Si está, habilita activar la cuenta por mail. */
  @IsOptional()
  @IsEmail({}, { message: 'El correo no es válido' })
  email?: string;

  @IsOptional()
  @IsString()
  telephone?: string;

  /** Dato opcional del vecino. */
  @IsOptional()
  @IsDateString({}, { message: 'Fecha de nacimiento inválida (YYYY-MM-DD)' })
  birthDate?: string;
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

  @IsOptional()
  @IsDateString({}, { message: 'Fecha de nacimiento inválida (YYYY-MM-DD)' })
  birthDate?: string;

  /** Suspender a alguien lo deja afuera EN EL ACTO: el guard relee la base. */
  @IsOptional()
  @IsEnum(EntityStatus)
  status?: EntityStatus;
}
