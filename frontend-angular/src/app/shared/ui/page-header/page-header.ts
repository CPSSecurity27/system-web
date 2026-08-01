import { Component, input } from '@angular/core';

/**
 * El encabezado de una pantalla: título, bajada y acciones a la derecha.
 * Las 28 pantallas lo venían armando a mano, cada una con su espaciado.
 */
@Component({
  selector: 'cps-page-header',
  template: `
    <div class="d-flex align-items-center justify-content-between mb-3">
      <div>
        <h2 class="h5 fw-bold mb-0">
          @if (icon()) {
            <i class="bi text-brand me-2" [class]="icon()"></i>
          }{{ title() }}
        </h2>
        @if (subtitle()) {
          <p class="text-muted small mb-0">{{ subtitle() }}</p>
        }
      </div>
      <ng-content select="[actions]" />
    </div>
  `,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input('');
  readonly icon = input('');
}
