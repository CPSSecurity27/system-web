import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';

import { DevicesService } from '../../core/api/devices.service';
import { HomesService } from '../../core/api/homes.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { RemotesService } from '../../core/api/remotes.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Device, HomeMember, Remote, RemoteStatus } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';
import { Alert } from '../../shared/ui/alert/alert';
import { Async } from '../../shared/ui/async/async';
import { PageHeader } from '../../shared/ui/page-header/page-header';
import { Paginator } from '../../shared/ui/paginator/paginator';
import { Status } from '../../shared/ui/status/status';

const PAGE_SIZE = 50;

/**
 * Los controles ENTREGADOS: qué llavero tiene cada familia y quién lo lleva.
 *
 * ## Por qué es una tabla paginada y no las tarjetas de antes
 *
 * Una alarma puede llevar entre 10 y 120 controles, un barrio tiene ~10 alarmas
 * y una municipal ~10 barrios: la pantalla tiene que aguantar ~12.000 llaveros.
 * Las tarjetas de dos columnas eran una pared por la que había que scrollear
 * para encontrar a alguien, y el listado se bajaba TODO de una junto con todas
 * las viviendas para traducir `homeId -> dirección`.
 *
 * Acá filtra y pagina el servidor. El orden (barrio -> dirección -> serial) lo
 * pone el backend para que los controles de una misma casa caigan juntos: es la
 * lectura agrupada sin pagar el precio de un acordeón de 1200 filas.
 *
 * ## Lo que esta pantalla ya NO hace
 *
 * Los códigos RF se cargan al FABRICAR y se revelan en la fábrica (solo CPS).
 * Acá no se muestran ni se editan: el operador que busca un llavero no necesita
 * el número que tiene grabado adentro.
 *
 * El stock tampoco sale: tiene su pantalla (`/inventario/controles`) y sus
 * filas no tienen barrio, cliente ni portador — o sea nada de lo que se filtra.
 */
@Component({
  selector: 'app-remote-list',
  imports: [RouterLink, FormsModule, Alert, Async, PageHeader, Paginator, Status],
  templateUrl: './remote-list.html',
})
export class RemoteList {
  private readonly remotes = inject(RemotesService);
  private readonly homes = inject(HomesService);
  private readonly neighborhoods = inject(NeighborhoodsService);
  private readonly devices = inject(DevicesService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly auth = inject(AuthService);

  protected readonly items = signal<Remote[]>([]);
  protected readonly total = signal(0);
  protected readonly offset = signal(0);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly pageSize = PAGE_SIZE;

  // ── Filtros ────────────────────────────────────────────────────────
  // Son signals y no campos sueltos porque de ellos cuelgan computeds (los
  // barrios del cliente elegido): el front es zoneless y un computed que lee un
  // campo plano no se entera nunca de que cambió.

  protected readonly barrios = signal<Neighborhood[]>([]);
  protected readonly alarmas = signal<Device[]>([]);

  protected readonly fCliente = signal<number | null>(null);
  protected readonly fBarrio = signal<number | null>(null);
  protected readonly fAlarma = signal<number | null>(null);
  protected readonly fEstado = signal<RemoteStatus | ''>('');

  /** Signal y no campo plano: `hayFiltros` lo lee y el front es zoneless. */
  protected readonly search = signal('');
  /** El tipeo no dispara un request por tecla: se espera medio segundo. */
  private readonly searchInput = new Subject<string>();

  /**
   * Filtro por VIVIENDA: no tiene selector, entra por `?homeId=` desde la ficha
   * del hogar. Se muestra como chip para que se entienda por qué la lista está
   * recortada, y se saca de ahí mismo.
   */
  protected readonly fCasa = signal<number | null>(null);
  protected readonly casaNombre = signal<string | null>(null);

  /**
   * Los clientes salen de los BARRIOS y no de la lista de cuentas: un cliente
   * sin barrios no puede tener un control entregado. Mismo criterio que Asignar.
   */
  protected readonly clientes = computed(() => {
    const vistos = new Map<number, { id: number; name: string }>();
    for (const b of this.barrios()) {
      if (b.organization) {
        vistos.set(b.organization.id, { id: b.organization.id, name: b.organization.name });
      }
    }
    return [...vistos.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  protected readonly barriosDelCliente = computed(() => {
    const cliente = this.fCliente();
    const todos = this.barrios();
    return cliente === null ? todos : todos.filter((b) => b.organizationId === cliente);
  });

  /** Con un solo cliente a la vista (una organización) el selector no aporta. */
  protected readonly muestraCliente = computed(() => this.clientes().length > 1);

  protected readonly hayFiltros = computed(
    () =>
      this.fCliente() !== null ||
      this.fBarrio() !== null ||
      this.fAlarma() !== null ||
      this.fCasa() !== null ||
      this.fEstado() !== '' ||
      this.search().trim() !== '',
  );

  // ── Acciones por fila ──────────────────────────────────────────────

  /** La fila desplegada, si hay alguna. Una sola a la vez. */
  protected readonly abierto = signal<number | null>(null);
  protected readonly miembros = signal<HomeMember[]>([]);
  protected readonly cargandoMiembros = signal(false);
  protected readonly portadorElegido = signal<number | ''>('');
  /** El que está esperando confirmación de devolución. */
  protected readonly devolviendo = signal<number | null>(null);

  constructor() {
    const homeId = this.route.snapshot.queryParamMap.get('homeId');
    if (homeId) {
      this.fCasa.set(Number(homeId));
      this.homes.get(Number(homeId)).subscribe({
        next: (casa) => this.casaNombre.set(casa.address),
        error: () => this.casaNombre.set(`Vivienda #${homeId}`),
      });
    }

    this.neighborhoods.list().subscribe({
      next: (bs) => this.barrios.set(bs),
      error: () => this.barrios.set([]),
    });

    this.searchInput.pipe(debounceTime(400), distinctUntilChanged()).subscribe(() => {
      this.offset.set(0);
      this.load();
    });

    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.cerrarFila();

    const q = this.search().trim();
    this.remotes
      .list({
        organizationId: this.fCliente() ?? undefined,
        neighborhoodId: this.fBarrio() ?? undefined,
        homeId: this.fCasa() ?? undefined,
        defaultDeviceId: this.fAlarma() ?? undefined,
        status: this.fEstado() === '' ? undefined : (this.fEstado() as RemoteStatus),
        q: q === '' ? undefined : q,
        limit: PAGE_SIZE,
        offset: this.offset(),
      })
      .subscribe({
        next: (page) => {
          this.items.set(page.items);
          this.total.set(page.total);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.loading.set(false);
        },
      });
  }

  /** Cualquier filtro que cambie vuelve a la primera página. */
  private recargarDesdeElPrincipio(): void {
    this.offset.set(0);
    this.load();
  }

  protected onCliente(valor: number | null): void {
    this.fCliente.set(valor);
    // El barrio elegido puede no ser de este cliente, y la alarma cuelga del
    // barrio: los dos se caen juntos.
    this.fBarrio.set(null);
    this.fAlarma.set(null);
    this.alarmas.set([]);
    this.recargarDesdeElPrincipio();
  }

  protected onBarrio(barrio: number | null): void {
    this.fBarrio.set(barrio);
    this.fAlarma.set(null);
    this.alarmas.set([]);

    // Las alarmas se listan POR BARRIO: sin barrio elegido no hay lista que
    // ofrecer, y ofrecer las de todos los barrios sería un combo de miles.
    if (barrio !== null) {
      this.devices.list(barrio).subscribe({
        next: (ds) => this.alarmas.set(ds),
        error: () => this.alarmas.set([]),
      });
    }

    this.recargarDesdeElPrincipio();
  }

  protected onAlarma(valor: number | null): void {
    this.fAlarma.set(valor);
    this.recargarDesdeElPrincipio();
  }

  protected onEstado(valor: string): void {
    this.fEstado.set(valor as RemoteStatus | '');
    this.recargarDesdeElPrincipio();
  }

  protected onSearch(valor: string): void {
    this.search.set(valor);
    this.searchInput.next(valor.trim());
  }

  /** Saca el filtro de vivienda que vino por la URL. */
  protected quitarCasa(): void {
    this.fCasa.set(null);
    this.casaNombre.set(null);
    void this.router.navigate([], { queryParams: {} });
    this.recargarDesdeElPrincipio();
  }

  protected limpiarFiltros(): void {
    this.fCliente.set(null);
    this.fBarrio.set(null);
    this.fAlarma.set(null);
    this.fCasa.set(null);
    this.casaNombre.set(null);
    this.fEstado.set('');
    this.search.set('');
    this.alarmas.set([]);
    void this.router.navigate([], { queryParams: {} });
    this.recargarDesdeElPrincipio();
  }

  protected prev(): void {
    if (this.offset() === 0) return;
    this.offset.set(Math.max(0, this.offset() - PAGE_SIZE));
    this.load();
  }

  protected next(): void {
    if (this.offset() + this.items().length >= this.total()) return;
    this.offset.set(this.offset() + PAGE_SIZE);
    this.load();
  }

  // ── La fila desplegada ─────────────────────────────────────────────

  /**
   * Abre las acciones de un control y carga los candidatos a portador.
   *
   * Los miembros se piden recién acá y no con la lista: son 50 filas por
   * página y pedir los miembros de las 50 viviendas sería pagar por adelantado
   * un dato que se usa en una.
   */
  protected abrir(remote: Remote): void {
    if (this.abierto() === remote.id) {
      this.cerrarFila();
      return;
    }

    this.abierto.set(remote.id);
    this.devolviendo.set(null);
    this.portadorElegido.set(remote.assignedToUserId ?? '');
    this.miembros.set([]);

    if (remote.homeId === null) return;

    this.cargandoMiembros.set(true);
    this.homes.members(remote.homeId).subscribe({
      next: (ms) => {
        this.miembros.set(ms.filter((m) => m.status === 'ACTIVE'));
        this.cargandoMiembros.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.cargandoMiembros.set(false);
      },
    });
  }

  protected cerrarFila(): void {
    this.abierto.set(null);
    this.miembros.set([]);
    this.portadorElegido.set('');
    this.devolviendo.set(null);
  }

  /**
   * Reasigna el PORTADOR ('' = queda en la casa, sin portador).
   *
   * El dueño es la vivienda y eso no se toca: acá solo cambia quién lo lleva
   * encima. El backend exige que el elegido sea miembro de ESE hogar.
   */
  protected guardarPortador(remote: Remote): void {
    if (this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    const elegido = this.portadorElegido();
    this.remotes.reassign(remote.id, elegido === '' ? null : Number(elegido)).subscribe({
      next: () => {
        this.saving.set(false);
        this.load();
      },
      error: (err) => {
        // 400: el elegido no es miembro del hogar.
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  protected pedirDevolucion(remote: Remote): void {
    this.devolviendo.set(remote.id);
  }

  protected cancelarDevolucion(): void {
    this.devolviendo.set(null);
  }

  /**
   * DEVOLVER al stock: la familia entregó el control.
   *
   * La ENTREGA no se hace acá: elegir cliente, barrio, casa y vecino son cuatro
   * decisiones encadenadas y tienen su propia pantalla (`/controles/asignar`).
   *
   * Ojo con lo que devolver NO hace: sus códigos siguen grabados en los paneles
   * del barrio, así que hasta que exista la sincronización de la base RF el
   * llavero devuelto sigue disparando la alarma de esa gente.
   */
  protected devolver(remote: Remote): void {
    if (this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    this.remotes.devolver(remote.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.load();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
        this.devolviendo.set(null);
      },
    });
  }

  // ── Lectura de una fila ────────────────────────────────────────────

  protected direccion(remote: Remote): string {
    return remote.home?.address ?? `Vivienda #${remote.homeId}`;
  }

  protected barrioDe(remote: Remote): string {
    return remote.home?.neighborhood?.name ?? '—';
  }

  protected clienteDe(remote: Remote): string {
    return remote.home?.neighborhood?.organization?.name ?? '—';
  }
}
