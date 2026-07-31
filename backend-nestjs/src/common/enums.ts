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

/**
 * Solo para ORGANIZATION. Dice la ESCALA del cliente, y nada más:
 *   MUNICIPAL -> gestiona varios barrios (hasta su cupo)
 *   COMMUNITY -> gestiona UNO solo (cupo fijo en 1, invariante de negocio)
 *
 * QUIÉN OPERA cada barrio es otra pregunta y vive en `neighborhood.managed_by`,
 * porque se decide barrio por barrio: una comunitaria se vende llave en mano
 * (CPS opera) o autogestionada, y una municipal puede tercerizarle un barrio a
 * CPS teniendo los otros nueve propios. Fusionar los dos ejes en este enum
 * haría imposible los dos casos.
 *
 * Se llamaba PRIVATE hasta 2026-07-30: el nombre describía la propiedad legal
 * del barrio, que no es lo que distingue a las dos organizaciones, y chocaba
 * con `managed_by`.
 */
export enum OrgSubtype {
  MUNICIPAL = 'MUNICIPAL',
  COMMUNITY = 'COMMUNITY',
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

/**
 * Extensible desde el día 1, pero hoy solo se usa COMMUNITY_ALARM: el poste con
 * sirena en la vía pública. Los otros tres están reservados y el alta los
 * RECHAZA (400) — una rama que nadie probó es donde se cuelan los bugs.
 *
 * Se llama COMMUNITY_ALARM y no "panel" a propósito: un panel es la cajita en la
 * pared de una casa, que es exactamente lo que la regla 1 del dominio dice que
 * esto NO es.
 */
export enum DeviceType {
  COMMUNITY_ALARM = 'COMMUNITY_ALARM',
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

/**
 * Cómo se supo de un hito del equipo. La diferencia importa: la primera
 * conexión la OBSERVA el broker (regla 5: el estado vivo lo escribe el
 * servicio de alarmas), pero mientras el GtD no exista CPS necesita poder
 * marcarla a mano. Guardar el origen evita que un dato tipeado se confunda
 * con uno medido.
 */
export enum DeviceMilestoneSource {
  OBSERVED = 'OBSERVED',
  MANUAL = 'MANUAL',
}

/**
 * Etapa de puesta en marcha. NO se guarda en la base: se DERIVA del último
 * hito alcanzado (ver `deviceStage`). Tener también una columna sería un
 * segundo lugar donde vive el mismo dato, libre de contradecir a las fechas.
 */
export enum DeviceStage {
  CREATED = 'CREATED',
  PROVISIONED = 'PROVISIONED',
  LABELED = 'LABELED',
  CONNECTED = 'CONNECTED',
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
