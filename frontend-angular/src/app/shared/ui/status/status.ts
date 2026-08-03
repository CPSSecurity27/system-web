import { Component, computed, input } from '@angular/core';

import { lookOf, StatusKind } from './status-map';

@Component({
  selector: 'cps-status',
  template: `
    <span class="badge {{ look().classes }}">
      @if (look().icon) {
        <i class="me-1" [class]="look().icon"></i>
      }
      {{ look().label }}
    </span>
  `,
})
export class Status {
  readonly kind = input.required<StatusKind>();
  readonly value = input.required<string>();

  protected readonly look = computed(() => lookOf(this.kind(), this.value()));
}
