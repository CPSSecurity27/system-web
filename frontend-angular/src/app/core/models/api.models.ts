import { AccountType, HomeMemberRole, OrgSubtype, UserRole } from '../auth/auth.models';
// esbuild compila cada archivo aislado (isolatedModules): un import solo no
// alcanza para que OTRO archivo pueda traer OrgSubtype desde ACÁ, hace falta
// re-exportarlo explícito.
export type { OrgSubtype };

/** /accounts, /users y /events vienen paginados; el resto son arrays pelados. */
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export type EntityStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

/** PERSON = humano real; INSTITUTIONAL = la "cuenta root" (OWNER, sin DNI). */
export type UserKind = 'PERSON' | 'INSTITUTIONAL';

export interface User {
  id: number;
  name: string;
  kind: UserKind;
  /** null para vecinos: entran por email o DNI, sin handle de panel. */
  username: string | null;
  /** La identidad del vecino. null para usuarios de panel e institucionales. */
  dni: string | null;
  email: string | null;
  telephone: string | null;
  status: EntityStatus;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  /** La cuenta a la que pertenece (a lo sumo una). null: vecino sin membresía de panel. */
  account: { id: number; name: string; role: UserRole } | null;
}

/**
 * v2: el cliente SIEMPRE es una organización. Los cupos (max*) son la tarifa:
 * los ve todo el mundo, pero SOLO CPS los modifica (endpoints /quotas).
 * null = sin límite.
 */
export interface Account {
  id: number;
  name: string;
  type: AccountType;
  subtype: OrgSubtype | null;
  status: EntityStatus;
  maxNeighborhoods: number | null;
  maxMonitorUsers: number | null;
}

export interface Member {
  id: number;
  accountId: number;
  userId: number;
  role: UserRole;
  user: User;
}

/** Quién opera el barrio: CPS (esquema privado) o la propia organización. */
export type ManagedBy = 'CPS' | 'ORGANIZATION';

export interface Home {
  id: number;
  name: string;
  address: string | null;
  /** Teléfono DEL HOGAR: sobrevive a los cambios de titular. */
  contactPhone: string | null;
  /** Alarma preferida para eventos SINGLE. Del mismo barrio. */
  defaultDeviceId: number | null;
  status: EntityStatus;
  latitude: number | null;
  longitude: number | null;
  neighborhoodId: number;
}

/** El vecino en su casa (reemplaza a las cuentas HOME del modelo viejo). */
/**
 * Alcance por barrio de un TECHNICIAN/MONITOR (staff_assignment). SIN filas,
 * el miembro ve TODOS los barrios de su organización; CON filas, solo esos.
 */
export interface StaffAssignment {
  id: number;
  accountUserId: number;
  accountId: number;
  neighborhoodId: number;
  neighborhood?: { id: number; name: string } | null;
}

export interface HomeMember {
  id: number;
  homeId: number;
  userId: number;
  role: HomeMemberRole;
  status: EntityStatus;
  user: User;
}

/**
 * La alarma es del BARRIO, no de la vivienda: postes en la vía pública.
 *
 * Ciclo de vida v2: nace en INVENTORY (fábrica CPS o stock de una organización,
 * neighborhoodId null) y se instala por CLAIM (serial + código de un solo uso).
 */
export type DeviceType = 'ALARM_PANEL' | 'SIREN' | 'REPEATER' | 'SENSOR';
export type DeviceStatus =
  'INVENTORY' | 'INSTALLED' | 'OPERATIONAL' | 'MAINTENANCE' | 'OUT_OF_SERVICE' | 'RETIRED';

export interface Device {
  id: number;
  /** En stock puede no tener nombre todavía: se pone al instalar. */
  name: string | null;
  serial: string;
  type: DeviceType;
  status: DeviceStatus;
  /** Solo mientras está en INVENTORY. Se necesita para el claim. */
  claimCode: string | null;
  /** Stock de una organización (entrega del lote). null = fábrica CPS. */
  organizationId: number | null;
  neighborhoodId: number | null;
  tested: boolean;
  latitude: number | null;
  longitude: number | null;
  installedAt: string | null;
}

/**
 * Estado VIVO de la alarma. Lo escribe ÚNICAMENTE el servicio de alarmas
 * (programa aparte). Hasta que ese servicio exista, este dato es null:
 * mostrar "sin datos", no inventar.
 */
export interface DeviceState {
  deviceId: number;
  online: boolean;
  /** Catálogo del hardware: 'connected' | 'trigger' | ... */
  alarmStatus: string | null;
  lastHeartbeat: string | null;
  updatedAt: string;
}

export type MaintenanceType = 'INSTALL' | 'SERVICE' | 'REPAIR' | 'CHECK' | 'REPLACE';
export type MaintenanceStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';

export interface Maintenance {
  id: number;
  deviceId: number;
  type: MaintenanceType;
  status: MaintenanceStatus;
  description: string | null;
  performedAt: string | null;
  userId: number;
  user?: User;
}

/**
 * DUEÑO ≠ PORTADOR. `homeId` es la vivienda dueña (null = en stock);
 * `assignedToUserId` es quién lo lleva encima hoy y debe ser MIEMBRO del hogar.
 */
export type RemoteStatus = 'INVENTORY' | 'ACTIVE' | 'SUSPENDED' | 'LOST' | 'REPLACED' | 'CLOSED';

export interface Remote {
  id: number;
  name: string;
  status: RemoteStatus;
  homeId: number | null;
  /** Stock de una organización. null = fábrica CPS (si tampoco hay homeId). */
  organizationId: number | null;
  assignedToUserId: number | null;
  assignedToUser?: User | null;
  deviceId: number | null;
}

/**
 * Posición (1..4) y fecha. **NUNCA el código.** Solo CPS puede revelar el
 * valor, de a uno, con /remotes/:id/codes/:codeId/reveal. No cachearlo.
 */
export interface RemoteCode {
  id: number;
  position: number;
  createdAt: string;
}

export type ContractStatus = 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'CANCELLED';

/**
 * v2: SIEMPRE organización → barrio, comercial puro. Los cupos ya no viven
 * acá: van en la cuenta y en el barrio (solo CPS los toca).
 */
export interface Contract {
  id: number;
  price: number;
  description: string | null;
  startDate: string;
  endDate: string | null;
  status: ContractStatus;
  accountId: number;
  neighborhoodId: number;
}

// --- Eventos (el tablero del monitoreo) ------------------------------------

export type EventOrigin = 'APP' | 'REMOTE' | 'DEVICE' | 'PANEL';
export type EventScope = 'SINGLE' | 'COMMUNITY';
export type EventStatus = 'OPEN' | 'RESOLVED' | 'FALSE_ALARM';

/**
 * Una activación de alarma. Append-only e ILIMITADO. El `id` es string
 * (bigint). activatorName/resolverName son snapshots CONGELADOS al momento
 * del evento: no se actualizan aunque el vecino cambie sus datos.
 */
export interface AlarmEvent {
  id: string;
  neighborhoodId: number;
  deviceId: number | null;
  homeId: number | null;
  remoteId: number | null;
  origin: EventOrigin;
  scope: EventScope;
  triggerMode: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  activatorUserId: number | null;
  activatorName: string | null;
  activatorPhone: string | null;
  status: EventStatus;
  resolvedByUserId: number | null;
  resolverName: string | null;
  resolvedAt: string | null;
  createdAt: string;
  /** Solo en el detalle (GET /events/:id); el listado no las trae. */
  responses?: EventResponse[];
}

/** "Estoy yendo": la respuesta de un vecino o del monitoreo a un evento. */
export interface EventResponse {
  id: number;
  eventId: string;
  userId: number | null;
  note: string | null;
  createdAt: string;
  /** Viene en el detalle del evento. */
  user?: User | null;
}
