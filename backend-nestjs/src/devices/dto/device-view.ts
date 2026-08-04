import {
  DeviceMilestoneSource,
  DeviceStage,
  DeviceType,
} from '../../common/enums';
import { Device } from '../entities/device.entity';
import { formatBoardNumber, formatMacHuman, mqttTopics } from '../mac';

/**
 * Lo que le falta al equipo para poder conectarse al broker.
 *
 * Hoy esto es un LOG, no una acción: la credencial se deriva con
 * `HMAC-SHA256(SALT_MQTT, MAC)` y el `SALT_MQTT` de producción todavía no está
 * del lado servidor (punto abierto PA4 del GtD), así que nadie puede derivar
 * nada. En vez de fingir que el equipo quedó listo, la web dice con precisión
 * qué falta y da el comando exacto para correr en el server.
 *
 * Cuando llegue el salt, esto pasa a llenarse solo y `brokerRegistered` da true
 * sin que cambie el contrato de la respuesta.
 */
export interface DeviceProvisioning {
  /** Usuario MQTT = client_id = `<id>` del tópico. Los tres son el mismo string. */
  mqttUsername: string;
  topics: string[];
  brokerRegistered: boolean;
  provisionedAt: Date | null;
  /** El comando a correr en el server, como respaldo si el provisioner no anda. */
  pendingCommand: string | null;
  /**
   * La última operación de alta/baja pedida, o null si nunca se pidió ninguna.
   * Lo completa `DevicesService.findOne`; en los listados va null.
   */
  queue: {
    op: 'provision' | 'revoke';
    estado: 'pending' | 'done' | 'failed';
    detalle: string | null;
    createdAt: string;
  } | null;
}

/**
 * Los cuatro hitos de puesta en marcha, con la fecha de cada uno. La pantalla
 * los muestra como una lista de pasos y no como un solo cartel: saber que un
 * equipo está "etiquetado" sirve menos que ver que se etiquetó pero todavía no
 * se provisionó.
 */
export interface DeviceMilestones {
  createdAt: Date;
  provisionedAt: Date | null;
  labeledAt: Date | null;
  firstConnectionAt: Date | null;
  /** OBSERVED = lo vio el broker; MANUAL = lo marcó una persona. */
  firstConnectionSource: DeviceMilestoneSource | null;
}

/** El equipo como lo ve la API: lo que hay en la base más lo que se compone. */
export type DeviceView = Device & {
  /** `ALOY0043` — se COMPONE de board_model.code + board_seq, no se guarda. */
  boardNumber: string | null;
  /** Último hito alcanzado. Derivada, nunca almacenada. */
  stage: DeviceStage;
  milestones: DeviceMilestones;
  provisioning: DeviceProvisioning | null;
  /**
   * Cosas raras que NO impiden el alta pero que el operador debería mirar
   * (un OUI desconocido, un salto en la numeración de placas). Vacío en las
   * lecturas: solo se calculan al fabricar.
   */
  warnings: string[];
};

/**
 * Requiere que el device venga con la relación `boardModel` cargada; si no,
 * `boardNumber` sale en null (no rompe, pero la pantalla lo muestra vacío).
 */
export function toDeviceView(
  device: Device,
  warnings: string[] = [],
): DeviceView {
  const boardNumber =
    device.boardModel && device.boardSeq !== null
      ? formatBoardNumber(device.boardModel.code, device.boardSeq)
      : null;

  return Object.assign({}, device, {
    boardNumber,
    stage: deviceStage(device),
    milestones: {
      createdAt: device.createdAt,
      provisionedAt: device.mqttProvisionedAt,
      labeledAt: device.labeledAt,
      firstConnectionAt: device.firstConnectionAt,
      firstConnectionSource: device.firstConnectionSource,
    },
    provisioning: toProvisioning(device),
    warnings,
  });
}

/**
 * El último hito alcanzado, no el siguiente pendiente.
 *
 * Se evalúa de atrás para adelante y a propósito NO exige que los anteriores
 * estén cumplidos: en la práctica un equipo se puede etiquetar antes de
 * provisionarse, y una etapa que mienta por "saltear" un paso sería peor que
 * una que simplemente informe hasta dónde llegó. El detalle fino de qué falta
 * lo da `milestones`, que muestra los cuatro por separado.
 */
export function deviceStage(device: Device): DeviceStage {
  if (device.firstConnectionAt !== null) {
    return DeviceStage.CONNECTED;
  }
  if (device.labeledAt !== null) {
    return DeviceStage.LABELED;
  }
  if (device.mqttProvisionedAt !== null) {
    return DeviceStage.PROVISIONED;
  }
  return DeviceStage.CREATED;
}

export function toDeviceViews(devices: Device[]): DeviceView[] {
  // Con `.map(toDeviceView)` el índice del array entraría como `warnings`.
  return devices.map((device) => toDeviceView(device));
}

function toProvisioning(device: Device): DeviceProvisioning | null {
  // Solo la alarma comunitaria habla MQTT; los demás tipos no tienen identidad
  // en el broker y mostrarles un bloque de provisioning sería mentirle al operador.
  if (device.type !== DeviceType.COMMUNITY_ALARM || device.mac === null) {
    return null;
  }

  const registered = device.mqttProvisionedAt !== null;

  return {
    mqttUsername: device.serial,
    topics: mqttTopics(device.serial),
    brokerRegistered: registered,
    provisionedAt: device.mqttProvisionedAt,
    pendingCommand: registered
      ? null
      : `sudo -E bash deploy/provision-panel.sh ${formatMacHuman(device.mac)}`,
    // Lo llena `findOne`: este builder es puro y no consulta la base.
    queue: null,
  };
}
