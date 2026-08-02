import { AccountType, HomeMemberRole, OrgSubtype, UserRole } from '../auth/auth.models';
// esbuild compila cada archivo aislado (isolatedModules): un import solo no
// alcanza para que OTRO archivo pueda traer OrgSubtype desde ACÁ, hace falta
// re-exportarlo explícito.
export type { OrgSubtype };

/**
 * Hasta dónde llega el territorio de un cliente. Es lo que se le VENDIÓ: el
 * sistema se vende tanto a una localidad como a un departamento entero.
 */
export type JurisdictionLevel = 'LOCALITY' | 'DEPARTMENT';

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
  /**
   * De qué plan salieron los cupos al crear la cuenta. Etiqueta HISTÓRICA:
   * los cupos vigentes son los de abajo, nunca los del plan (que se pudo
   * haber reconfigurado después).
   */
  planId: number | null;
  /** CUPOS = tarifa. null solo en COMPANY, donde no aplican. */
  maxNeighborhoods: number | null;
  maxAdminUsers: number | null;
  /** 0 = la cuenta no tiene técnicos propios (el trabajo de campo lo hace CPS). */
  maxTechnicianUsers: number | null;
  maxMonitorUsers: number | null;
  /**
   * JURISDICCIÓN: hasta dónde llega el cliente. Es lo que se le VENDIÓ, y de
   * eso depende dónde puede crear barrios:
   *   LOCALITY   → solo en esa localidad
   *   DEPARTMENT → en cualquier localidad de ese departamento
   * null solo en COMPANY: CPS no tiene territorio.
   */
  jurisdictionLevel: JurisdictionLevel | null;
  localityId: number | null;
  departmentId: number | null;
  /** Domicilio en el mapa. Opcional: ubica al cliente, no valida nada. */
  latitude: number | null;
  longitude: number | null;
}

/**
 * El catálogo comercial (solo CPS). Es una PLANTILLA: al crear una cuenta sus
 * cupos se COPIAN, así que editar un plan no le cambia nada a quien ya lo
 * compró — para eso está PATCH /accounts/:id/quotas, cuenta por cuenta y
 * auditado.
 */
export interface Plan {
  id: number;
  code: string;
  name: string;
  description: string | null;
  appliesTo: OrgSubtype;
  /** Precio de LISTA; el que se cobra es el del contrato. Llega como string (NUMERIC). */
  priceReference: string | null;
  active: boolean;
  maxNeighborhoods: number;
  maxAdminUsers: number;
  maxTechnicianUsers: number;
  maxMonitorUsers: number;
  maxFamilyMembers: number;
  remoteControlsEnabled: boolean;
  communityScopeEnabled: boolean;
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
  /** IDENTIFICA la vivienda: no hay un `name` aparte (v2, 2026-08-02). */
  address: string;
  /** Teléfono DEL HOGAR: sobrevive a los cambios de titular. */
  contactPhone: string | null;
  /** Alarma preferida para eventos SINGLE. Del mismo barrio. */
  defaultDeviceId: number | null;
  status: EntityStatus;
  /** Obligatorios: salen en el mapa del monitoreo y en el `gps` del evento. */
  latitude: number;
  longitude: number;
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
  /**
   * El vecino ya fijó su contraseña. Derivado de `password_hash IS NOT NULL`
   * en el backend: mientras sea false, la cuenta existe pero nunca se usó.
   */
  activated: boolean;
}

/**
 * La alarma es del BARRIO, no de la vivienda: postes en la vía pública.
 *
 * Ciclo de vida v2: nace en INVENTORY (fábrica CPS o stock de una organización,
 * neighborhoodId null) y se instala por CLAIM (serial + código de un solo uso).
 */
export type DeviceType = 'COMMUNITY_ALARM' | 'SIREN' | 'REPEATER' | 'SENSOR';
/**
 * `INSTALLED` se eliminó (2026-07-31): era lo mismo que OPERATIONAL y el
 * backend nunca lo escribía.
 *
 * OJO: esto es lo que el equipo ES (estado administrativo). Si está online,
 * sonando o mudo es ESTADO VIVO y vive en `device_state`, que escribe
 * únicamente el servicio de alarmas. Una alarma OPERATIONAL que lleva tres días
 * sin conectarse es un problema, y solo se ve si no se mezclan los dos.
 */
export type DeviceStatus =
  'INVENTORY' | 'OPERATIONAL' | 'MAINTENANCE' | 'OUT_OF_SERVICE' | 'RETIRED';

/**
 * Los datos de INSTALACIÓN: lo que un técnico necesita saber antes de subirse a
 * la escalera. Opcionales pero recomendados.
 */
export interface InstallationData {
  /** Número de poste o columna. */
  poleNumber?: string | null;
  /** Altura de montaje en metros. */
  heightM?: number | null;
  /** La esquina, entre qué calles. */
  reference?: string | null;
  /** De qué luminaria o tablero toma energía. */
  powerPoint?: string | null;
  installNotes?: string | null;
}

/** Modelo de placa. El `code` es SOLO el prefijo del número impreso: 'ALOY'. */
export interface BoardModel {
  id: number;
  code: string;
  name: string;
  /** false = discontinuado: no se fabrica más, los equipos viejos siguen. */
  active: boolean;
  notes: string | null;
}

/**
 * Lo que le falta al equipo para poder conectarse al broker MQTT.
 *
 * Hoy es un LOG, no una acción: la credencial se deriva de la MAC con un salt de
 * producción que todavía no está del lado servidor, así que la web muestra el
 * comando pendiente en vez de fingir que el equipo quedó listo.
 */
export interface DeviceProvisioning {
  /** Usuario MQTT = client_id = `<id>` del tópico. Los tres son el mismo string. */
  mqttUsername: string;
  topics: string[];
  brokerRegistered: boolean;
  provisionedAt: string | null;
  pendingCommand: string | null;
}

/**
 * Etapa de puesta en marcha. La DERIVA el backend del último hito alcanzado:
 * no es una columna, así que no puede contradecir a las fechas.
 */
export type DeviceStage = 'CREATED' | 'PROVISIONED' | 'LABELED' | 'CONNECTED';

/** OBSERVED = lo vio el broker; MANUAL = lo marcó CPS a mano (auditado). */
export type DeviceMilestoneSource = 'OBSERVED' | 'MANUAL';

/**
 * Los cuatro hitos con su fecha. Se muestran por separado y no solo como la
 * etapa: que un equipo esté "etiquetado" dice menos que ver que se etiquetó
 * pero todavía no se provisionó.
 */
export interface DeviceMilestones {
  createdAt: string;
  provisionedAt: string | null;
  labeledAt: string | null;
  firstConnectionAt: string | null;
  firstConnectionSource: DeviceMilestoneSource | null;
}

export interface Device {
  id: number;
  /** En stock puede no tener nombre todavía: se pone al instalar. */
  name: string | null;
  /** Se DERIVA de la MAC (`AV-<12 hex>`): no se elige ni se manda al crear. */
  serial: string;
  type: DeviceType;
  status: DeviceStatus;
  /** MAC STA: 12 hex en mayúsculas, sin separadores. */
  mac: string | null;
  /** `ALOY0043` — lo compone el backend; en la base viven modelo y número aparte. */
  boardNumber: string | null;
  boardModelId: number | null;
  boardSeq: number | null;
  /** Solo mientras está en INVENTORY. Se necesita para el claim. */
  claimCode: string | null;
  /** Stock de una organización (entrega del lote). null = fábrica CPS. */
  organizationId: number | null;
  neighborhoodId: number | null;
  tested: boolean;
  latitude: number | null;
  longitude: number | null;
  installedAt: string | null;
  /** Datos de instalación: opcionales, recomendados, editables después. */
  poleNumber: string | null;
  heightM: number | null;
  reference: string | null;
  powerPoint: string | null;
  installNotes: string | null;
  /** Último hito alcanzado en la puesta en marcha. Derivada, no almacenada. */
  stage: DeviceStage;
  milestones: DeviceMilestones;
  /** null en los tipos que no hablan MQTT. */
  provisioning: DeviceProvisioning | null;
  /** Cosas raras que no impidieron el alta. Vacío salvo al fabricar. */
  warnings: string[];
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
 * v2.3: SIEMPRE organización → CUENTA, comercial puro. Era por barrio hasta
 * 2026-07-31: se movió porque el sistema se vende a nivel municipal — la muni
 * paga por N barrios y no le revende a cada uno. Consecuencia: no existe un
 * "barrio sin contrato".
 *
 * Los cupos no viven acá: van en la cuenta y en el barrio (solo CPS los toca).
 *
 * `endDate` es obligatoria: el precio es POR EL PERÍODO del contrato. El
 * período no se guarda — se deriva de las dos fechas.
 */
export interface Contract {
  id: number;
  price: number;
  description: string | null;
  startDate: string;
  endDate: string;
  status: ContractStatus;
  accountId: number;
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
