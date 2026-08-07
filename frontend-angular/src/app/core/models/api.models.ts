import { AccountType, HomeMemberRole, OrgSubtype, UserRole } from '../auth/auth.models';
import type { Department, Locality } from './neighborhood';
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
   * CUPOS DE BARRIO: no son un techo de la cuenta, son lo que se COPIA a cada
   * barrio nuevo suyo. Después cada barrio puede apartarse por sus propios
   * /quotas — esto es el default del alta, no un límite.
   */
  maxFamilyMembers: number | null;
  communityScopeEnabled: boolean | null;
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
  /**
   * El árbol de la jurisdicción, ya resuelto por el backend. Va exactamente
   * uno de los dos, según el nivel (lo exige `chk_account_jurisdiction`).
   * Lo usa el alta de barrio para saber DÓNDE puede estar ese barrio.
   */
  locality: Locality | null;
  department: Department | null;
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
  /**
   * La misma alarma, con su nombre, para poder mostrarla sin pedir los equipos
   * aparte. Viene en el listado y en la ficha.
   *
   * Que esto sea `null` no es un detalle cosmético: **los controles de esa casa
   * no se cargan en ningún panel**, porque el plan de cada equipo sale de las
   * viviendas que lo eligieron. Pasa siempre que la casa se creó antes de que el
   * barrio tuviera alarmas.
   */
  defaultDevice?: { id: number; name: string | null; serial: string } | null;
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
 * La credencial del equipo en el broker MQTT.
 *
 * El alta de fábrica la pide sola: encola en la base y un proceso aparte (el
 * provisioner) la registra en Mosquitto. `pendingCommand` queda como respaldo
 * para hacerlo a mano si ese proceso no está corriendo.
 */
export interface DeviceProvisioning {
  /** Usuario MQTT = client_id = `<id>` del tópico. Los tres son el mismo string. */
  mqttUsername: string;
  topics: string[];
  brokerRegistered: boolean;
  provisionedAt: string | null;
  /** El comando manual, como respaldo. */
  pendingCommand: string | null;
  /** La última operación pedida. null si nunca se pidió ninguna. */
  queue: {
    op: 'provision' | 'revoke' | 'manufacture';
    estado: 'pending' | 'done' | 'failed';
    detalle: string | null;
    createdAt: string;
  } | null;
}

/**
 * Etapa de puesta en marcha. La DERIVA el backend del último hito alcanzado:
 * no es una columna, así que no puede contradecir a las fechas.
 *
 * `MANUFACTURED` es el piso: si el equipo existe, se fabricó. Desde que el alta
 * es atómica (2026-08-04), nacer y quedar registrado en el broker son el mismo
 * instante, así que ya no hay un peldaño "creado pero sin credencial".
 *
 * `CONNECTED` significa "se conectó alguna vez", NO "está online ahora": lo
 * segundo es estado vivo y sale de `device_state`.
 *
 * Etiquetar NO es una etapa (2026-08-05): imprimir es una tarea de fábrica, no
 * un avance del equipo. Sigue siendo un hito con fecha en `milestones`.
 */
export type DeviceStage = 'MANUFACTURED' | 'CONNECTED' | 'TESTED' | 'READY';

/** OBSERVED = lo vio el broker; MANUAL = lo marcó CPS a mano (auditado). */
export type DeviceMilestoneSource = 'OBSERVED' | 'MANUAL';

/**
 * Los hitos con su fecha. Se muestran por separado y no solo como la etapa: que
 * un equipo esté "etiquetado" dice menos que ver hasta dónde llegó realmente.
 */
export interface DeviceMilestones {
  createdAt: string;
  provisionedAt: string | null;
  /** Lo sella imprimir la etiqueta. Ya no es etapa, pero sigue siendo hito. */
  labeledAt: string | null;
  firstConnectionAt: string | null;
  firstConnectionSource: DeviceMilestoneSource | null;
  /** Prueba funcional del equipo ya conectado: sirena, RF, sensores. */
  testedAt: string | null;
  /** Visto bueno para que salga de fábrica. Lo da una persona. */
  readyAt: string | null;
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
  /** Acceso al portal local del equipo. null en los tipos que no levantan AP. */
  portal: DevicePortal | null;
  /**
   * En la papelera: no aparece en ningún listado normal. Se puede reactivar o
   * borrar definitivamente. Eje aparte de `status`, no un estado más.
   */
  removedAt: string | null;
  /** Cosas raras que no impidieron el alta. Vacío salvo al fabricar. */
  warnings: string[];
}

/**
 * Lo que necesita el técnico para entrar al equipo, y lo que va en la etiqueta.
 *
 * El SSID y los dos QR los COMPONE el backend a partir de la MAC y del claim
 * code. La password de `admin` viene descifrada, pero SOLO en la ficha
 * (`GET /devices/:id`): en los listados llega en null a propósito, así que para
 * imprimir hay que pedir el equipo primero.
 *
 * La password de `cps` NO está acá y no va a estar: se pide aparte
 * (`GET /devices/:id/portal-cps`), exige OWNER o ADMIN de CPS y deja audit_log.
 * El firmware es explícito en que jamás se imprime.
 */
export interface DevicePortal {
  ssid: string;
  /** `WIFI:S:…;T:nopass;;` — AP abierto, lo lee la cámara nativa del celular. */
  qrWifi: string;
  /** `CPS1|<serial>|<claim>` — texto plano, lo lee la app del técnico. */
  qrApp: string;
  url: string;
  usuario: 'admin';
  password: string | null;
  derivedAt: string | null;
}

/**
 * Estado VIVO de la alarma. Lo escribe ÚNICAMENTE el servicio de alarmas
 * (programa aparte). Hasta que ese servicio exista, este dato es null:
 * mostrar "sin datos", no inventar.
 */
export interface DeviceState {
  deviceId: number;
  online: boolean;
  /**
   * Catálogo del firmware:
   * off | suspicious | alert | emergency | fire | medical | silent | panic
   */
  alarmStatus: string | null;
  /** ACTIVE_240, MODEM_SLEEP, … */
  powerMode: string | null;
  /**
   * Voltajes. Llegan como STRING: son `numeric` en Postgres y el driver de pg no
   * los pasa a number para no perder precisión. Hay que parsearlos.
   */
  vbat: string | null;
  vpanel: string | null;
  vfuente: string | null;
  /** `bigint` en Postgres, string acá por lo mismo. */
  cfgV: string;
  rfGen: string;
  fw: string | null;
  /**
   * La RED del equipo. `rssi` en dBm, negativo: -60 es buena señal, -80 mala.
   * `recon` y `pingFail` son los contadores que explican una caída — un equipo
   * que se reconecta 40 veces por hora no está "online", está agonizando.
   */
  ssid: string | null;
  ip: string | null;
  rssi: number | null;
  recon: number | null;
  pingFail: number | null;
  /**
   * El resto del snapshot: `rtc`, `modulos`, `ota`, contadores `rf`, `sueno` y
   * `colas`. Viene tal cual lo manda el firmware, así que la ficha lo muestra
   * genérico: si mañana el panel agrega una sección, aparece sola.
   */
  tele: Record<string, unknown> | null;
  /** Cuándo habló: lo escribe cualquier mensaje, no solo el latido. */
  lastSeen: string | null;
  lastHeartbeat: string | null;
  /** Hasta cuándo avisó que duerme. NULL = no duerme (durmiendo ≠ caído). */
  sleepUntil: string | null;
  /** El reloj que el panel declara (puede estar días atrás con tsq alto). */
  tsDevice: string | null;
  /** Calidad de ese reloj, 0..4, MENOR ES MEJOR. */
  tsq: number | null;
  updatedAt: string;
}

/**
 * Estado de la configuración. DERIVADO en el backend, no hay columna que lo
 * guarde: "verificado" es que el espejo del panel alcanzó a lo que le mandamos.
 */
export type EstadoConfig =
  /** El equipo nunca reportó su cfg_full: sin espejo no se puede editar. */
  | 'SIN_ESPEJO'
  /** Lo que corre el panel coincide con lo último que mandamos. */
  | 'VERIFICADO'
  /** Encolada, el servicio de alarmas todavía no la publicó. */
  | 'PENDIENTE'
  /** Publicada en el broker, sin ack todavía. */
  | 'ENVIADA'
  /** El panel ackeó, pero el espejo no volvió: no sabemos qué quedó. */
  | 'APLICADA_SIN_VERIFICAR'
  /** No se pudo entregar. `detalle` dice por qué. */
  | 'FALLIDA'
  /**
   * El equipo volvió a los valores de fábrica: es el ÚNICO estado en el que lo
   * que muestra la pantalla no es lo que está corriendo en el poste.
   */
  | 'DESACTUALIZADA';

/** Una red del equipo. La password NUNCA viaja: solo si tiene una guardada. */
export interface RedWifi {
  ssid: string;
  prio: number;
  tienePassword: boolean;
  /** El panel la bloqueó y no la va a usar, esté bien cargada o no. */
  bloqueada: boolean;
}

/** Una red vista en el último scan. `guardada` = el panel ya la tiene cargada. */
export interface ScanRed {
  ssid: string;
  rssi: number;
  seg: boolean;
  ch: number;
  guardada: boolean;
}

export interface DeviceConfig {
  deviceId: number;
  estado: EstadoConfig;
  /** El espejo SIN las redes (van aparte, ya saneadas). null si no hay espejo. */
  configuracion: Record<string, unknown> | null;
  redes: RedWifi[];
  /** `bigint` en Postgres, string acá por lo mismo que los voltajes. */
  cfgVEspejo: string | null;
  cfgVPendiente: string | null;
  detalle: string | null;
  espejoActualizadoEn: string | null;
  ultimoScan: { redes: ScanRed[]; recibidoEn: string } | null;
  /** Los dos ejes: el rol (el MONITOR mira) y el barrio (`managed_by`). */
  puedeEditar: boolean;
  /** Si puede pedir las contraseñas WiFi en claro (solo CPS, auditado). */
  puedeVerPasswords: boolean;
}

/** Una red con su password en claro. Solo CPS, y queda auditado. */
export interface RedWifiRevelada {
  ssid: string;
  psw: string;
}

// ── La base de controles del equipo ──────────────────────────────────
//
// NO es configuración, aunque comparta pantalla con ella: no tiene `cfg_v`, no
// se mergea y no es retained. Es una cola de comandos con su ack.

/** Por qué un control no se puede cargar en el equipo. */
export type MotivoSalteo =
  | 'SIN_PORTADOR'
  | 'DNI_INVALIDO'
  | 'SIN_CODIGOS'
  | 'POSICIONES_CON_HUECO'
  | 'CODIGO_FUERA_DE_RANGO'
  | 'NO_ENTRA';

export interface ControlDeSync {
  remoteId: number;
  serial: string | null;
  direccion: string;
  portador: string | null;
  dni: string | null;
}

export interface ControlSalteado extends ControlDeSync {
  motivo: MotivoSalteo;
  /** El motivo ya explicado por el backend: la pantalla no lo traduce. */
  explicacion: string;
}

/** Lo que hay que SACAR del equipo. Puede no tener control vivo detrás. */
export interface BajaDeSync {
  dni: string;
  serial: string | null;
  motivo: string;
}

export interface TandaDeSync {
  batchId: string;
  total: number;
  hechos: number;
  estado: 'en_curso' | 'terminada' | 'con_error';
  detalle: string | null;
  empezada: string;
}

/** Un control del barrio que no le toca a ningún equipo: su casa no eligió. */
export interface ControlSinAlarma {
  remoteId: number;
  serial: string | null;
  homeId: number;
  direccion: string;
}

export interface EstadoRf {
  /** Controles del barrio cuya vivienda no tiene alarma preferida. */
  sinAlarma: ControlSinAlarma[];
  /** Cuántos vecinos entran en el chip y cuántos ocuparía la sincronización. */
  capacidad: { tope: number; ocupados: number };
  alDia: number;
  pendientes: ControlDeSync[];
  bajas: BajaDeSync[];
  salteados: ControlSalteado[];
  tanda: TandaDeSync | null;
  puedeSincronizar: boolean;
  impedimento: string | null;
}

/** Otro equipo del mismo barrio del que se puede copiar la configuración. */
export interface FuenteConfig {
  deviceId: number;
  nombre: string;
  serial: string;
  espejoActualizadoEn: string;
}

/**
 * Un comando encolado al panel.
 *
 * A diferencia de la configuración, un comando no tiene versión ni se mergea:
 * se manda una vez y el panel contesta con el mismo `cid`.
 */
/**
 * La cola con los permisos ya resueltos por el backend.
 *
 * No viene un array pelado a propósito: hay DOS matrices distintas (el disparo
 * de alarma incluye al MONITOR, los comandos de infraestructura no) y las dos
 * dependen del barrio. Deducirlas de la sesión sería copiar acá una regla que
 * ya vive en el servidor.
 */
export interface ColaComandos {
  comandos: Comando[];
  /** Reiniciar, volver a fábrica, diagnóstico. */
  puedeOperar: boolean;
  /** Disparar o apagar la alarma (el MONITOR también). */
  puedeDisparar: boolean;
  /**
   * Actualizar el firmware. Es SOLO CPS, y por eso es una tercera matriz y no
   * parte de `puedeOperar`: un técnico municipal reinicia y vuelve a fábrica
   * sus postes, pero no les instala software.
   */
  puedeActualizar: boolean;
}

export interface Comando {
  cid: string;
  tipo: string;
  payload: Record<string, unknown>;
  /** `pending` | `sent` | `ok` | `error` | `cancelled`. */
  estado: string;
  detalle: string | null;
  creadoEn: string;
  enviadoEn: string | null;
  confirmadoEn: string | null;
  pedidoPor: string | null;
  cancelable: boolean;
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
  /** `CR-000137`. null solo en los controles anteriores a la fábrica. */
  serial: string | null;
  /** Código de un solo uso para sumarlo a un stock. Impreso en la etiqueta. */
  claimCode?: string | null;
  modelId: number | null;
  model?: RemoteModel | null;
  manufacturedAt: string | null;
  /** Apodo que le pone la familia. Lo que identifica es el serial. */
  name: string | null;
  status: RemoteStatus;
  homeId: number | null;
  /** Stock de una organización. null = fábrica CPS (si tampoco hay homeId). */
  organizationId: number | null;
  assignedToUserId: number | null;
  assignedToUser?: User | null;
  deviceId: number | null;
  /**
   * La vivienda con su barrio y su cliente, PARCIAL: solo lo que muestra la
   * tabla del listado. Viene de `GET /remotes` y no de otras respuestas.
   *
   * Existe para que la pantalla no tenga que bajarse todas las viviendas para
   * traducir `homeId → dirección`: con ~12.000 controles eso no terminaba más.
   */
  home?: RemoteHome | null;
}

/** La vivienda tal como viaja DENTRO de una fila del listado de controles. */
export interface RemoteHome {
  id: number;
  address: string;
  neighborhoodId: number;
  /** La alarma preferida del hogar (no la que tiene grabados los códigos). */
  defaultDeviceId: number | null;
  neighborhood?: {
    id: number;
    name: string;
    organizationId: number;
    organization?: { id: number; name: string; subtype: OrgSubtype | null };
  };
}

/**
 * Un modelo del catálogo. Lo que lo define es cuántos botones tiene, porque eso
 * decide cuántos códigos se cargan al fabricar.
 *
 * El panel registra hasta 4 por vecino y la POSICIÓN decide qué hace cada uno
 * (1 emergencia, 2 sospechoso, 3 alerta, 4 apagar): un modelo con más botones
 * tendría teclas que no disparan nada.
 */
export interface RemoteModel {
  id: number;
  code: string;
  name: string;
  buttons: number;
  active: boolean;
  notes: string | null;
}

/** Un código con lo que hace su botón. La posición NO es un orden: es el botón. */
export interface CodigoDeControl {
  position: number;
  codigo: number;
  boton: string;
  modo: string;
  label: string;
}

/** Lo que devuelve la fábrica. Trae los códigos: hay que grabarlos en el control. */
export interface RemoteFabricado {
  id: number;
  serial: string;
  /** Va impreso en la etiqueta: con esto un cliente lo suma a su stock. */
  claimCode: string | null;
  name: string | null;
  modelo: RemoteModel;
  manufacturedAt: string;
  codigos: CodigoDeControl[];
}

/**
 * Un control encontrado por serial o por código. NO trae los códigos: quien
 * busca por código ya lo tiene.
 */
export interface ResultadoBusqueda {
  id: number;
  serial: string | null;
  status: RemoteStatus;
  homeId: number | null;
  modelo: RemoteModel | null;
  coincidePor: 'serial' | 'codigo';
  /** Visto bueno de fábrica. null = todavía no puede salir al stock. */
  readyAt: string | null;
  /**
   * Fuera de circulación. OJO: no impide que el control siga disparando — los
   * códigos viven en la memoria de cada alarma y todavía no se sincronizan.
   */
  removedAt: string | null;
  position: number | null;
  boton: string | null;
}

/** Los datos de la etiqueta. Los códigos van en claro: solo CPS, auditado. */
export interface EtiquetaControl {
  id: number;
  serial: string;
  claimCode: string | null;
  modelo: RemoteModel;
  codigos: CodigoDeControl[];
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

// ── Firmware (OTA) ──────────────────────────────────────────────────

/** Las dos bases que el firmware tiene hardcodeadas. */
export type FirmwareSlot = 'new' | 'emergency';

/**
 * Un firmware del catálogo.
 *
 * Casi todo lo LEE el backend del `.bin` al subirlo: `projectName`, `sizeBytes`
 * y `sha256` salen del archivo. Lo único que se tipea es la versión y las notas
 * —el binario del firmware declara su `git describe`, no la versión OTA.
 */
export interface FirmwareRelease {
  id: number;
  /** `new_0_7_0`. Es el nombre de la carpeta y del `.bin`. */
  version: string;
  /** `new` | `stable`, del prefijo. Es registro: el equipo nunca bloquea por esto. */
  channel: string;
  hwModel: string;
  /** Lo que el equipo verifica antes de activar la partición. */
  projectName: string;
  sizeBytes: number;
  sha256: string;
  notes: string | null;
  subidoPor: string | null;
  creadoEn: string;
  /** La base para pegar en el campo de URL manual de la ficha del equipo. */
  url: string;
  /** En qué ranuras está publicada ahora mismo. */
  publicadoEn: FirmwareSlot[];
}

/** Qué versión está publicada en una de las dos bases del equipo. */
export interface FirmwareRanura {
  slot: FirmwareSlot;
  version: string;
  releaseId: number;
  url: string;
  actualizadoPor: string | null;
  actualizadoEn: string;
}

/**
 * Un equipo en el gestor de actualizaciones.
 *
 * `desconocido` NO es lo mismo que `atrasado`: `fw` llega por el `status`
 * retained del panel, así que un equipo que nunca conectó no tiene ninguno.
 */
export interface EquipoFirmware {
  deviceId: number;
  serial: string;
  nombre: string | null;
  barrioId: number | null;
  barrio: string | null;
  cuenta: string | null;
  fw: string | null;
  estado: 'al_dia' | 'atrasado' | 'desconocido';
  online: boolean;
  durmiendoHasta: string | null;
  /**
   * El modo de energía. **El equipo RECHAZA el OTA si no está en `ACTIVE_*`**:
   * no lo encola ni lo difiere, contesta error y se termina ahí.
   */
  modoEnergia: string | null;
  /** En qué quedó el PEDIDO (el comando y su ack). */
  otaEnCurso: {
    cid: string;
    estado: string;
    detalle: string | null;
    creadoEn: string;
  } | null;
  /**
   * Lo que contó el propio EQUIPO (`up t:ota`), que es otra cosa: entre "acepté
   * el pedido" y "lo tengo corriendo" hay una descarga de 1,2 MB, un sha256 y un
   * reinicio. Un comando confirmado con un progreso "falló" es exactamente el
   * caso que antes no se veía en ningún lado.
   */
  progreso: OtaProgreso | null;
  /**
   * Hasta dónde se puede AFIRMAR que la última actualización funcionó.
   *
   * Lo resuelve el backend, no el navegador, porque la respuesta correcta no es
   * "¿`fw` coincide con la publicada?" — eso llegó a mostrar un falso
   * "actualizada". La versión que reporta el equipo es la etiqueta de nuestro
   * propio manifiesto devuelta, y lo único que su self-test comprueba es que
   * consiguió internet en 10 minutos.
   */
  confirmacion: ConfirmacionOta | null;
}

export interface ConfirmacionOta {
  /**
   * `arranco` — volvió a hablar y reporta la versión nueva. Es lo MÁS que se
   *   puede afirmar: arrancó y tiene internet. No dice que el firmware ande.
   * `reiniciando` — instaló y todavía no lo escuchamos.
   * `no_aplico` — volvió con la versión anterior: revirtió.
   * `indistinguible` — no hay con qué comparar.
   * `fallo` — el propio equipo reportó el rechazo.
   */
  estado: 'arranco' | 'reiniciando' | 'no_aplico' | 'indistinguible' | 'fallo';
  /** Qué se puede afirmar y qué no. Se muestra tal cual. */
  detalle: string;
}

/** El último `up t:ota`, ya traducido por el backend. */
export interface OtaProgreso {
  estado: number;
  estadoTexto: string;
  resultado: number;
  /** Solo cuando hay algo que decir; null si salió bien. */
  motivo: string | null;
  fw: string | null;
  /** El equipo está trabajando AHORA: bajando, verificando. */
  enCurso: boolean;
  /**
   * Instaló y se reinició solo (el reinicio es automático, medio segundo
   * después de este mensaje).
   *
   * **Es el último mensaje que manda el equipo sobre esa actualización**: el
   * self-test que confirma la imagen no publica nada. Que haya funcionado se
   * ve porque `fw` pasa a ser la versión nueva.
   */
  esperandoReinicio: boolean;
  /**
   * Terminó mal. El rollback no llega por acá —el firmware no lo emite—: se ve
   * como que el equipo sigue reportando la versión vieja.
   */
  fallo: boolean;
  recibidoEn: string;
}

export interface FlotaFirmware {
  /** La versión publicada en `new`, que es contra la que se compara. */
  publicada: string | null;
  equipos: EquipoFirmware[];
}

/** Qué pasó con cada equipo. Nunca un "listo" global. */
export interface ResultadoActualizacion {
  deviceId: number;
  serial: string;
  encolado: boolean;
  cid: string | null;
  motivo: string | null;
}

/** Lo que devuelve el botón "Verificar el servidor". */
export interface ChequeoFirmware {
  raiz: string;
  escribible: boolean;
  ranuras: { slot: string; version: string; archivos: string[] }[];
  faltantes: string[];
}
