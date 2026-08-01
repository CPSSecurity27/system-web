import { Component, computed, input } from '@angular/core';

export type AlertVariant = 'error' | 'warning' | 'success' | 'info';

/**
 * Tono e ícono de cada variante, en UN lugar. Antes había 8 combinaciones de
 * clase distintas repartidas en 37 instancias para decir estas 4 cosas.
 */
const TONE: Record<AlertVariant, { classes: string; icon: string }> = {
  error: { classes: 'bg-brand-soft text-brand', icon: 'bi-exclamation-triangle-fill' },
  warning: { classes: 'bg-warning-soft', icon: 'bi-exclamation-circle' },
  success: { classes: 'bg-success-soft text-success', icon: 'bi-check-circle' },
  info: { classes: 'bg-light text-muted', icon: 'bi-info-circle' },
};

@Component({
  selector: 'cps-alert',
  template: `
    <div
      class="alert border-0 {{ tone().classes }}"
      [class.py-2]="dense()"
      [class.small]="dense()"
      role="alert"
    >
      <i class="bi me-1" [class]="tone().icon"></i><ng-content />
    </div>
  `,
})
export class Alert {
  readonly variant = input<AlertVariant>('info');
  /** Compacto: para avisos al pie de un formulario, no para el error de la pantalla. */
  readonly dense = input(false);

  protected readonly tone = computed(() => TONE[this.variant()]);
}
