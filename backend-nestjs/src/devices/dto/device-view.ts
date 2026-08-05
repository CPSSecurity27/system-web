import {
  DeviceMilestoneSource,
  DeviceStage,
  DeviceType,
} from '../../common/enums';
import { Device } from '../entities/device.entity';
import {
  apQr,
  apSsid,
  appQr,
  formatBoardNumber,
  formatMacHuman,
  mqttTopics,
} from '../mac';

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
    op: 'provision' | 'revoke' | 'manufacture';
    estado: 'pending' | 'done' | 'failed';
    detalle: string | null;
    createdAt: string;
  } | null;
}

/**
 * Los hitos de puesta en marcha, con la fecha de cada uno. La pantalla los
 * muestra como una lista de pasos y no como un solo cartel.
 *
 * `createdAt` y `provisionedAt` van los dos aunque hoy sean el mismo instante:
 * si alguna vez se revoca y se vuelve a registrar la credencial, dejan de serlo.
 */
export interface DeviceMilestones {
  createdAt: Date;
  provisionedAt: Date | null;
  /**
   * Ya no es una etapa (2026-08-05) pero sigue siendo un hito: es lo que permite
   * preguntar a cuáles de una tanda les falta la etiqueta. Lo sella imprimir.
   */
  labeledAt: Date | null;
  firstConnectionAt: Date | null;
  /** OBSERVED = lo vio el broker; MANUAL = lo marcó una persona. */
  firstConnectionSource: DeviceMilestoneSource | null;
  testedAt: Date | null;
  readyAt: Date | null;
}

/**
 * Todo lo que necesita el técnico para entrar al equipo, y lo que va impreso en
 * la etiqueta.
 *
 * El SSID y los dos QR se COMPONEN de la MAC y del claim code: no hay nada
 * guardado. La password de `admin` sí sale de la base, descifrada — la deriva el
 * provisioner, que es el único con los salts.
 *
 * `pass_cps` NO está acá y no puede estar: es la credencial de nivel fábrica, el
 * firmware manda no imprimirla nunca, y se pide por su propio endpoint, que
 * exige otro permiso y deja `audit_log`. Si viniera en la ficha, terminaría en
 * la primera captura de pantalla que alguien mande por WhatsApp.
 */
export interface DevicePortal {
  ssid: string;
  /** `WIFI:S:…;T:nopass;;` — AP abierto, lo lee la cámara nativa. */
  qrWifi: string;
  /** `CPS1|<serial>|<claim>` — texto plano, lo lee la app del técnico. */
  qrApp: string;
  url: string;
  usuario: 'admin';
  /** `null` si todavía no se derivó, o si la clave de cifrado no la puede leer. */
  password: string | null;
  derivedAt: Date | null;
}

/** El equipo como lo ve la API: lo que hay en la base más lo que se compone. */
export type DeviceView = Device & {
  /** `ALOY0043` — se COMPONE de board_model.code + board_seq, no se guarda. */
  boardNumber: string | null;
  /** Último hito alcanzado. Derivada, nunca almacenada. */
  stage: DeviceStage;
  milestones: DeviceMilestones;
  provisioning: DeviceProvisioning | null;
  /** Acceso al portal local. `null` en los tipos que no son alarma comunitaria. */
  portal: DevicePortal | null;
  /**
   * Cosas raras que NO impiden el alta pero que el operador debería mirar
   * (un OUI desconocido, un salto en la numeración de placas). Vacío en las
   * lecturas: solo se calculan al fabricar.
   */
  warnings: string[];
};

/**
 * Descifra la password de `admin`. Se pasa como función y no se resuelve acá
 * para que este módulo siga siendo puro: no conoce Nest, no inyecta nada y se
 * puede probar sin levantar la app. Sin ella, el bloque del portal sale con
 * `password: null` — que es exactamente lo que corresponde en un listado.
 */
export type DescifrarPassword = (blob: string | null) => string | null;

/**
 * Requiere que el device venga con la relación `boardModel` cargada; si no,
 * `boardNumber` sale en null (no rompe, pero la pantalla lo muestra vacío).
 */
export function toDeviceView(
  device: Device,
  warnings: string[] = [],
  descifrar?: DescifrarPassword,
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
      testedAt: device.testedAt,
      readyAt: device.readyAt,
    },
    provisioning: toProvisioning(device),
    portal: toPortal(device, descifrar),
    warnings,
  });
}

function toPortal(
  device: Device,
  descifrar?: DescifrarPassword,
): DevicePortal | null {
  // Solo la alarma comunitaria levanta AP y portal. Mostrarle este bloque a
  // otro tipo de equipo sería inventarle una pantalla que no tiene.
  if (device.type !== DeviceType.COMMUNITY_ALARM || device.mac === null) {
    return null;
  }

  return {
    ssid: apSsid(device.mac),
    qrWifi: apQr(device.mac),
    qrApp: appQr(device.serial, device.claimCode),
    url: 'http://192.168.4.1',
    usuario: 'admin',
    password: descifrar ? descifrar(device.portalAdminEnc) : null,
    derivedAt: device.portalDerivedAt,
  };
}

/**
 * El último hito alcanzado, no el siguiente pendiente.
 *
 * Se evalúa de atrás para adelante y a propósito NO exige que los anteriores
 * estén cumplidos: una etapa que mienta por "saltear" un paso sería peor que una
 * que simplemente informe hasta dónde llegó. El detalle fino lo da `milestones`.
 *
 * `MANUFACTURED` es el piso: si el equipo existe, se fabricó — el alta atómica
 * no deja nacer uno sin credencial. Que la credencial se haya REVOCADO después
 * no lo devuelve a una etapa anterior; eso es estado de la credencial y se
 * muestra aparte (`provisioning.brokerRegistered`), porque son dos preguntas
 * distintas y ninguna tiene por qué mentir por la otra.
 *
 * `labeled_at` NO participa (2026-08-05): imprimir la etiqueta no es un avance
 * en la puesta en marcha del equipo, es una tarea de fábrica. Sigue guardándose
 * como hito, pero mezclarlo acá hacía que un equipo YA CONECTADO retrocediera a
 * "etiquetado" en la lista solo por el orden en que se hicieron las cosas.
 */
export function deviceStage(device: Device): DeviceStage {
  if (device.readyAt !== null) {
    return DeviceStage.READY;
  }
  if (device.testedAt !== null) {
    return DeviceStage.TESTED;
  }
  if (device.firstConnectionAt !== null) {
    return DeviceStage.CONNECTED;
  }
  return DeviceStage.MANUFACTURED;
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
