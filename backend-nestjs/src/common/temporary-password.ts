import { randomBytes } from 'node:crypto';

/**
 * Clave temporal de un solo uso (altas institucionales: OWNER, ver
 * UsersService#create y AccountsService#onboardCommunity). No hace falta que
 * sea memorizable: el flujo la muestra una vez y se cambia en el primer login
 * (MustChangePasswordGuard).
 */
export function generateTemporaryPassword(): string {
  return randomBytes(9).toString('base64url');
}
