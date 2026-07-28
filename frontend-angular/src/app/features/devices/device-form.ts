import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AccountsService } from '../../core/api/accounts.service';
import { DevicesService } from '../../core/api/devices.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Account, Device } from '../../core/models/api.models';

/**
 * FÁBRICA (solo CPS): el equipo nace en INVENTORY con un claim code. La
 * instalación en un barrio es un paso aparte (el claim, en /alarmas/stock).
 */
@Component({
  selector: 'app-device-form',
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <div class="d-flex align-items-center mb-3">
      <a routerLink="/alarmas" class="btn btn-sm btn-outline-secondary me-2" title="Volver">
        <i class="bi bi-arrow-left"></i>
      </a>
      <h2 class="h5 fw-bold mb-0">Fabricar equipo</h2>
    </div>

    <div class="row">
      <div class="col-12 col-lg-6">
        @if (created(); as device) {
          <!-- El claim code se muestra UNA vez acá: anotarlo antes de salir. -->
          <div class="card border">
            <div class="card-body text-center py-4">
              <i
                class="bi bi-check-circle-fill text-success d-block mb-2"
                style="font-size: 2rem;"
              ></i>
              <h3 class="h6 fw-bold">Equipo {{ device.serial }} en inventario</h3>
              <p class="text-muted small">
                Para instalarlo, el técnico necesita el serial y este
                <strong>código de reclamo</strong> (de un solo uso):
              </p>
              <p class="display-6 font-monospace text-brand mb-3">{{ device.claimCode }}</p>
              <div class="d-flex gap-2 justify-content-center">
                <button type="button" class="btn btn-outline-brand btn-sm" (click)="reset()">
                  <i class="bi bi-plus-lg me-1"></i> Fabricar otro
                </button>
                <a routerLink="/alarmas/stock" class="btn btn-brand btn-sm">
                  <i class="bi bi-box-seam me-1"></i> Ir al stock
                </a>
              </div>
            </div>
          </div>
        } @else {
          <div class="card border">
            <div class="card-body">
              <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
                <div class="mb-3">
                  <label for="serial" class="form-label small fw-medium">Número de serie</label>
                  <input
                    id="serial"
                    type="text"
                    class="form-control font-monospace"
                    formControlName="serial"
                    placeholder="CPS-2026-0001"
                  />
                  <!-- Letras, números, guiones (3-64): de acá se deriva la identidad MQTT. -->
                  <div class="form-text">
                    Único por equipo: letras, números y guiones. Si ya existe, se rechaza.
                  </div>
                </div>

                <div class="mb-3">
                  <label for="name" class="form-label small fw-medium">
                    Nombre <span class="text-muted fw-normal">(opcional)</span>
                  </label>
                  <input
                    id="name"
                    type="text"
                    class="form-control"
                    formControlName="name"
                    placeholder="Se puede poner al instalar"
                  />
                </div>

                <div class="mb-3">
                  <label for="organizationId" class="form-label small fw-medium">
                    Entregar al stock de <span class="text-muted fw-normal">(opcional)</span>
                  </label>
                  <select id="organizationId" class="form-select" formControlName="organizationId">
                    <option [ngValue]="null">Fábrica CPS (entregar después)</option>
                    @for (org of organizations(); track org.id) {
                      <option [ngValue]="org.id">{{ org.name }}</option>
                    }
                  </select>
                  <div class="form-text">
                    Sin destino, queda en la fábrica; la entrega del lote se hace desde el stock.
                  </div>
                </div>

                <div class="form-check mb-3">
                  <input
                    id="tested"
                    type="checkbox"
                    class="form-check-input"
                    formControlName="tested"
                  />
                  <label for="tested" class="form-check-label small">Probado en fábrica</label>
                </div>

                @if (error()) {
                  <div class="alert bg-brand-soft text-brand border-0 py-2 small" role="alert">
                    <i class="bi bi-exclamation-triangle-fill me-1"></i> {{ error() }}
                  </div>
                }

                <div class="d-flex gap-2">
                  <button type="submit" class="btn btn-brand" [disabled]="saving() || form.invalid">
                    @if (saving()) {
                      <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
                      Fabricando…
                    } @else {
                      Fabricar equipo
                    }
                  </button>
                  <a routerLink="/alarmas" class="btn btn-outline-secondary">Cancelar</a>
                </div>
              </form>

              <p class="text-muted small mb-0 mt-3 border-top pt-3">
                <i class="bi bi-info-circle me-1"></i>
                El equipo nace en <strong>inventario</strong> con un código de reclamo. La
                instalación en un barrio es el paso siguiente:
                <a routerLink="/alarmas/stock">stock e instalación</a>.
              </p>
            </div>
          </div>
        }
      </div>
    </div>
  `,
})
export class DeviceForm {
  private readonly devices = inject(DevicesService);
  private readonly accounts = inject(AccountsService);
  private readonly fb = inject(FormBuilder);

  protected readonly accountList = signal<Account[]>([]);
  protected readonly organizations = computed(() =>
    this.accountList().filter((a) => a.type === 'ORGANIZATION'),
  );
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly created = signal<Device | null>(null);

  protected readonly form = this.fb.group({
    serial: ['', [Validators.required, Validators.pattern(/^[A-Za-z0-9_-]{3,64}$/)]],
    name: [''],
    organizationId: [null as number | null],
    tested: [false],
  });

  constructor() {
    this.accounts.list().subscribe({
      next: (accounts) => this.accountList.set(accounts),
      error: () => this.accountList.set([]),
    });
  }

  protected submit(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const { serial, name, organizationId, tested } = this.form.getRawValue();

    this.saving.set(true);
    this.error.set(null);

    this.devices
      .create({
        serial: serial as string,
        name: name?.trim() ? name.trim() : undefined,
        organizationId: organizationId ?? undefined,
        tested: tested ?? undefined,
      })
      .subscribe({
        next: (device) => {
          this.saving.set(false);
          this.created.set(device);
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }

  protected reset(): void {
    this.created.set(null);
    this.form.reset({ serial: '', name: '', organizationId: null, tested: false });
  }
}
