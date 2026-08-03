import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AccountsService } from '../../core/api/accounts.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Account } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';
import { Map, MapMarker } from '../../shared/map/map';
import { MapLegend, MapLegendItem } from '../../shared/map/map-legend';

type FiltroOpera = 'TODOS' | 'CPS' | 'ORGANIZATION';

/** Saca acentos y mayúsculas: "cordoba" tiene que encontrar "Córdoba". */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * TABLERO DE BARRIOS. Reemplaza a la grilla de tarjetas sin buscador ni filtro
 * que había acá.
 *
 * El cambio de fondo: desde que el tablero de CLIENTES dejó de mostrar barrios
 * (se amontonaban con el pin de su propio cliente), esta es la ÚNICA pantalla
 * que ubica un barrio en el mapa. Y CPS ve los de TODOS los clientes
 * mezclados — sin un filtro por cliente, la lista es ilegible pasados 3 o 4.
 *
 * Mismo patrón que `/clientes`: mapa + lista + panel, una sola selección, y el
 * filtrado recorta las dos vistas a la vez.
 */
@Component({
  selector: 'app-neighborhood-list',
  imports: [RouterLink, FormsModule, Map, MapLegend],
  templateUrl: './neighborhood-list.html',
})
export class NeighborhoodList {
  private readonly neighborhoods = inject(NeighborhoodsService);
  private readonly accountsApi = inject(AccountsService);
  protected readonly auth = inject(AuthService);

  protected readonly items = signal<Neighborhood[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  /**
   * Los clientes para el combo de filtro. Solo tiene sentido para CPS: una
   * organización ve nada más que sus propios barrios, así que un filtro "por
   * cliente" sobre una lista de un solo cliente no aporta nada.
   */
  protected readonly clientesFiltro = signal<Account[]>([]);

  protected readonly busqueda = signal('');
  protected readonly filtroCliente = signal<number | null>(null);
  protected readonly filtroOpera = signal<FiltroOpera>('TODOS');

  protected readonly seleccion = signal<{ id: number } | null>(null);
  protected readonly foco = signal<{ latitude: number; longitude: number; zoom?: number } | null>(
    null,
  );
  protected readonly refit = signal(0);

  constructor() {
    this.load();

    if (this.auth.isCps()) {
      this.accountsApi.list().subscribe({
        next: (clientes) => this.clientesFiltro.set(clientes),
        // Sin el combo, el filtro por cliente queda oculto: no vale la pena
        // bloquear la pantalla entera por un catálogo de conveniencia.
        error: () => this.clientesFiltro.set([]),
      });
    }
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);

    this.neighborhoods.list().subscribe({
      next: (items) => {
        this.items.set(items);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected verTodo(): void {
    this.seleccion.set(null);
    this.foco.set(null);
    this.refit.update((v) => v + 1);
  }

  /** El recorte, UNO SOLO para el mapa y la lista. */
  protected readonly visibles = computed(() => {
    const termino = normalizar(this.busqueda().trim());
    const cliente = this.filtroCliente();
    const opera = this.filtroOpera();

    return this.items().filter((b) => {
      if (cliente !== null && b.organizationId !== cliente) return false;
      if (opera !== 'TODOS' && b.managedBy !== opera) return false;
      if (!termino) return true;

      return (
        normalizar(b.name).includes(termino) ||
        normalizar(b.locality.name).includes(termino) ||
        normalizar(b.organization.name).includes(termino)
      );
    });
  });

  protected readonly hayFiltros = computed(
    () =>
      this.busqueda().trim() !== '' ||
      this.filtroCliente() !== null ||
      this.filtroOpera() !== 'TODOS',
  );

  protected limpiarFiltros(): void {
    this.busqueda.set('');
    this.filtroCliente.set(null);
    this.filtroOpera.set('TODOS');
  }

  protected readonly leyenda = computed<MapLegendItem[]>(() => [
    { variant: 'neighborhood' as const, count: this.visibles().length },
  ]);

  protected readonly marcadores = computed<MapMarker[]>(() => {
    const elegido = this.seleccion();

    return this.visibles().map((barrio) => ({
      id: `barrio:${barrio.id}`,
      latitude: barrio.latitude,
      longitude: barrio.longitude,
      label: `${barrio.name} — ${barrio.organization.name}`,
      variant: 'neighborhood' as const,
      selected: elegido?.id === barrio.id,
    }));
  });

  protected readonly barrioElegido = computed<Neighborhood | null>(() => {
    const sel = this.seleccion();
    if (!sel) return null;
    return this.items().find((b) => b.id === sel.id) ?? null;
  });

  protected elegir(barrio: Neighborhood): void {
    if (this.seleccion()?.id === barrio.id) {
      this.seleccion.set(null);
      return;
    }
    this.seleccion.set({ id: barrio.id });
    // Zoom 17 y no 14: el estilo CARTO Voyager recién dibuja la trama de
    // calles residenciales (no solo avenidas) a partir de ahí. A 14 el mapa se
    // ve "vacío" — no falta ningún dato, es el umbral del propio estilo.
    this.foco.set({ latitude: barrio.latitude, longitude: barrio.longitude, zoom: 17 });
  }

  protected onMarcador(marcador: MapMarker): void {
    const id = Number((marcador.id ?? '').split(':')[1]);
    const barrio = this.items().find((b) => b.id === id);
    if (barrio) this.elegir(barrio);
  }
}
