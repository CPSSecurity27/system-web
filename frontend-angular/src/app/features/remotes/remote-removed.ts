import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { RemotesService } from '../../core/api/remotes.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { ResultadoBusqueda } from '../../core/models/api.models';

/**
 * Papelera de controles remotos. Espejo de la de alarmas.
 *
 * Dos acciones, las dos difíciles de deshacer:
 *
 *   Dar de alta  vuelve al stock de fábrica —no a la vivienda donde estaba— y
 *                SIN el visto bueno: pasó por acá, así que alguien tiene que
 *                mirarlo antes de que se pueda entregar.
 *   Borrar       definitivo. Se lleva los códigos, y con ellos la reserva de
 *                esos números: vuelven a quedar disponibles. Un control con
 *                EVENTOS no se puede borrar — son append-only.
 *
 * Es una pantalla aparte y no una pestaña de fábrica, por lo mismo que en
 * alarmas: en la fábrica se cargan de a decenas, acá se revisan de a uno.
 */
@Component({
  selector: 'app-remote-removed',
  imports: [DatePipe, FormsModule, RouterLink],
  templateUrl: './remote-removed.html',
})
export class RemoteRemoved {
  private readonly remotes = inject(RemotesService);

  protected readonly items = signal<ResultadoBusqueda[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly aviso = signal<string | null>(null);
  protected readonly search = signal('');

  /** Cuál está esperando confirmación de borrado, si hay alguno. */
  protected readonly confirmando = signal<number | null>(null);
  protected readonly trabajando = signal<number | null>(null);

  constructor() {
    this.cargar();
  }

  private cargar(): void {
    this.loading.set(true);
    this.remotes.removidos().subscribe({
      next: (rs) => {
        this.items.set(rs);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (q.length === 0) return this.items();
    return this.items().filter((r) => r.serial?.toLowerCase().includes(q));
  });

  protected descartarAviso(): void {
    this.aviso.set(null);
  }

  protected reactivar(control: ResultadoBusqueda): void {
    if (this.trabajando() !== null) return;
    this.trabajando.set(control.id);
    this.error.set(null);

    this.remotes.restaurar(control.id).subscribe({
      next: () => {
        this.items.update((items) => items.filter((r) => r.id !== control.id));
        this.aviso.set(
          `${control.serial} volvió al stock de fábrica SIN el visto bueno: ` +
            'hay que revisarlo y marcarlo Listo antes de poder entregarlo. Si ' +
            'estaba en una vivienda, no volvió a ella.',
        );
        this.trabajando.set(null);
      },
      error: (err: unknown) => {
        this.error.set(apiErrorMessage(err));
        this.trabajando.set(null);
      },
    });
  }

  protected pedirConfirmacion(control: ResultadoBusqueda): void {
    this.confirmando.set(control.id);
  }

  protected cancelar(): void {
    this.confirmando.set(null);
  }

  protected borrar(control: ResultadoBusqueda): void {
    if (this.trabajando() !== null) return;
    this.trabajando.set(control.id);
    this.error.set(null);

    this.remotes.borrarDefinitivo(control.id).subscribe({
      next: ({ mensaje }) => {
        this.items.update((items) => items.filter((r) => r.id !== control.id));
        this.aviso.set(
          `${mensaje} Sus códigos vuelven a estar disponibles para otro control.`,
        );
        this.confirmando.set(null);
        this.trabajando.set(null);
      },
      error: (err: unknown) => {
        this.error.set(apiErrorMessage(err));
        this.confirmando.set(null);
        this.trabajando.set(null);
      },
    });
  }
}
