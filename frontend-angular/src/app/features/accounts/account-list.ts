import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AccountsService, MapAccount } from '../../core/api/accounts.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { OrgSubtype } from '../../core/models/api.models';
import { Map } from '../../shared/map/map';
import { MapLegend } from '../../shared/map/map-legend';
import type { MapLegendItem } from '../../shared/map/map-legend';
import type { MapMarker } from '../../shared/map/map';

/**
 * Qué cliente está elegido. UNA sola selección para las tres piezas: mapa,
 * lista y panel. Si cada una tuviera la suya, esto serían tres widgets
 * apilados en vez de una herramienta.
 *
 * Solo hay clientes: esta pantalla es de municipalidades y comunitarias. Los
 * barrios viven en `/barrios` y en la ficha de su cliente.
 */
type Seleccion = { id: number } | null;

type FiltroTipo = 'TODOS' | OrgSubtype;

/** Saca acentos y mayúsculas: "cordoba" tiene que encontrar "Córdoba". */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * TABLERO DE CLIENTES. Reemplaza a la tabla de cupos que había acá.
 *
 * El cambio de fondo: una plataforma de seguridad territorial se opera mirando
 * DÓNDE está cada cliente, no cuántos administradores tiene de cupo. La tabla
 * vieja mostraba seis columnas de números y ninguna de ubicación.
 *
 * Tres piezas, una selección:
 *   - el MAPA ubica y deja clickear;
 *   - el BUSCADOR y los filtros recortan (y recortan el mapa también, no solo
 *     la lista: lo que sacaste de una tiene que desaparecer de la otra);
 *   - la LISTA da el detalle y el acceso a la ficha.
 *
 * El filtrado es en memoria y no contra el backend a propósito: el universo son
 * las organizaciones cliente (decenas, no miles) y ya vienen todas en el mismo
 * GET que alimenta el mapa. Pedirle al servidor cada tecla agregaría latencia
 * sin ahorrar nada.
 */
@Component({
  selector: 'app-account-list',
  imports: [RouterLink, FormsModule, Map, MapLegend],
  templateUrl: './account-list.html',
})
export class AccountList {
  private readonly accounts = inject(AccountsService);

  protected readonly clientes = signal<MapAccount[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly busqueda = signal('');
  protected readonly filtroTipo = signal<FiltroTipo>('TODOS');
  protected readonly filtroProvincia = signal('');

  protected readonly seleccion = signal<Seleccion>(null);

  /**
   * A dónde vuela el mapa. Con `zoom` explícito: en esta distribución el mapa
   * es CHICO y acompaña a la lista, así que al elegir algo se acerca de verdad
   * — sin eso, sobre un mapa de 320px no se distinguiría a cuál de los pines le
   * apareció el anillo.
   */
  protected readonly foco = signal<{
    latitude: number;
    longitude: number;
    zoom?: number;
  } | null>(null);

  /** Contador de "ver todo": devuelve el mapa a la vista general. */
  protected readonly refit = signal(0);

  protected verTodo(): void {
    this.seleccion.set(null);
    this.foco.set(null);
    this.refit.update((v) => v + 1);
  }

  constructor() {
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.accounts.forMap().subscribe({
      next: (clientes) => {
        this.clientes.set(clientes);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected reintentar(): void {
    this.error.set(null);
    this.load();
  }

  /** Las provincias que REALMENTE tienen clientes: un combo con las 24 sería ruido. */
  protected readonly provincias = computed(() =>
    [...new Set(this.clientes().map((c) => c.provinceName).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'es'),
    ),
  );

  /**
   * El recorte, UNO SOLO para el mapa y la lista.
   *
   * La búsqueda mira también el nombre de los BARRIOS: quien busca "Los
   * Lapachos" no tiene por qué saber de qué consorcio es, y que el cliente
   * aparezca es exactamente lo que necesita.
   */
  protected readonly visibles = computed(() => {
    const termino = normalizar(this.busqueda().trim());
    const tipo = this.filtroTipo();
    const provincia = this.filtroProvincia();

    return this.clientes().filter((c) => {
      if (tipo !== 'TODOS' && c.subtype !== tipo) return false;
      if (provincia && c.provinceName !== provincia) return false;
      if (!termino) return true;

      return (
        normalizar(c.name).includes(termino) ||
        normalizar(c.jurisdiction).includes(termino) ||
        c.neighborhoods.some((b) => normalizar(b.name).includes(termino))
      );
    });
  });

  protected readonly hayFiltros = computed(
    () => this.busqueda().trim() !== '' || this.filtroTipo() !== 'TODOS' || this.filtroProvincia() !== '',
  );

  protected limpiarFiltros(): void {
    this.busqueda.set('');
    this.filtroTipo.set('TODOS');
    this.filtroProvincia.set('');
  }

  protected readonly leyenda = computed<MapLegendItem[]>(() => [
    {
      variant: 'municipal' as const,
      count: this.visibles().filter((c) => c.subtype === 'MUNICIPAL').length,
    },
    {
      variant: 'community' as const,
      count: this.visibles().filter((c) => c.subtype === 'COMMUNITY').length,
    },
  ]);

  /**
   * Los pines: SOLO CLIENTES.
   *
   * Los barrios salieron del mapa a propósito. Se amontonaban con el pin de su
   * propio cliente —una comunitaria y su único barrio están literalmente en el
   * mismo punto— y en una muni con varios barrios el cliente quedaba tapado por
   * sus hijos. El barrio se ve en la lista y tiene su propio mapa en su ficha;
   * acá lo que se busca es DÓNDE está cada cliente.
   *
   * Salen de `visibles()`, así que un filtro vacía el mapa igual que vacía la
   * lista — que es todo el punto de tener una sola selección.
   */
  protected readonly marcadores = computed<MapMarker[]>(() => {
    const elegido = this.clienteElegido();

    return this.visibles().map((cliente) => ({
      id: `cliente:${cliente.id}`,
      latitude: cliente.latitude,
      longitude: cliente.longitude,
      label: cliente.name,
      variant: cliente.subtype === 'MUNICIPAL' ? ('municipal' as const) : ('community' as const),
      // Elegir un BARRIO marca el pin de su cliente: es el único que lo
      // representa en este mapa, así que el mapa y la lista siguen coincidiendo.
      selected: elegido?.id === cliente.id,
    }));
  });

  protected readonly clienteElegido = computed<MapAccount | null>(() => {
    const sel = this.seleccion();
    if (!sel) return null;
    return this.clientes().find((c) => c.id === sel.id) ?? null;
  });

  protected elegirCliente(cliente: MapAccount): void {
    // Volver a clickear lo mismo deselecciona: es la forma de cerrar el panel
    // sin ir a buscar una X.
    if (this.seleccion()?.id === cliente.id) {
      this.seleccion.set(null);
      return;
    }
    this.seleccion.set({ id: cliente.id });
    this.foco.set({ latitude: cliente.latitude, longitude: cliente.longitude, zoom: 12 });
  }

  /**
   * Click en un PIN. Resuelve contra el mismo estado que la lista, así el mapa
   * y la lista nunca pueden quedar mostrando cosas distintas.
   *
   * No mueve el foco: ya estás mirando el pin que clickeaste, y volar hacia él
   * sería moverle el mapa a alguien que no lo pidió.
   */
  protected onMarcador(marcador: MapMarker): void {
    const id = Number((marcador.id ?? '').split(':')[1]);
    if (id) this.seleccion.set({ id });
  }

  protected estaElegido(cliente: MapAccount): boolean {
    return this.clienteElegido()?.id === cliente.id;
  }
}
