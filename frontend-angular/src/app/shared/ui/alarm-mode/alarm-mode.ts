import { Component, computed, input } from '@angular/core';

import { alarmMode } from '../../../core/alarm-modes';

/**
 * El MOTIVO por el que sonó la alarma: incendio, médica, ladrón…
 *
 * Es el dato que el monitor necesita primero y el panel no mostraba: hasta el
 * 2026-08-02 el tablero de eventos pintaba el ORIGEN ("APP", "REMOTE"), que
 * dice por dónde entró la activación pero no qué pasa en la calle.
 *
 * Sin `code` no se dibuja nada: un evento viejo o cargado a mano desde el panel
 * puede no tener modo, y un badge vacío confunde más de lo que informa.
 */
@Component({
  selector: 'cps-alarm-mode',
  template: `
    @if (mode(); as m) {
      <span class="badge mode-badge {{ m.toneClass }}">
        <i class="me-1" [class]="m.icon"></i>{{ m.label }}
      </span>
    }
  `,
})
export class AlarmMode {
  readonly code = input<string | null | undefined>(null);

  protected readonly mode = computed(() => alarmMode(this.code()));
}
