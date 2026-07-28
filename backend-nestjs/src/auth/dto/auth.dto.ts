import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class LoginDto {
  /** username (panel), email o DNI (vecino) — lo que sea, se busca por los tres. */
  @IsString()
  @IsNotEmpty({ message: 'Falta el usuario, email o DNI' })
  identifier!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class VerifyEmailDto {
  @IsString()
  @IsNotEmpty()
  token!: string;
}

export class ForgotPasswordDto {
  @IsEmail({}, { message: 'El correo no es válido' })
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Falta el token' })
  token!: string;

  @IsString()
  @MinLength(8, {
    message: 'La contraseña nueva debe tener al menos 8 caracteres',
  })
  newPassword!: string;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Falta la contraseña actual' })
  currentPassword!: string;

  @IsString()
  @MinLength(8, {
    message: 'La contraseña nueva debe tener al menos 8 caracteres',
  })
  newPassword!: string;

  /**
   * Opcional en general; el servicio lo exige si el usuario todavía no tiene
   * correo y está cambiando una clave TEMPORAL (ver AuthService#changePassword)
   * — es el único momento garantizado en que un OWNER institucional pasa por acá.
   */
  @IsOptional()
  @IsEmail({}, { message: 'El correo no es válido' })
  email?: string;
}
