import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { HomesService } from '../../core/api/homes.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { RemotesService } from '../../core/api/remotes.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Home, HomeMember, Remote } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';

/**
 * Asignar un control: municipio → barrio → casa → vecino → control.
 *
 * ## Por qué el destino va ANTES que el control
 *
 * No es un capricho de orden: **qué controles se pueden asignar depende del
 * destino**. Una organización solo puede entregar los de su propio stock, y esa
 * regla la impone el backend contra el barrio de la vivienda. Preguntar primero
 * el control obligaría a mostrar una lista que después se achica sola, o a
 * rechazar la elección al final.
 *
 * Para una organización el primer paso no existe: sus barrios son los únicos
 * que ve, así que el municipio se resuelve solo.
 *
 * ## El vecino es obligatorio
 *
 * El modelo admite un control "en el cajón de la casa" (sin portador) y así
 * queda si después se lo sacan. Pero al ENTREGAR se exige nombre: el `dni` del
 * portador es lo que viaja en la alarma cuando alguien aprieta el botón, y un
 * control entregado sin nombre es un evento que después no se le puede atribuir
 * a nadie.
 *
 * ## Lo que esto todavía no hace
 *
 * Asignar **no carga los códigos en las alarmas del barrio**. Mientras no exista
 * la sincronización de la base RF, el vecino se lleva un llavero que el panel
 * no conoce — y un código que el panel no tiene no dispara nada. La pantalla lo
 * dice al confirmar en vez de dejar que alguien lo suponga.
 */
@Component({
  selector: 'app-remote-assign',
  imports: [FormsModule, RouterLink],
  templateUrl: './remote-assign.html',
})
export class RemoteAssign {
  private readonly remotes = inject(RemotesService);
  private readonly homesService = inject(HomesService);
  private readonly neighborhoods = inject(NeighborhoodsService);
  private readonly router = inject(Router);
  protected readonly auth = inject(AuthService);

  protected readonly barrios = signal<Neighborhood[]>([]);
  protected readonly casas = signal<Home[]>([]);
  protected readonly miembros = signal<HomeMember[]>([]);
  protected readonly stock = signal<Remote[]>([]);

  protected readonly orgId = signal<number | null>(null);
  protected readonly barrioId = signal<number | null>(null);
  protected readonly casaId = signal<number | null>(null);
  protected readonly vecinoId = signal<number | null>(null);
  protected readonly controlId = signal<number | null>(null);

  protected readonly cargando = signal(true);
  protected readonly guardando = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly aviso = signal<string | null>(null);

  constructor() {
    this.neighborhoods.list().subscribe({
      next: (bs) => {
        this.barrios.set(bs);
        // Una sola organización a la vista: es la propia. El paso no aporta.
        const orgs = this.organizaciones();
        if (orgs.length === 1) this.orgId.set(orgs[0].id);
        this.cargando.set(false);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.cargando.set(false);
      },
    });

    this.remotes.inventory().subscribe({
      next: (s) => this.stock.set(s),
      error: () => this.stock.set([]),
    });
  }

  /**
   * Los clientes salen de los BARRIOS, no de la lista de cuentas.
   *
   * Un cliente sin barrios no puede recibir un control —no hay vivienda donde
   * ponerlo— así que ofrecerlo sería llevar a un callejón sin salida.
   */
  protected readonly organizaciones = computed(() => {
    const vistas = new Map<number, { id: number; name: string }>();
    for (const b of this.barrios()) {
      if (b.organization) {
        vistas.set(b.organization.id, {
          id: b.organization.id,
          name: b.organization.name,
        });
      }
    }
    return [...vistas.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  protected readonly barriosDelCliente = computed(() =>
    this.barrios().filter((b) => b.organizationId === this.orgId()),
  );

  protected readonly vecinosActivos = computed(() =>
    this.miembros().filter((m) => m.status === 'ACTIVE'),
  );

  protected readonly casaElegida = computed(() =>
    this.casas().find((c) => c.id === this.casaId()) ?? null,
  );

  protected readonly puedeAsignar = computed(
    () =>
      this.casaId() !== null &&
      this.vecinoId() !== null &&
      this.controlId() !== null &&
      !this.guardando(),
  );

  // ── Los pasos ────────────────────────────────────────────────────

  protected elegirCliente(id: number | null): void {
    this.orgId.set(id);
    this.barrioId.set(null);
    this.casaId.set(null);
    this.vecinoId.set(null);
    this.casas.set([]);
    this.miembros.set([]);
  }

  protected elegirBarrio(id: number | null): void {
    this.barrioId.set(id);
    this.casaId.set(null);
    this.vecinoId.set(null);
    this.miembros.set([]);
    this.casas.set([]);
    if (id === null) return;

    this.homesService.list(id).subscribe({
      next: (hs) => this.casas.set(hs),
      error: (e: unknown) => this.error.set(apiErrorMessage(e)),
    });
  }

  protected elegirCasa(id: number | null): void {
    this.casaId.set(id);
    this.vecinoId.set(null);
    this.miembros.set([]);
    if (id === null) return;

    this.homesService.members(id).subscribe({
      next: (ms) => {
        this.miembros.set(ms);
        // Con un solo miembro no hay nada que elegir: es el titular.
        const activos = ms.filter((m) => m.status === 'ACTIVE');
        if (activos.length === 1) this.vecinoId.set(activos[0].userId);
      },
      error: (e: unknown) => this.error.set(apiErrorMessage(e)),
    });
  }

  // ── Confirmar ────────────────────────────────────────────────────

  protected asignar(): void {
    const casaId = this.casaId();
    const vecinoId = this.vecinoId();
    const controlId = this.controlId();
    if (!this.puedeAsignar() || !casaId || !vecinoId || !controlId) return;

    this.guardando.set(true);
    this.error.set(null);

    this.remotes.assign(controlId, casaId, vecinoId).subscribe({
      next: (control) => {
        const vecino = this.vecinosActivos().find((m) => m.userId === vecinoId);
        this.aviso.set(
          `${control.serial ?? 'El control'} quedó asignado a ${
            this.casaElegida()?.address ?? 'la vivienda'
          }, a nombre de ${vecino?.user.name ?? 'el vecino'}.`,
        );
        this.guardando.set(false);
        // Se recarga el stock y se limpia el control elegido: el recorrido
        // hasta la casa se conserva, que es lo que se repite al entregar
        // varios a la misma familia.
        this.controlId.set(null);
        this.remotes.inventory().subscribe({
          next: (s) => this.stock.set(s),
          error: () => this.stock.set([]),
        });
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.guardando.set(false);
      },
    });
  }

  protected volver(): void {
    void this.router.navigate(['/controles']);
  }
}
