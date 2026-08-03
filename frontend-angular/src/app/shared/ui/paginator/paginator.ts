import { Component, computed, input, output } from '@angular/core';

/**
 * Paginación por offset, la que usa toda la API. El componente NO pagina:
 * informa y avisa. Quién carga los datos sigue siendo la pantalla.
 */
@Component({
  selector: 'cps-paginator',
  template: `
    <div class="d-flex align-items-center justify-content-between">
      <span class="text-muted small">{{ rango() }}</span>
      <div class="btn-group">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          [disabled]="!canPrev() || disabled()"
          (click)="prev.emit()"
        >
          <i class="icon-chevron-left"></i> Anteriores
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          [disabled]="!canNext() || disabled()"
          (click)="next.emit()"
        >
          Siguientes <i class="icon-chevron-right"></i>
        </button>
      </div>
    </div>
  `,
})
export class Paginator {
  /** Cuántos elementos se saltearon: el offset de la API. */
  readonly offset = input(0);
  /** Cuántos vinieron en ESTA página (no el tamaño de página). */
  readonly count = input(0);
  readonly total = input(0);
  readonly disabled = input(false);

  readonly prev = output<void>();
  readonly next = output<void>();

  protected readonly canPrev = computed(() => this.offset() > 0);
  protected readonly canNext = computed(() => this.offset() + this.count() < this.total());

  /** Base 1 para el humano. Sin resultados no se inventa un "1–0". */
  protected readonly rango = computed(() =>
    this.count() === 0
      ? `0 de ${this.total()}`
      : `${this.offset() + 1}–${this.offset() + this.count()} de ${this.total()}`,
  );
}
