import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet';

/**
 * Qué representa el punto. Cambia el color porque en un mismo mapa conviven
 * cosas distintas: la alarma es del BARRIO (infraestructura en la vía pública)
 * y la vivienda es de un vecino — pintarlas igual las hace indistinguibles.
 */
export type MapMarkerVariant = 'device' | 'home' | 'center';

export interface MapMarker {
  latitude: number;
  longitude: number;
  label: string;
  /** Emergencia activa: se pinta rojo y pulsa. Gana sobre `variant`. */
  emergency?: boolean;
  /** Default: 'device'. */
  variant?: MapMarkerVariant;
}

const VARIANT_COLOR: Record<MapMarkerVariant, string> = {
  device: '#388e3c', // verde: alarma del barrio
  home: '#1565c0', // azul: vivienda
  center: '#f57c00', // naranja: centro del barrio
};

/**
 * Leaflet sobre un bundler pierde los íconos por defecto: el CSS los busca en
 * una ruta relativa (`images/marker-icon.png`) que después del build no existe.
 * Por eso los marcadores se dibujan con divIcon (HTML propio) y no se usa el
 * ícono que trae la librería. De paso permite pintarlos con los colores de marca.
 */
function brandIcon(emergency: boolean, variant: MapMarkerVariant = 'device'): L.DivIcon {
  const color = emergency ? '#d32f2f' : VARIANT_COLOR[variant];
  const pulse = emergency ? 'animate-pulse-emergency' : '';
  // El centro del barrio es una referencia, no un objeto físico: va más chico
  // y translúcido para que no compita con las alarmas y las casas.
  const size = variant === 'center' ? 12 : 16;
  const opacity = variant === 'center' ? '.75' : '1';

  return L.divIcon({
    className: '',
    html: `<span class="d-block rounded-circle border border-2 border-white ${pulse}"
                 style="width:${size}px;height:${size}px;background:${color};opacity:${opacity};box-shadow:0 0 0 1px rgba(0,0,0,.2)"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

@Component({
  selector: 'app-map',
  template: `<div #host class="map-viewport border"></div>`,
})
export class Map implements AfterViewInit, OnDestroy {
  readonly markers = input<MapMarker[]>([]);
  /** Centro por defecto: Córdoba capital. */
  readonly center = input<[number, number]>([-31.4167, -64.1836]);
  readonly zoom = input(13);

  /**
   * Modo "elegir ubicación": un click deja un marcador y emite lat/lng
   * (para que un formulario las tome sin que nadie tipee coordenadas).
   */
  readonly clickable = input(false);
  readonly positionChange = output<{ latitude: number; longitude: number }>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private map?: L.Map;
  private layer?: L.LayerGroup;
  private pickMarker?: L.Marker;

  constructor() {
    effect(() => {
      const markers = this.markers();
      if (this.map) {
        this.draw(markers);
      }
    });

    /**
     * El centro puede llegar DESPUÉS de que el mapa se creó: quien lo calcula
     * suele necesitar una segunda llamada (la alarma sin coordenadas se centra
     * en su barrio, y el barrio se pide aparte). Leerlo solo en
     * `ngAfterViewInit` hacía que ese caso —justo el que importa— nunca
     * funcionara.
     *
     * No pisa nada: con marcadores manda el `fitBounds` de `draw`, y si el
     * usuario ya eligió un punto no se le mueve el mapa abajo del mouse.
     */
    effect(() => {
      const center = this.center();
      if (this.map && this.markers().length === 0 && !this.pickMarker) {
        this.map.setView(center, this.zoom());
      }
    });
  }

  ngAfterViewInit(): void {
    this.map = L.map(this.host().nativeElement).setView(this.center(), this.zoom());

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(this.map);

    this.layer = L.layerGroup().addTo(this.map);
    this.draw(this.markers());

    if (this.clickable()) {
      this.map.on('click', (e: L.LeafletMouseEvent) => {
        const latitude = Number(e.latlng.lat.toFixed(6));
        const longitude = Number(e.latlng.lng.toFixed(6));

        if (this.pickMarker) {
          this.pickMarker.setLatLng(e.latlng);
        } else if (this.map) {
          this.pickMarker = L.marker(e.latlng, { icon: brandIcon(false) }).addTo(this.map);
        }

        this.positionChange.emit({ latitude, longitude });
      });
    }
  }

  ngOnDestroy(): void {
    this.map?.remove();
  }

  private draw(markers: MapMarker[]): void {
    if (!this.map || !this.layer) {
      return;
    }

    this.layer.clearLayers();

    for (const marker of markers) {
      L.marker([marker.latitude, marker.longitude], {
        icon: brandIcon(marker.emergency ?? false, marker.variant ?? 'device'),
      })
        .bindPopup(marker.label)
        .addTo(this.layer);
    }

    if (markers.length > 0) {
      const bounds = L.latLngBounds(markers.map((m) => [m.latitude, m.longitude] as L.LatLngTuple));
      this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    }
  }
}
