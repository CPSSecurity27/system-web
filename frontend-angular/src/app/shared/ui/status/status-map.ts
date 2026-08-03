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
    // Un evento abierto ES una alarma sonando: familia de emergencia, no de marca.
    OPEN: {
      label: 'Abierto',
      classes: 'bg-emergency-soft text-emergency border',
      icon: 'icon-radio-tower',
    },
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
    INVENTORY: { label: 'En stock', classes: 'bg-light text-muted border', icon: 'icon-package' },
    OPERATIONAL: { label: 'Operativa', classes: 'bg-success-soft text-success border' },
    // Sin `text-warning` el badge sale con el color por defecto de Bootstrap,
    // que es BLANCO: ámbar clarito sobre ámbar clarito, ilegible.
    MAINTENANCE: {
      label: 'En mantenimiento',
      classes: 'bg-warning-soft text-warning border',
      icon: 'icon-wrench',
    },
    OUT_OF_SERVICE: {
      label: 'Fuera de servicio',
      classes: 'bg-emergency-soft text-emergency border',
      icon: 'icon-triangle-alert',
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
