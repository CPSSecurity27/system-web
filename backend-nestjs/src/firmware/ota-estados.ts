/**
 * Los enums del firmware, en castellano.
 *
 * El panel manda números: `up t:ota` lleva `estado` (`ota_state_t`) y
 * `resultado` (`ota_reject_t`), los dos como enteros. Hasta hoy llegaban a la
 * pantalla tal cual, dentro del JSONB de telemetría, y se leían así:
 *
 *     ota   estado: 8   ultimo: 0
 *
 * Que no le dice nada a nadie. Peor: el 8 es `CONFIRMED` —el mejor final
 * posible— y se veía igual de opaco que un 10, que es `FAILED`.
 *
 * ## El orden importa y no se toca
 *
 * Son los índices de `components/ota_engine/ota_types.h`. Si el firmware agrega
 * un estado EN EL MEDIO, esta tabla queda corrida y va a mentir con confianza.
 * Por eso el fallback dice el número: un "estado desconocido (11)" es una
 * pregunta que alguien puede investigar; un texto equivocado, no.
 */

/** `ota_state_t`. En qué anda el equipo. */
export const OTA_ESTADOS = [
  'sin actualizar', // OTA_ST_IDLE
  'recibió el pedido', // OTA_ST_OFFER_RECEIVED
  'bajando el manifiesto', // OTA_ST_MANIFEST_DOWNLOADING
  'rechazó el manifiesto', // OTA_ST_MANIFEST_REJECTED
  'descargando', // OTA_ST_DOWNLOADING
  'verificando', // OTA_ST_VERIFYING
  'instalada, reiniciando', // OTA_ST_READY_TO_REBOOT — el reinicio es automático
  'probándose', // OTA_ST_SELF_TEST      ← el firmware no lo emite
  'confirmada', // OTA_ST_CONFIRMED      ← el firmware no lo emite
  'volvió a la anterior', // OTA_ST_ROLLED_BACK    ← el firmware no lo emite
  'falló', // OTA_ST_FAILED
] as const;

/**
 * `ota_reject_t`. Por qué no se pudo.
 *
 * Los textos explican la CAUSA en términos de lo que hay que hacer, no el
 * nombre del enum: quien lee esto está mirando por qué un poste no actualizó, y
 * "el archivo se cortó" es accionable donde "SHA_INVALID" no lo es.
 */
export const OTA_RECHAZOS = [
  'sin problemas', // OTA_REJ_NONE
  'el manifiesto no se entiende o le falta un campo', // OTA_REJ_JSON_INVALID
  'el manifiesto es de una versión de formato más nueva que el equipo', // OTA_REJ_FORMAT_UNSUPPORTED
  'el firmware es de otro modelo de placa', // OTA_REJ_HW_MISMATCH
  'la versión del manifiesto está vacía o mal formada', // OTA_REJ_VERSION_INVALID
  'el manifiesto no dice cuánto pesa el archivo', // OTA_REJ_SIZE_INVALID
  'el firmware no entra en la memoria del equipo', // OTA_REJ_SIZE_EXCEEDS_SLOT
  'lo que se bajó no coincide con el manifiesto: el archivo se cortó o cambió', // OTA_REJ_SHA_INVALID
  'la URL no es https o el servidor no está permitido', // OTA_REJ_URL_INVALID
] as const;

/**
 * ## Cuáles de estos estados EXISTEN de verdad
 *
 * El firmware emite 8 de los 11 (`ota_report()` en `task_ota.c`):
 *
 *     0 idle · 1 offer · 2 manifest · 3 rechazado · 4 bajando ·
 *     5 verificando · 6 listo para reiniciar · 10 falló
 *
 * **`7 self_test`, `8 confirmed` y `9 rolled_back` NO los emite nadie.** Están
 * en el enum y en la tabla de strings del firmware, pero el bloque que confirma
 * la imagen (`task_admin.c`, self-test post-boot) hace `mark_app_valid`, escribe
 * la versión en NVS y **no publica ningún `up t:ota`**.
 *
 * ## La consecuencia, que no es menor
 *
 * **`6` (listo para reiniciar) es el estado FINAL de una actualización que
 * salió bien.** El equipo lo publica y medio segundo después hace `esp_restart()`
 * — el reinicio es automático, no espera ninguna orden— y ya no vuelve a
 * reportar nada del OTA.
 *
 * Por eso `6` NO cuenta como "en curso": si contara, la pantalla se
 * repreguntaría para siempre esperando un mensaje que no va a llegar nunca.
 *
 * Y por eso un rollback es INVISIBLE por este canal: el equipo simplemente
 * sigue reportando la versión vieja. Lo que confirma que una actualización
 * funcionó es que **`device_state.fw` pase a ser la nueva**, que es lo que
 * compara el gestor de la flota.
 *
 * (Propuesta F-OTA-5 en `docs/propuestas-firmware-ota.md`: dos líneas en el
 * self-test cerrarían el lazo de verdad.)
 */
const EN_CURSO = new Set([1, 2, 4, 5, 7]);

export interface OtaProgresoView {
  estado: number;
  /** El estado en castellano, o el número si el firmware sumó uno nuevo. */
  estadoTexto: string;
  resultado: number;
  /** Solo cuando hay algo que decir: `null` si el último intento salió bien. */
  motivo: string | null;
  /** La versión que el equipo declaró en ese mensaje. */
  fw: string | null;
  /** El equipo está trabajando AHORA: bajando, verificando. */
  enCurso: boolean;
  /**
   * Instaló y se reinició solo. **Es el final del camino por este canal**: no
   * hay ningún mensaje posterior que diga si la imagen quedó confirmada.
   *
   * Que haya funcionado se comprueba mirando `device_state.fw`, y de eso se
   * ocupa la comparación de la flota.
   */
  esperandoReinicio: boolean;
  /**
   * Terminó mal.
   *
   * Incluye el rollback (9) por si algún día el firmware lo emite, pero **hoy
   * no lo emite**: un rollback se ve como que el equipo sigue reportando la
   * versión vieja, no como una falla explícita.
   */
  fallo: boolean;
  recibidoEn: string;
}

export function traducirEstado(estado: number): string {
  return OTA_ESTADOS[estado] ?? `estado desconocido (${estado})`;
}

export function traducirRechazo(resultado: number): string | null {
  if (resultado === 0) return null;
  return OTA_RECHAZOS[resultado] ?? `rechazo desconocido (${resultado})`;
}

/**
 * Hasta dónde se puede afirmar que una actualización funcionó.
 *
 * ## Por qué esto no es simplemente `fw === publicada`
 *
 * Porque **`fw` no es evidencia independiente: es una etiqueta NUESTRA que el
 * equipo nos devuelve.** La cadena, verificada en el firmware:
 *
 * 1. `task_ota` escribe en NVS `target = m.version` — el string que pusimos en
 *    nuestro manifiesto— **antes de empezar a descargar**.
 * 2. Al reiniciar, el self-test comprueba **una sola cosa**:
 *    `system_state_internet_ok()`. Si hay internet en 10 minutos, marca la
 *    imagen válida y hace `installed = target`.
 * 3. Eso es lo que el equipo reporta como su versión.
 *
 * Así que ver la versión nueva prueba que **una imagen arrancó y consiguió
 * internet**. No prueba que el firmware ande: la alarma puede estar muerta, el
 * RF sordo o el bus I2C caído, y el equipo va a reportar la versión nueva igual.
 * (Ese hueco es justo para el que se diseñó `emergency_mode`, cuyo trigger sigue
 * en `if (0)` — ver `docs/propuestas-firmware-ota.md`.)
 *
 * Por eso lo más fuerte que se puede decir es "arrancó y volvió a hablar", y hay
 * un caso donde ni siquiera eso: si el equipo YA estaba en la versión que se le
 * mandó, la etiqueta no cambia y no distingue el éxito del fracaso.
 */
export type ConfirmacionOta =
  /** Volvió a hablar después del reinicio y ahora reporta la versión nueva. */
  | 'arranco'
  /** Instaló y se reinició; todavía no lo escuchamos. */
  | 'reiniciando'
  /** Volvió y sigue con la anterior: revirtió o nunca aplicó. */
  | 'no_aplico'
  /** Ya estaba en esa versión: la etiqueta no puede confirmar nada. */
  | 'indistinguible'
  /** El propio equipo reportó que falló. */
  | 'fallo';

export interface ConfirmacionView {
  estado: ConfirmacionOta;
  /** Qué se puede afirmar y qué no, en una línea, para mostrarlo tal cual. */
  detalle: string;
}

export function confirmarActualizacion(args: {
  progreso: OtaProgresoView | null;
  /** La versión que el equipo reporta AHORA (`device_state.fw`). */
  fwActual: string | null;
  /** Cuándo lo escuchamos por última vez. */
  ultimaSenal: Date | null;
}): ConfirmacionView | null {
  const { progreso, fwActual, ultimaSenal } = args;
  if (!progreso) return null;

  if (progreso.fallo) {
    return {
      estado: 'fallo',
      detalle: progreso.motivo ?? 'El equipo rechazó la actualización.',
    };
  }

  if (!progreso.esperandoReinicio) return null;

  // La versión que el equipo declaraba MIENTRAS actualizaba, o sea la de antes.
  const anterior = progreso.fw;

  // Sin una señal POSTERIOR al reinicio no se puede afirmar nada: lo que
  // sabemos de él es de antes de que se reiniciara.
  const volvioAHablar =
    ultimaSenal !== null &&
    ultimaSenal.getTime() > new Date(progreso.recibidoEn).getTime();

  if (!volvioAHablar) {
    return {
      estado: 'reiniciando',
      detalle:
        'Instaló y se reinició solo. Todavía no volvió a hablar, así que no se ' +
        'puede confirmar nada.',
    };
  }

  if (anterior !== null && fwActual === anterior) {
    return {
      estado: 'no_aplico',
      detalle:
        `Volvió a conectarse pero sigue reportando ${anterior}: la imagen no ` +
        'arrancó bien y el equipo revirtió sola a la anterior.',
    };
  }

  if (fwActual !== null && anterior !== null && fwActual !== anterior) {
    return {
      estado: 'arranco',
      detalle:
        'Arrancó con la versión nueva y consiguió internet. Ojo: eso es TODO lo ' +
        'que comprueba el equipo — que ande la alarma o el RF no se verifica.',
    };
  }

  // No sabemos qué versión tenía antes (el mensaje no la traía), así que la
  // comparación no distingue nada.
  return {
    estado: 'indistinguible',
    detalle:
      'Volvió a conectarse, pero no se puede confirmar por la versión: no hay ' +
      'con qué compararla.',
  };
}

export function armarProgreso(fila: {
  estado: number;
  resultado: number;
  fw: string | null;
  received_at: Date;
}): OtaProgresoView {
  return {
    estado: fila.estado,
    estadoTexto: traducirEstado(fila.estado),
    resultado: fila.resultado,
    motivo: traducirRechazo(fila.resultado),
    fw: fila.fw,
    enCurso: EN_CURSO.has(fila.estado),
    esperandoReinicio: fila.estado === 6,
    // 3 = rechazó el manifiesto, 10 = falló. El 9 (rollback) va por si el
    // firmware lo emite algún día; hoy no lo emite ninguno.
    fallo: fila.estado === 3 || fila.estado === 9 || fila.estado === 10,
    recibidoEn: fila.received_at.toISOString(),
  };
}
