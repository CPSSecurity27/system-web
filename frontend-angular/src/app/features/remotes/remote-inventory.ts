import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AccountsService } from '../../core/api/accounts.service';
import { RemotesService } from '../../core/api/remotes.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Account, Remote } from '../../core/models/api.models';

/**
 * INVENTARIO DE CONTROLES: control de stock, y nada más.
 *
 * Responde una sola pregunta —qué controles hay y de quién son— así que acá NO
 * se entrega a ninguna vivienda. Eso es trabajo de OPERAR: hay que elegir
 * municipio, barrio, casa y vecino, y ese recorrido no tiene nada que ver con
 * mirar stock. El botón de arriba lleva ahí, igual que "Instalar una alarma"
 * lleva de este inventario al trabajo de campo.
 *
 * Quedan las dos formas en que un control ENTRA a un stock, espejo de alarmas:
 *
 *   ENTREGA (solo CPS)    despacho de un lote: CPS le pasa N controles a un
 *                         cliente, típicamente antes de que lleguen físicamente.
 *   ADOPCIÓN (por código) la bolsa que alguien ya tiene en la mano: se carga el
 *                         serial y el código impresos en la etiqueta.
 *
 * Solo aparecen los que pasaron el visto bueno de fábrica: uno recién fabricado
 * todavía no tiene los códigos grabados.
 */
@Component({
  selector: 'app-remote-inventory',
  imports: [FormsModule, RouterLink],
  templateUrl: './remote-inventory.html',
})
export class RemoteInventory {
  private readonly remotes = inject(RemotesService);
  private readonly accounts = inject(AccountsService);
  protected readonly auth = inject(AuthService);

  protected readonly stock = signal<Remote[]>([]);
  protected readonly cuentas = signal<Account[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly aviso = signal<string | null>(null);
  protected readonly search = signal('');

  /** Los que van en el lote. Se marcan con el checkbox de cada fila. */
  protected readonly elegidos = signal<Set<number>>(new Set());
  protected readonly destino = signal<number | null>(null);

  /** Adopción por serial + código. */
  protected readonly adoptSerial = signal('');
  protected readonly adoptCodigo = signal('');
  protected readonly adoptando = signal(false);

  protected readonly organizaciones = computed(() =>
    this.cuentas().filter((a) => a.type === 'ORGANIZATION'),
  );

  constructor() {
    this.cargar();
    // Solo CPS entrega lotes, y es el único que necesita elegir destino.
    if (this.auth.isCps()) {
      // `list()` ya viene filtrada a ORGANIZATION del lado del servicio.
      this.accounts.list().subscribe({
        next: (cs) => this.cuentas.set(cs),
        error: () => this.cuentas.set([]),
      });
    }
  }

  private cargar(): void {
    this.loading.set(true);
    this.remotes.inventory().subscribe({
      next: (stock) => {
        this.stock.set(stock);
        this.elegidos.set(new Set());
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected readonly filtrados = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (q.length === 0) return this.stock();
    return this.stock().filter(
      (r) =>
        r.serial?.toLowerCase().includes(q) || r.name?.toLowerCase().includes(q),
    );
  });

  protected descartarAviso(): void {
    this.aviso.set(null);
  }

  // ── Selección para el lote ───────────────────────────────────────

  protected elegido(id: number): boolean {
    return this.elegidos().has(id);
  }

  protected alternar(id: number): void {
    this.elegidos.update((s) => {
      const copia = new Set(s);
      if (copia.has(id)) copia.delete(id);
      else copia.add(id);
      return copia;
    });
  }

  /** Marca o desmarca TODO lo que está a la vista, no todo el stock. */
  protected alternarTodos(): void {
    const visibles = this.filtrados().map((r) => r.id);
    const todosMarcados = visibles.every((id) => this.elegidos().has(id));
    this.elegidos.update((s) => {
      const copia = new Set(s);
      for (const id of visibles) {
        if (todosMarcados) copia.delete(id);
        else copia.add(id);
      }
      return copia;
    });
  }

  protected readonly puedeEntregar = computed(
    () => this.elegidos().size > 0 && this.destino() !== null && !this.saving(),
  );

  /**
   * Entrega el lote. Atómica del lado del servidor: o van todos o no va ninguno.
   *
   * Entregar NO es asignar: el control pasa al stock del cliente, no a una
   * vivienda. Quién lo recibe se decide después, en Operar.
   */
  protected entregarLote(): void {
    const destino = this.destino();
    if (!this.puedeEntregar() || destino === null) return;

    this.saving.set(true);
    this.error.set(null);

    const ids = [...this.elegidos()];
    this.remotes.entregarLote(ids, destino).subscribe({
      next: ({ delivered }) => {
        const cliente = this.organizaciones().find((o) => o.id === destino);
        this.aviso.set(
          `${delivered} control(es) pasaron al stock de ${
            cliente?.name ?? 'la organización'
          }. Todavía no son de ninguna vivienda: eso se hace en Operar.`,
        );
        this.saving.set(false);
        this.destino.set(null);
        this.cargar();
      },
      error: (err: unknown) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  // ── Adopción ─────────────────────────────────────────────────────

  protected readonly puedeAdoptar = computed(
    () =>
      this.adoptSerial().trim().length > 0 &&
      this.adoptCodigo().trim().length > 0 &&
      !this.adoptando(),
  );

  /** La bolsa que ya está en la mano: serial + código de la etiqueta. */
  protected adoptar(): void {
    if (!this.puedeAdoptar()) return;

    this.adoptando.set(true);
    this.error.set(null);

    this.remotes
      .adoptar(this.adoptSerial().trim(), this.adoptCodigo().trim())
      .subscribe({
        next: (control) => {
          this.aviso.set(`${control.serial} entró a tu stock.`);
          this.adoptSerial.set('');
          this.adoptCodigo.set('');
          this.adoptando.set(false);
          this.cargar();
        },
        error: (err: unknown) => {
          this.error.set(apiErrorMessage(err));
          this.adoptando.set(false);
        },
      });
  }
}
