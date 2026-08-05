import { BadRequestException } from '@nestjs/common';

/**
 * Identidad de una alarma comunitaria: MAC y número de placa.
 *
 * Las dos cosas se leen del equipo físico en la estación de flasheo (la MAC con
 * `esptool read_mac`, el número impreso en la placa) y las dos son inmutables.
 * Todo lo que entra por la API pasa por acá antes de tocar la base.
 *
 * El contrato con el servicio de alarmas (GtD) depende de esto: el usuario MQTT,
 * el client_id y el `<id>` del tópico son EL MISMO string `AV-<12 hex mayúsculas>`
 * — y de que sean el mismo depende que la ACL del broker sea una regla
 * `pattern av/%u/…` para toda la flota en vez de cinco líneas por equipo.
 */

/** Prefijo de la identidad MQTT, fijado por el firmware. No se cambia. */
const MQTT_PREFIX = 'AV-';

/** `esptool` devuelve esto cuando la lectura FALLA; no es una MAC. */
const MAC_LECTURA_FALLIDA = '000000000000';

/** Broadcast: no identifica a ningún equipo. */
const MAC_BROADCAST = 'FFFFFFFFFFFF';

/**
 * Normaliza una MAC a la forma canónica: 12 hex en MAYÚSCULAS, sin separadores.
 *
 * Acepta lo que realmente produce un humano o una máquina —`A8:42:E3:8F:CA:6C`,
 * `a8-42-e3-8f-ca-6c`, `a842e38fca6c`, con espacios de sobra— y guarda una sola
 * forma. Si conviviera más de un formato, el UNIQUE de la columna no serviría de
 * nada: `a8:42:…` y `A842…` serían dos filas distintas del mismo equipo.
 */
export function normalizeMac(raw: string): string {
  const mac = raw.replace(/[\s:.-]/g, '').toUpperCase();

  if (!/^[0-9A-F]{12}$/.test(mac)) {
    throw new BadRequestException(
      'La MAC tiene que ser de 6 bytes en hexadecimal (12 dígitos). ' +
        'Con o sin ":" da igual, por ejemplo A8:42:E3:8F:CA:6C.',
    );
  }
  if (mac === MAC_LECTURA_FALLIDA) {
    throw new BadRequestException(
      'Esa MAC es todo ceros: es lo que devuelve esptool cuando NO pudo leer la ' +
        'placa. Revisá la conexión y volvé a leerla.',
    );
  }
  if (mac === MAC_BROADCAST) {
    throw new BadRequestException(
      'Esa es la MAC de broadcast, no la de un equipo.',
    );
  }
  // Bit menos significativo del primer byte = multicast. Una MAC STA de ESP32 es
  // SIEMPRE unicast, así que si está prendido hay un byte mal leído o transpuesto.
  if (parseInt(mac.slice(0, 2), 16) & 0x01) {
    throw new BadRequestException(
      `La MAC ${formatMacHuman(mac)} es multicast, y la de un equipo nunca lo es. ` +
        'Lo más probable es que haya un dígito mal leído al principio.',
    );
  }

  return mac;
}

/**
 * El serial de una alarma comunitaria NO se elige: es su identidad MQTT.
 * El CHECK `chk_device_identity` impone lo mismo del lado de la base.
 */
export function deriveSerial(macNormalizada: string): string {
  return MQTT_PREFIX + macNormalizada;
}

/** Los 3 primeros bytes: identifican al fabricante del chip. */
export function macOui(macNormalizada: string): string {
  return macNormalizada.slice(0, 6);
}

/** Para mostrarle al operador lo mismo que ve en la pantalla de esptool. */
export function formatMacHuman(macNormalizada: string): string {
  return macNormalizada.match(/.{2}/g)!.join(':');
}

/** Los cinco tópicos del equipo, para el bloque de provisioning. */
export function mqttTopics(serial: string): string[] {
  return ['status', 'tele', 'up', 'cmd', 'cfg'].map((t) => `av/${serial}/${t}`);
}

// --- Portal local del equipo ------------------------------------------------
// El equipo levanta un AP y un portal web en 192.168.4.1. Todo esto se COMPONE
// de la MAC: no hay nada que guardar. Las passwords son otra cosa —las deriva el
// provisioner con los salts de la flota— y viajan cifradas.

/** El AP del equipo. Lo define el firmware (`wifi_manager_get_ap_ssid`). */
export function apSsid(macNormalizada: string): string {
  return 'AlarmaVecinal-' + macNormalizada;
}

/**
 * QR de conexión al AP, para la cámara nativa del celular.
 *
 * El AP es ABIERTO: va `T:nopass` y NO va campo `P:`. Con `T:WPA` varios
 * teléfonos fallan la conexión. Los `;;` finales son parte del formato.
 */
export function apQr(macNormalizada: string): string {
  return `WIFI:S:${apSsid(macNormalizada)};T:nopass;;`;
}

/**
 * QR para la app del técnico: serial y código de reclamo, en texto plano.
 *
 * `CPS1|` es una marca de versión, no decoración. Estas etiquetas se pegan a un
 * poste y no vuelven: cuando el formato cambie, la app tiene que poder
 * distinguir una etiqueta vieja de una nueva sin adivinar.
 */
export function appQr(serial: string, claimCode: string | null): string {
  return `CPS1|${serial}|${claimCode ?? ''}`;
}

// --- Número de placa --------------------------------------------------------

/** Lo que trae impreso la placa: prefijo del modelo + 4 dígitos. */
export interface BoardNumberParts {
  code: string;
  seq: number;
}

/**
 * Parte `ALOY0043` en modelo (`ALOY`) y número (`43`).
 *
 * El operador carga UN campo, no dos: el modelo ya viene adentro del string
 * impreso, y en una estación donde se cargan equipos todo el día, un campo menos
 * es un error menos. Quién resuelve el prefijo contra el catálogo es el service.
 */
export function parseBoardNumber(raw: string): BoardNumberParts {
  const valor = raw.replace(/[\s-]/g, '').toUpperCase();
  const match = /^([A-Z]{2,8})(\d{4})$/.exec(valor);

  if (!match) {
    throw new BadRequestException(
      'El número de placa tiene que ser el prefijo del modelo seguido de 4 ' +
        'dígitos, por ejemplo ALOY0043.',
    );
  }

  const seq = Number(match[2]);
  if (seq < 1) {
    throw new BadRequestException(
      'El número de placa arranca en 0001; 0000 no es válido.',
    );
  }

  return { code: match[1], seq };
}

/** Rearma el string impreso a partir de lo que sí se guarda. */
export function formatBoardNumber(code: string, seq: number): string {
  return code + String(seq).padStart(4, '0');
}
