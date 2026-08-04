/**
 * Los límites que el FIRMWARE impone, en un solo lugar y con su fuente.
 *
 * Se validan de nuestro lado aunque el firmware clampe, porque el firmware
 * clampa EN SILENCIO y ackea 'ok': sin esto, el usuario pide 5 s de telemetría,
 * la pantalla dice "aplicado" y el equipo quedó en 30. El error tiene que decir
 * el valor efectivo, no un "valor inválido" genérico.
 *
 * Si el firmware cambia un límite, se cambia acá y el test falla hasta
 * reconciliar. Es el mismo criterio que `contract.py` del GtD: el contrato no
 * puede divergir en silencio.
 */

/** `WIFI_MAX_PROFILES` en `wifi_types.h`. */
export const MAX_REDES = 5;

/** `MQTT_IN_PAYLOAD_MAX`: el buffer de entrada del panel. */
export const MAX_PAYLOAD_BYTES = 1024;

export const LIMITES = {
  /** `app_tele_period_set` en `components/main/task_mqtt.c`. */
  send_tele_s: { min: 30, max: 86400 },
  /** Los tres, de `app_roam_set` en `components/main/task_wifi.c`. */
  roam_rssi: { min: -90, max: -50 },
  roam_delta: { min: 5, max: 30 },
  roam_cooldown_s: { min: 60, max: 3600 },
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

/**
 * Devuelve TODOS los errores, no corta en el primero: quien está completando el
 * formulario los arregla de una sola vez y no de a uno por intento.
 */
export function validarPatch(patch: Record<string, unknown>): string[] {
  const errores: string[] = [];

  const redes: unknown = patch.redes;
  if (Array.isArray(redes)) {
    if (redes.length > MAX_REDES) {
      errores.push(
        `El equipo guarda hasta ${MAX_REDES} redes y mandaste ${redes.length}`,
      );
    }
    redes.forEach((red: unknown, i) => {
      const ssid =
        typeof red === 'object' && red !== null
          ? (red as Record<string, unknown>).ssid
          : undefined;
      if (typeof ssid !== 'string' || ssid.length === 0) {
        errores.push(`La red ${i + 1} no tiene SSID`);
      }
    });
  }

  const tiempos = seccion(patch, 'tiempos');
  if (tiempos) {
    rango(tiempos.send_tele_s, LIMITES.send_tele_s, 'send_tele_s', errores);
  }

  const ra = seccion(patch, 'red_avanzada');
  if (ra) {
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
