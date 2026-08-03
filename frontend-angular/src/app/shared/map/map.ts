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

import { alarmMode } from '../../core/alarm-modes';

/**
 * Qué representa el punto. Cambia el color porque en un mismo mapa conviven
 * cosas distintas: la alarma es del BARRIO (infraestructura en la vía pública)
 * y la vivienda es de un vecino — pintarlas igual las hace indistinguibles.
 */
export type MapMarkerVariant =
  | 'device'
  | 'home'
  | 'center'
  // Tablero de clientes. Son otra escala: no son objetos dentro de un barrio
  // sino clientes repartidos por el país.
  | 'municipal'
  | 'community';

export interface MapVariantLook {
  /** El texto de la leyenda. */
  label: string;
  /** Valor CSS, casi siempre un token. */
  color: string;
  icon: string;
  size: number;
}

/**
 * La ÚNICA definición de cómo se ve cada punto. La leyenda de la pantalla del
 * barrio la lee de acá en vez de repetir los colores a mano: hasta el
 * 2026-08-02 los tenía hardcodeados y bastaba tocar uno solo de los dos lados
 * para que la leyenda dijera una cosa y el mapa mostrara otra. Es el mismo bug
 * que hoy tiene la app de vecinos.
 */
export const MAP_VARIANTS: Record<MapMarkerVariant, MapVariantLook> = {
  device: { label: 'Alarmas', color: 'var(--brand)', icon: 'icon-radio-tower', size: 32 },
  home: { label: 'Viviendas', color: 'var(--map-home)', icon: 'icon-house', size: 32 },
  // El centro del barrio es una referencia, no un objeto físico: va más chico y
  // apagado para que no compita con las alarmas y las casas.
  center: {
    label: 'Centro del barrio',
    color: 'var(--text-muted)',
    icon: 'icon-map-pin',
    size: 24,
  },
  // Los dos CLIENTES van del mismo tamaño: son el mismo tipo de cosa y ninguno
  // manda sobre el otro. Los íconos dicen QUÉ es cada uno, no "hay algo acá":
  //   landmark -> el edificio público, la sede de la municipalidad.
  //   fence    -> el consorcio: lo que define a una comunitaria es el cerco.
  // Antes la comunidad usaba `users`, que es "gente" y no un lugar.
  //
  // No hay variante de BARRIO: el tablero de clientes muestra clientes, y los
  // barrios se ven en la lista y en el mapa de su propio barrio.
  municipal: {
    label: 'Municipales',
    color: 'var(--map-municipal)',
    icon: 'icon-landmark',
    size: 34,
  },
  community: {
    label: 'Comunitarias',
    color: 'var(--map-community)',
    icon: 'icon-fence',
    size: 34,
  },
};

export const MAP_EMERGENCY: MapVariantLook = {
  label: 'Emergencia',
  color: 'var(--danger)',
  icon: 'icon-triangle-alert',
  size: 38,
};

export interface MapMarker {
  latitude: number;
  longitude: number;
  label: string;
  /**
   * Con qué se corresponde este pin del lado de quien lo dibuja. Viaja de
   * vuelta en `markerClick`, así la pantalla sabe QUÉ se clickeó sin tener que
   * buscar por coordenadas (dos cosas pueden estar en el mismo punto: una
   * comunitaria y su único barrio, sin ir más lejos).
   */
  id?: string;
  /** El pin elegido: se agranda y se le marca un anillo. */
  selected?: boolean;
  /** Emergencia activa: se pinta rojo y pulsa. Gana sobre `variant`. */
  emergency?: boolean;
  /** Default: 'device'. */
  variant?: MapMarkerVariant;
  /**
   * Código del hardware (`cps006`…). Sólo se usa con `emergency`: pinta el pin
   * del color del MOTIVO, para que un incendio y una médica no se vean igual.
   */
  modeCode?: string | null;
}

/**
 * Leaflet sobre un bundler pierde los íconos por defecto: el CSS los busca en
 * una ruta relativa (`images/marker-icon.png`) que después del build no existe.
 * Por eso los marcadores se dibujan con divIcon (HTML propio).
 *
 * ── El anclaje, que es lo que no es obvio ──
 * El pin es un cuadrado de lado S con tres esquinas redondeadas, rotado -45°
 * para que la cuarta quede apuntando hacia abajo. Esa punta NO está dentro de
 * la caja: antes de rotar es la esquina inferior izquierda, y al girar cae en
 *     x = S/2 ,  y = S/2 + (√2/2)·S ≈ 1.2071·S
 * medido desde el vértice superior izquierdo de la caja. Si se ancla en el
 * centro (S/2, S/2), como estaba antes, TODOS los puntos quedan corridos hacia
 * arriba y a la izquierda respecto de su coordenada real — sobre un mapa de
 * barrio eso son varios metros. La app de vecinos tropezó con lo mismo y lo
 * arregló dos veces (commits `7688d96` y `02e7e36`).
 */
const TIP = 0.5 + Math.SQRT2 / 2;

function brandIcon(marker: MapMarker): L.DivIcon {
  const emergency = marker.emergency ?? false;
  const variant = marker.variant ?? 'device';
  const look = emergency ? MAP_EMERGENCY : MAP_VARIANTS[variant];

  // Con motivo conocido manda el color del modo; sin él, el rojo de emergencia.
  const modo = emergency ? alarmMode(marker.modeCode) : null;
  const tone = modo ? modo.toneClass : '';
  const color = modo ? 'var(--mode-accent)' : look.color;
  const icon = modo ? modo.icon : look.icon;
  const pulse = emergency ? 'map-pin-pulse' : '';
  // El seleccionado crece un 25%: el anillo solo no alcanza cuando hay muchos
  // pines juntos, que es justo el caso del tablero.
  const selected = marker.selected ? 'map-pin-selected' : '';
  const size = marker.selected ? Math.round(look.size * 1.25) : look.size;

  return L.divIcon({
    className: '',
    // El tamaño del ícono va inline porque en CSS no se puede derivar de un
    // ancho fijado en px; 42% es la proporción que usa la app.
    html: `<span class="map-pin ${tone} ${pulse} ${selected}"
                 style="--pin:${color};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">
             <i class="${icon}"></i>
           </span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size * TIP],
    popupAnchor: [0, -size * TIP],
  });
}

@Component({
  selector: 'app-map',
  template: `<div #host class="map-viewport border" [style.--map-h]="height()"></div>`,
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

  /**
   * Con qué pinta el marcador que se deja al clickear en modo `clickable`.
   *
   * Existe porque el default —`device`, una antena de alarma— era ENGAÑOSO en
   * el alta de cliente: marcabas la sede de una municipalidad y aparecía el
   * ícono de una alarma comunitaria, que es otra cosa del modelo. Ahora el pin
   * que dejás es igual al que vas a ver después en el tablero.
   */
  readonly pickVariant = input<MapMarkerVariant>('device');

  /**
   * Click en un PIN (no en el mapa vacío, que es `positionChange`). Devuelve el
   * marcador entero: quien lo dibujó ya sabe qué representa por su `id`.
   */
  readonly markerClick = output<MapMarker>();

  /** Globo con la etiqueta al clickear. Se apaga donde el click abre otra cosa. */
  readonly popups = input(true);

  /** Alto en CSS (ej. `'320px'`). Sin esto vale el del `.map-viewport`. */
  readonly height = input<string | null>(null);

  /**
   * Contador para FORZAR un reencuadre sobre todos los marcadores. Incrementarlo
   * es el "ver todo" de quien usa el componente.
   *
   * Hace falta porque `draw` solo reencuadra cuando cambia el conjunto de
   * puntos (ver `lastBoundsKey`): después de volar a un pin, el conjunto es el
   * mismo, así que sin esta puerta no habría forma de volver a la vista general.
   */
  readonly refit = input(0);

  /**
   * Traer un punto a la vista, sin reencuadrar todo. Lo usa la lista del
   * tablero: al elegir una fila, su pin tiene que quedar visible.
   *
   * Solo se mueve si el punto está FUERA de la vista actual, y conserva el zoom
   * que tenga puesto el usuario. Centrar y acercar siempre destruiría la vista
   * general —que es a lo que se viene a este mapa— cada vez que se elige algo
   * que ya se estaba viendo.
   *
   * Es un input y no un método para que la pantalla no tenga que agarrar una
   * referencia al componente: cambia la señal y el mapa reacciona.
   */
  readonly focusOn = input<{ latitude: number; longitude: number; zoom?: number } | null>(
    null,
  );

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private map?: L.Map;
  private layer?: L.LayerGroup;
  private pickMarker?: L.Marker;

  /**
   * Las posiciones del último `fitBounds`, para no repetirlo cuando lo único
   * que cambió es CUÁL está seleccionado.
   *
   * Sin esto, seleccionar un pin reencuadra el mapa entero: `selected` cambia
   * el array de marcadores, `draw` corre de nuevo y el `fitBounds` te tira el
   * zoom abajo del mouse justo cuando estabas mirando algo. Reencuadrar es
   * correcto cuando cambia el CONJUNTO (un filtro, una búsqueda); no cuando
   * cambia la selección.
   */
  private lastBoundsKey = '';

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

    effect(() => {
      const focus = this.focusOn();
      if (!this.map || !focus) return;

      const punto = L.latLng(focus.latitude, focus.longitude);
      // Ya está a la vista: no se le mueve el mapa a alguien que no lo pidió.
      if (!focus.zoom && this.map.getBounds().contains(punto)) return;

      this.map.flyTo(punto, focus.zoom ?? this.map.getZoom(), { duration: 0.6 });
    });

    effect(() => {
      const pedido = this.refit();
      const markers = this.markers();
      if (!this.map || pedido === 0 || markers.length === 0) return;

      const bounds = L.latLngBounds(
        markers.map((m) => [m.latitude, m.longitude] as L.LatLngTuple),
      );
      this.map.flyToBounds(bounds, { padding: [40, 40], maxZoom: 16, duration: 0.6 });
    });
  }

  ngAfterViewInit(): void {
    this.map = L.map(this.host().nativeElement).setView(this.center(), this.zoom());

    /**
     * CARTO Voyager, el mismo basemap que la app de vecinos. Antes era el OSM
     * estándar: el mismo barrio se veía de dos colores distintos según lo
     * miraras desde el celular o desde el panel.
     *
     * Sin API key. El uso gratuito con atribución está pensado para volúmenes
     * bajos; antes de escalar a un municipio hay que revisar la política de
     * CARTO (riesgo abierto en el spec de unificación).
     *
     * Los subdominios a–d paralelizan la descarga de tiles. Cambiar
     * `voyager` por `dark_all` da el basemap oscuro para la sala de monitoreo.
     */
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap · CARTO',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(this.map);

    this.layer = L.layerGroup().addTo(this.map);
    this.draw(this.markers());

    if (this.clickable()) {
      this.map.on('click', (e: L.LeafletMouseEvent) => {
        const latitude = Number(e.latlng.lat.toFixed(6));
        const longitude = Number(e.latlng.lng.toFixed(6));

        const icon = brandIcon({
          latitude,
          longitude,
          label: '',
          variant: this.pickVariant(),
        });

        if (this.pickMarker) {
          this.pickMarker.setLatLng(e.latlng);
          // El ícono se REPONE en cada click: el tipo puede haber cambiado
          // desde que se marcó (volviste atrás en el wizard y elegiste otro).
          this.pickMarker.setIcon(icon);
        } else if (this.map) {
          this.pickMarker = L.marker(e.latlng, { icon }).addTo(this.map);
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
      const pin = L.marker([marker.latitude, marker.longitude], {
        icon: brandIcon(marker),
      }).addTo(this.layer);

      // El click se emite siempre (si nadie escucha, no cuesta nada). El popup
      // es opt-out: en el tablero el pin ES el botón que abre el panel lateral,
      // y un globo encima taparía justo lo que se acaba de mostrar.
      pin.on('click', () => this.markerClick.emit(marker));
      if (this.popups()) pin.bindPopup(marker.label);
    }

    if (markers.length === 0) return;

    // Solo se reencuadra cuando cambió el CONJUNTO de puntos, no cuando cambió
    // la selección: ver `lastBoundsKey`.
    const key = markers.map((m) => `${m.latitude},${m.longitude}`).join('|');
    if (key === this.lastBoundsKey) return;
    this.lastBoundsKey = key;

    const bounds = L.latLngBounds(markers.map((m) => [m.latitude, m.longitude] as L.LatLngTuple));
    this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
  }
}
