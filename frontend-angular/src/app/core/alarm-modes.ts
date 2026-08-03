/**
 * Catálogo de modos de activación de la alarma.
 *
 * El CÓDIGO no es nuestro: lo manda el hardware por MQTT y queda escrito tal
 * cual en `event.trigger_mode` (TEXT, ver `docs/esquema-postgres-v2.sql`).
 * Etiqueta, ícono y color SÍ son nuestros y se pueden cambiar sin tocar nada
 * más. Nunca al revés.
 *
 * Portado del catálogo de la app de vecinos (`lib/core/alarm_modes.dart`) para
 * que un incendio se vea igual en el celular del vecino y en el panel del
 * monitoreo. Allá son 8 modos aunque dos estén hardcodeados fuera de su tema;
 * acá los 8 nacen como token.
 *
 * Hasta el 2026-08-02 el panel guardaba `triggerMode` y no lo mostraba en
 * ninguna pantalla: el monitor veía "APP" o "REMOTE" y no si era incendio,
 * médica o ladrón.
 */

export interface AlarmMode {
  /** El código del hardware. No se toca. */
  code: string;
  label: string;
  icon: string;
  /** Clase que fija --mode-accent y --mode-soft (ver styles.scss). */
  toneClass: string;
}

export const ALARM_MODES: readonly AlarmMode[] = [
  { code: 'cps001', label: 'Activar alarma', icon: 'icon-radio-tower', toneClass: 'mode-activar' },
  { code: 'cps002', label: 'Sospechoso', icon: 'icon-eye', toneClass: 'mode-sospechoso' },
  { code: 'cps003', label: 'Ladrón', icon: 'icon-footprints', toneClass: 'mode-ladron' },
  { code: 'cps004', label: 'Policía', icon: 'icon-shield', toneClass: 'mode-policia' },
  { code: 'cps005', label: 'Silenciosa', icon: 'icon-bell-off', toneClass: 'mode-silenciosa' },
  { code: 'cps006', label: 'Incendio', icon: 'icon-flame', toneClass: 'mode-incendio' },
  { code: 'cps007', label: 'Médica', icon: 'icon-heart-pulse', toneClass: 'mode-medica' },
  { code: 'cps999', label: 'Desactivar', icon: 'icon-power', toneClass: 'mode-desactivar' },
] as const;

const POR_CODIGO = new Map(ALARM_MODES.map((m) => [m.code, m]));

/**
 * Un código que no conocemos se muestra CRUDO, nunca rompe la fila: si mañana
 * el hardware manda `cps010`, preferimos ver `cps010` en el tablero antes que
 * un tablero vacío. Mismo criterio que `lookOf()` en status-map.
 */
export function alarmMode(code: string | null | undefined): AlarmMode | null {
  if (!code) {
    return null;
  }

  return (
    POR_CODIGO.get(code) ?? {
      code,
      label: code,
      icon: 'icon-circle-help',
      toneClass: 'mode-desconocido',
    }
  );
}
