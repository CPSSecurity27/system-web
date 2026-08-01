/**
 * Estado del dominio -> cómo se ve. En UN solo lugar.
 *
 * Antes este mapeo estaba repetido en 17 archivos: cambiar el color de
 * "Resuelto" era buscarlo en todos. Y peor: dos pantallas podían mostrar el
 * mismo estado de dos colores distintos sin que nadie lo notara.
 *
 * Por ahora solo `event`. `device`, `contract` y `entity` se suman acá mismo
 * cuando sus pantallas les toquen (Fases 3 y 5).
 */

export interface StatusLook {
  label: string;
  classes: string;
  icon?: string;
}

export type StatusKind = 'event' | 'device';

export const STATUS_MAP: Record<StatusKind, Record<string, StatusLook>> = {
  event: {
    OPEN: { label: 'Abierto', classes: 'bg-brand-soft text-brand border', icon: 'bi-broadcast' },
    RESOLVED: { label: 'Resuelto', classes: 'bg-success-soft text-success border' },
    FALSE_ALARM: { label: 'Falsa alarma', classes: 'bg-light text-muted border' },
  },
  /**
   * El estado ADMINISTRATIVO del equipo: lo que ES. Si está online o mudo es
   * estado VIVO y va aparte (device_state) — mezclarlos taparía el caso que más
   * importa: una alarma OPERATIONAL que hace tres días no se conecta.
   *
   * INSTALLED ya no existe (2026-07-31): era lo mismo que OPERATIONAL.
   */
  device: {
    INVENTORY: { label: 'En stock', classes: 'bg-light text-muted border', icon: 'bi-box-seam' },
    OPERATIONAL: { label: 'Operativa', classes: 'bg-success-soft text-success border' },
    MAINTENANCE: {
      label: 'En mantenimiento',
      classes: 'bg-warning-soft border',
      icon: 'bi-tools',
    },
    OUT_OF_SERVICE: {
      label: 'Fuera de servicio',
      classes: 'bg-brand-soft text-brand border',
      icon: 'bi-exclamation-triangle',
    },
    RETIRED: { label: 'Dada de baja', classes: 'bg-light text-muted border' },
  },
};

/**
 * Un valor que no está en el mapa se muestra crudo: preferimos ver
 * 'LO_QUE_SEA' en pantalla antes que romper el listado entero.
 */
export function lookOf(kind: StatusKind, value: string): StatusLook {
  return STATUS_MAP[kind][value] ?? { label: value, classes: 'bg-light text-muted border' };
}
