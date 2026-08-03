import { Component, input } from '@angular/core';

import { MAP_VARIANTS, MapMarkerVariant } from './map';

export interface MapLegendItem {
  variant: MapMarkerVariant;
  count: number;
}

/**
 * La leyenda del mapa, leída de la MISMA tabla que pinta los marcadores.
 *
 * Antes cada pantalla repetía los colores a mano en un `style` inline, así que
 * alcanzaba con tocar un lado para que la leyenda dijera "verde = alarmas"
 * mientras el mapa las dibujaba de otro color. Es el bug que hoy tiene la app
 * de vecinos: su leyenda dice que la emergencia es ámbar y los pines salen del
 * color del modo.
 */
@Component({
  selector: 'cps-map-legend',
  template: `
    <div class="d-flex gap-3 flex-wrap small text-muted">
      @for (item of items(); track item.variant) {
        <span>
          <span class="legend-dot" [style.background]="look(item.variant).color"></span>
          {{ look(item.variant).label }} ({{ item.count }})
        </span>
      }
    </div>
  `,
  styles: `
    .legend-dot {
      display: inline-block;
      vertical-align: middle;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 0.25rem;
    }
  `,
})
export class MapLegend {
  readonly items = input<MapLegendItem[]>([]);

  protected look(variant: MapMarkerVariant) {
    return MAP_VARIANTS[variant];
  }
}
