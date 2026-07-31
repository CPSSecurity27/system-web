/**
 * Modelo v2: ya NO existen las cuentas HOME ni el rol USER/MEMBER. Todo cliente
 * es una ORGANIZATION (municipio o comunidad); el vecino no tiene cuenta — se
 * reconoce por sus membresías de HOGAR (`homeMemberships`).
 */
export type AccountType = 'COMPANY' | 'ORGANIZATION';
/**
 * Solo ORGANIZATION. La ESCALA del cliente y nada más:
 *   MUNICIPAL -> varios barrios (hasta su cupo)
 *   COMMUNITY -> uno solo (cupo fijo en 1)
 * QUIÉN OPERA cada barrio es otra cosa y vive en `Neighborhood.managedBy`.
 * (Se llamaba PRIVATE hasta 2026-07-30.)
 */
export type OrgSubtype = 'MUNICIPAL' | 'COMMUNITY';
export type UserRole = 'OWNER' | 'ADMIN' | 'TECHNICIAN' | 'MONITOR';
export type HomeMemberRole = 'TITULAR' | 'FAMILIAR';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Una membresía es el par (tipo de cuenta, rol). El rol solo NO alcanza:
 * ADMIN en COMPANY es el admin de CPS; ADMIN en ORGANIZATION es el operador
 * de un municipio o comunidad.
 */
export interface Membership {
  membershipId: number;
  accountId: number;
  accountType: AccountType;
  /** Solo ORGANIZATION. Ej: una organización COMMUNITY gestiona UN solo barrio. */
  subtype: OrgSubtype | null;
  role: UserRole;
}

/** El vecino en su casa. Es la puerta de la app de vecinos. */
export interface HomeMembership {
  homeId: number;
  role: HomeMemberRole;
}

/** Respuesta de GET /auth/me. Un usuario puede tener VARIAS membresías. */
export interface Me {
  id: number;
  /** null para vecinos: entran por DNI, no tienen handle de panel. */
  username: string | null;
  name?: string;
  email?: string | null;
  emailVerified: boolean;
  /** Clave TEMPORAL sin cambiar (hoy solo pasa con el OWNER institucional). Bloquea todo menos /perfil. */
  mustChangePassword: boolean;
  memberships: Membership[];
  homeMemberships: HomeMembership[];
}

/** `identifier`: username (panel) o email/DNI (vecino) — el backend prueba los tres. */
export interface LoginRequest {
  identifier: string;
  password: string;
}
