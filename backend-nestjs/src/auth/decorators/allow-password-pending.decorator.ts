import { SetMetadata } from '@nestjs/common';

export const ALLOW_PASSWORD_PENDING = 'auth:allow-password-pending';

/**
 * Marca un endpoint como accesible aunque el usuario tenga una clave
 * temporal sin cambiar (`mustChangePassword`). El `MustChangePasswordGuard`
 * es global y por defecto bloquea todo: esto es la lista blanca explícita
 * (cambiar la clave, ver el propio perfil, cerrar sesión).
 */
export const AllowPasswordPending = () =>
  SetMetadata(ALLOW_PASSWORD_PENDING, true);
