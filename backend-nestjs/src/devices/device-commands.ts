/**
 * El catálogo de comandos del panel, con lo que cada uno necesita y lo que
 * cuesta.
 *
 * Los 13 tipos son los de `mqtt_cmd_type_t` (`components/mqtt_av/mqtt_parse.h`)
 * y la base ya los ataja con `chk_commands_tipo`. Acá se agrega lo que la base
 * no puede saber: qué parámetros lleva cada uno, con qué buffers del firmware
 * chocan, y qué le pasa al equipo si se manda.
 *
 * Igual que con la configuración: un parámetro fuera de forma no vuelve como
 * error. `mqtt_parse_cfg` hace `goto done` y el panel **descarta el comando en
 * silencio** — sin ack, sin nada. La validación de acá es la única que puede
 * decir qué pasó.
 */

/** Los slugs de `alarma_core.h`. `off` apaga; los otros 7 disparan. */
export const MODOS_ALARMA = [
  'off',
  'suspicious',
  'alert',
  'emergency',
  'fire',
  'medical',
  'silent',
  'panic',
] as const;
export type ModoAlarma = (typeof MODOS_ALARMA)[number];

/** Buffers del firmware (`mqtt_parse.h`). Se truncan en silencio. */
export const MAX_OTA_BASE_CHARS = 159; // char ota_base[160]
export const MAX_RED_SSID_CHARS = 31; // char red_ssid[32]

/**
 * Los comandos que la web sabe mandar hoy.
 *
 * Quedan afuera a propósito, y no por olvido:
 * - `rf` — la base de códigos de los controles. Se define aparte.
 * - `cal` — calibrar los canales de tensión. Cambia lo que SIGNIFICAN los
 *   voltajes reportados, y con eso las alertas de batería. Necesita alguien
 *   parado al lado del poste con un tester, así que es una herramienta de campo
 *   y no un botón de oficina.
 * - `test` — probar un SSID puntual. Misma razón que `cal`.
 * - `scan` y `refresh` — existen, pero con su propia ruta en la pantalla de
 *   configuración, que es donde tienen sentido.
 */
export const COMANDOS = [
  'estado',
  'hora',
  'i2c_scan',
  'red',
  'restart',
  'factory',
  'ota',
  'scan',
  'refresh',
] as const;
export type TipoComando = (typeof COMANDOS)[number];

export function esComando(tipo: string): tipo is TipoComando {
  return (COMANDOS as readonly string[]).includes(tipo);
}

/**
 * Arma el payload que viaja al panel y devuelve los errores encontrados.
 *
 * `serial` es necesario para `factory`: el firmware exige que el `confirm`
 * traiga el ID del propio equipo (`AV-<MAC>`, que es exactamente nuestro
 * serial). Esa fricción la puso el firmware a propósito y no se saltea: el
 * backend lo completa solo, pero la pantalla igual le hace tipear el serial a
 * quien aprieta el botón, porque la fricción sirve del lado del humano.
 */
export function armarComando(
  tipo: TipoComando,
  params: Record<string, unknown>,
  serial: string,
): { payload: Record<string, unknown>; errores: string[] } {
  const errores: string[] = [];

  switch (tipo) {
    case 'estado':
    case 'i2c_scan':
    case 'restart':
    case 'scan':
    case 'refresh':
      return { payload: {}, errores };

    case 'hora':
      return { payload: { op: 'sync' }, errores };

    case 'red': {
      const ssid = params.ssid;
      if (typeof ssid !== 'string' || ssid.length === 0) {
        errores.push('Hay que decir qué red destrabar');
      } else if (ssid.length > MAX_RED_SSID_CHARS) {
        errores.push(
          `El SSID no puede pasar de ${MAX_RED_SSID_CHARS} caracteres`,
        );
      }
      return { payload: { op: 'bl_clear', ssid }, errores };
    }

    case 'factory':
      // El backend pone el valor correcto; que la confirmación humana coincida
      // se chequea antes, contra el serial que tipeó la persona.
      return { payload: { confirm: serial }, errores };

    case 'ota': {
      const fuente = params.fuente === 'url' ? 'url' : 'auto';
      if (fuente === 'auto') return { payload: { fuente: 'auto' }, errores };

      const base = params.base;
      if (typeof base !== 'string' || base.length === 0) {
        errores.push(
          'Con origen "url" hay que decir de dónde baja el firmware',
        );
      } else if (base.length > MAX_OTA_BASE_CHARS) {
        errores.push(
          `La URL no puede pasar de ${MAX_OTA_BASE_CHARS} caracteres: el equipo la recortaría y bajaría de cualquier lado`,
        );
      } else if (!/^https?:\/\//i.test(base)) {
        errores.push('La URL tiene que empezar con http:// o https://');
      }
      return { payload: { fuente: 'url', base }, errores };
    }
  }
}

/** Lo que el comando le hace al equipo, para que la pantalla lo diga antes. */
export const CONSECUENCIA: Record<TipoComando, string | null> = {
  estado: null,
  hora: null,
  i2c_scan: null,
  red: null,
  scan: 'Mientras busca redes, el equipo no está atendiendo la alarma.',
  refresh: null,
  restart:
    'El equipo se reinicia. Durante ese rato el barrio tiene una alarma menos.',
  factory:
    'Borra la configuración y LAS REDES WiFi. El equipo se queda sin forma de ' +
    'conectarse: hay que ir hasta el poste a reconfigurarlo por el portal local. ' +
    'Los controles remotos NO se borran (viven en otra memoria), pero el equipo ' +
    'va a reportar generación 0 hasta que se le vuelva a mandar la base.',
  ota: 'El equipo baja el firmware nuevo y se reinicia. Necesita estar con energía suficiente.',
};
