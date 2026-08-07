/**
 * Los límites que el FIRMWARE impone, en un solo lugar y con su fuente.
 *
 * Se validan de nuestro lado aunque el firmware clampe, porque el firmware
 * clampa EN SILENCIO y ackea 'ok': sin esto, el usuario pide 5 s de telemetría,
 * la pantalla dice "aplicado" y el equipo quedó en 30. El error tiene que decir
 * el valor efectivo, no un "valor inválido" genérico.
 *
 * Y hay un grupo peor todavía: los campos que NO se clampan sino que hacen que
 * el firmware descarte el documento ENTERO sin mandar ack (`goto done` en
 * `mqtt_parse.c`). Ahí no hay recorte silencioso: hay silencio a secas, y la
 * pantalla se queda esperando una confirmación que no va a llegar nunca. Están
 * marcados abajo como RECHAZA LA CFG ENTERA.
 *
 * Si el firmware cambia un límite, se cambia acá y el test falla hasta
 * reconciliar. Es el mismo criterio que `contract.py` del GtD: el contrato no
 * puede divergir en silencio.
 */

/** `WIFI_MAX_PROFILES` en `wifi_types.h`. */
export const MAX_REDES = 5;

/** `MQTT_IN_PAYLOAD_MAX`: el buffer de entrada del panel. */
export const MAX_PAYLOAD_BYTES = 1024;

/** Buffers de `wifi_cred_t`: `strncpy` trunca en silencio, no rechaza. */
export const MAX_SSID_CHARS = 31;
export const MAX_PSW_CHARS = 63;

/** Los tres campos del roaming. Van juntos o no van. */
export const ROAMING = ['roam_rssi', 'roam_delta', 'roam_cooldown_s'] as const;

/** Los 7 modos con auto-apagado, tal como los nombra el firmware. */
export const MODOS_AUTOOFF = [
  'suspicious',
  'alert',
  'emergency',
  'fire',
  'medical',
  'silent',
  'panic',
] as const;

export const LIMITES = {
  /** `app_tele_period_set` en `components/main/task_mqtt.c`. */
  send_tele_s: { min: 30, max: 86400 },
  /** Los tres, de `app_roam_set` en `components/main/task_wifi.c`. */
  roam_rssi: { min: -90, max: -50 },
  roam_delta: { min: 5, max: 30 },
  roam_cooldown_s: { min: 60, max: 3600 },
  /** `mqtt_parse.c:120`. **RECHAZA LA CFG ENTERA**, no clampa. ±14 h. */
  tz_offset_s: { min: -50400, max: 50400 },
  /** `alarma_core.c`: clamp por modo. Ver `autooff` abajo. */
  autooff_s: { min: 120, max: 1800 },
  /** `eeprom_i2c`: el slot activo se toma con `& 1`. */
  eeprom_slot: { min: 0, max: 1 },
  /** `mqtt_parse.c:81`: fuera de rango NO falla, se asigna por orden. */
  prio: { min: 1, max: MAX_REDES },
} as const;

interface Limite {
  readonly min: number;
  readonly max: number;
}

/** Una sección del patch (`tiempos`, `red_avanzada`, …), o undefined si no es un objeto. */
function seccion(
  patch: Record<string, unknown>,
  nombre: string,
): Record<string, unknown> | undefined {
  const valor = patch[nombre];
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return undefined;
  }
  return valor as Record<string, unknown>;
}

function rango(
  valor: unknown,
  limite: Limite,
  campo: string,
  errores: string[],
): void {
  if (valor === undefined || valor === null) return;
  if (typeof valor !== 'number' || !Number.isFinite(valor)) {
    errores.push(`${campo} tiene que ser un número`);
    return;
  }
  if (valor < limite.min || valor > limite.max) {
    errores.push(
      `${campo}: ${valor} está fuera de rango (${limite.min} a ${limite.max})`,
    );
  }
}

function largo(
  valor: unknown,
  maximo: number,
  campo: string,
  errores: string[],
): void {
  if (typeof valor !== 'string' || valor.length <= maximo) return;
  errores.push(
    `${campo} tiene ${valor.length} caracteres y el equipo guarda ${maximo}: ` +
      `lo recortaría en silencio y el equipo no conectaría`,
  );
}

/** Las redes: hasta 5, con SSID, y sin pasarse de los buffers del panel. */
function validarRedes(redes: unknown[], errores: string[]): void {
  if (redes.length > MAX_REDES) {
    errores.push(
      `El equipo guarda hasta ${MAX_REDES} redes y mandaste ${redes.length}`,
    );
  }
  redes.forEach((red: unknown, i) => {
    const fila =
      typeof red === 'object' && red !== null
        ? (red as Record<string, unknown>)
        : {};
    if (typeof fila.ssid !== 'string' || fila.ssid.length === 0) {
      errores.push(`La red ${i + 1} no tiene SSID`);
    }
    largo(fila.ssid, MAX_SSID_CHARS, `El SSID de la red ${i + 1}`, errores);
    largo(fila.psw, MAX_PSW_CHARS, `La contraseña de la red ${i + 1}`, errores);
    rango(fila.prio, LIMITES.prio, `La prioridad de la red ${i + 1}`, errores);
  });
}

/**
 * El auto-apagado por modo. Cada modo es independiente y el firmware clampa
 * cada uno por separado.
 *
 * El protocolo le da a `0` el significado "no tocar este modo", pero acá se
 * rechaza igual: la pantalla manda SIEMPRE los siete valores tomados del
 * espejo, así que un 0 nunca es "dejalo como está" sino un tipeo. Aceptarlo
 * sería mostrar 0 como el valor deseado mientras el equipo conserva otro.
 */
function validarAutooff(
  alarma: Record<string, unknown>,
  errores: string[],
): void {
  const autooff = seccion(alarma, 'autooff');
  if (!autooff) return;
  for (const modo of MODOS_AUTOOFF) {
    rango(
      autooff[modo],
      LIMITES.autooff_s,
      `El auto-apagado de ${modo}`,
      errores,
    );
  }
}

/**
 * Devuelve TODOS los errores, no corta en el primero: quien está completando el
 * formulario los arregla de una sola vez y no de a uno por intento.
 */
export function validarPatch(patch: Record<string, unknown>): string[] {
  const errores: string[] = [];

  const redes: unknown = patch.redes;
  if (Array.isArray(redes)) validarRedes(redes, errores);

  const tiempos = seccion(patch, 'tiempos');
  if (tiempos) {
    rango(tiempos.send_tele_s, LIMITES.send_tele_s, 'send_tele_s', errores);
  }

  // El único que hace descartar el documento entero sin ack. Un huso mal
  // tipeado no vuelve como error: vuelve como nada, y la pantalla queda
  // esperando para siempre una confirmación que el panel no va a mandar.
  const hora = seccion(patch, 'hora');
  if (hora) {
    rango(hora.tz_offset_s, LIMITES.tz_offset_s, 'tz_offset_s', errores);
  }

  const modulos = seccion(patch, 'modulos');
  if (modulos) {
    rango(modulos.eeprom_slot, LIMITES.eeprom_slot, 'eeprom_slot', errores);
  }

  const alarma = seccion(patch, 'alarma');
  if (alarma) validarAutooff(alarma, errores);

  const ra = seccion(patch, 'red_avanzada');
  if (ra) {
    // Los tres son obligatorios JUNTOS: si mandás el objeto con dos, el
    // firmware descarta la cfg entera sin ack (`mqtt_parse.c`), igual que el
    // huso horario. Es el otro caso de silencio, no de recorte.
    const faltantes = ROAMING.filter((c) => typeof ra[c] !== 'number');
    if (faltantes.length > 0 && faltantes.length < ROAMING.length) {
      errores.push(
        `El roaming va completo o no va: falta ${faltantes.join(', ')}`,
      );
    }
    rango(ra.roam_rssi, LIMITES.roam_rssi, 'roam_rssi', errores);
    rango(ra.roam_delta, LIMITES.roam_delta, 'roam_delta', errores);
    rango(
      ra.roam_cooldown_s,
      LIMITES.roam_cooldown_s,
      'roam_cooldown_s',
      errores,
    );
  }

  return errores;
}
