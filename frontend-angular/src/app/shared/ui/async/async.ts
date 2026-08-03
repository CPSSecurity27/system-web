import { Component, input } from '@angular/core';

/**
 * Los tres estados de una pantalla que trae datos: cargando, vacío, con datos.
 * Estaban copiados a mano en 26 y 21 archivos respectivamente.
 *
 * CARGANDO GANA SOBRE VACÍO a propósito: mientras carga, la lista está vacía y
 * decir "no hay nada" sería mentir por un instante en cada request.
 */
@Component({
  selector: 'cps-async',
  template: `
    @if (loading()) {
      <div class="text-center text-muted py-5">
        <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
        {{ loadingText() }}
      </div>
    } @else if (empty()) {
      <div class="text-center text-muted py-5 bg-light rounded">
        <i class="d-block mb-2" [class]="emptyIcon()" style="font-size: 2rem"></i>
        {{ emptyText() }}
      </div>
    } @else {
      <ng-content />
    }
  `,
})
export class Async {
  readonly loading = input(false);
  readonly empty = input(false);
  readonly loadingText = input('Cargando…');
  readonly emptyText = input('No hay nada para mostrar.');
  readonly emptyIcon = input('icon-inbox');
}
