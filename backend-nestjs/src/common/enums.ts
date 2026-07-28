/** Espejo de los tipos ENUM de PostgreSQL. Si cambia uno, cambia el otro. */

/**
 * Modelo v2 (docs/esquema-postgres-v2.sql): desaparece el tipo HOME. Todo
 * cliente es una ORGANIZATION (municipalidad o consorcio); los vecinos entran
 * por home_member, no por cuentas.
 */
export enum AccountType {
  COMPANY = 'COMPANY',
  ORGANIZATION = 'ORGANIZATION',
}

/** Solo para ORGANIZATION. Fija el default de gestión del barrio. */
export enum OrgSubtype {
  MUNICIPAL = 'MUNICIPAL',
  PRIVATE = 'PRIVATE',
}

/**
 * OWNER es el usuario INSTITUCIONAL de la cuenta (soberanía, exactamente uno).
 * ADMIN/TECHNICIAN/MONITOR son personas reales. Los cuatro valen en COMPANY y
 * en ORGANIZATION.
 */
export enum UserRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  TECHNICIAN = 'TECHNICIAN',
  MONITOR = 'MONITOR',
}

/** PERSON = humano con datos reales; INSTITUTIONAL = cuenta root (sin DNI). */
export enum UserKind {
  PERSON = 'PERSON',
  INSTITUTIONAL = 'INSTITUTIONAL',
}

/** Quién opera el barrio: CPS (esquema privado) o la propia organización. */
export enum ManagedBy {
  CPS = 'CPS',
  ORGANIZATION = 'ORGANIZATION',
}

/** El vecino en su hogar. Un TITULAR por hogar; FAMILIAR hasta el cupo. */
export enum HomeMemberRole {
  TITULAR = 'TITULAR',
  FAMILIAR = 'FAMILIAR',
}

export enum EntityStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  CLOSED = 'CLOSED',
}

export enum ContractStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

/** Extensible desde el día 1 (hoy solo se usa ALARM_PANEL). */
export enum DeviceType {
  ALARM_PANEL = 'ALARM_PANEL',
  SIREN = 'SIREN',
  REPEATER = 'REPEATER',
  SENSOR = 'SENSOR',
}

/**
 * Ciclo de vida completo: nace en INVENTORY (fábrica o stock de organización,
 * sin barrio) y muere en RETIRED. INVENTORY <=> neighborhood_id NULL (CHECK).
 */
export enum DeviceStatus {
  INVENTORY = 'INVENTORY',
  INSTALLED = 'INSTALLED',
  OPERATIONAL = 'OPERATIONAL',
  MAINTENANCE = 'MAINTENANCE',
  OUT_OF_SERVICE = 'OUT_OF_SERVICE',
  RETIRED = 'RETIRED',
}

export enum MaintenanceType {
  INSTALL = 'INSTALL',
  SERVICE = 'SERVICE',
  REPAIR = 'REPAIR',
  CHECK = 'CHECK',
  REPLACE = 'REPLACE',
}

export enum MaintenanceStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  DONE = 'DONE',
  CANCELLED = 'CANCELLED',
}

/** INVENTORY = en stock (fábrica CPS u organización), sin hogar. */
export enum RemoteStatus {
  INVENTORY = 'INVENTORY',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  LOST = 'LOST',
  REPLACED = 'REPLACED',
  CLOSED = 'CLOSED',
}

export enum EventOrigin {
  APP = 'APP',
  REMOTE = 'REMOTE',
  DEVICE = 'DEVICE',
  PANEL = 'PANEL',
}

/** Descriptivo: registra QUÉ pasó. Sin cupo — los eventos son ilimitados. */
export enum EventScope {
  SINGLE = 'SINGLE',
  COMMUNITY = 'COMMUNITY',
}

/** ACKNOWLEDGED quedó pospuesto (M5): agregarlo después no rompe nada. */
export enum EventStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
  FALSE_ALARM = 'FALSE_ALARM',
}

export enum LocationMode {
  LIVE = 'LIVE',
  FIXED = 'FIXED',
}

export enum UserTokenType {
  EMAIL_VERIFICATION = 'EMAIL_VERIFICATION',
  PASSWORD_RESET = 'PASSWORD_RESET',
  /** OTP por SMS/WhatsApp: el login del vecino (DNI + código). */
  PHONE_OTP = 'PHONE_OTP',
}

export enum UserDeviceStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}
