import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { DevicesService } from '../../core/api/devices.service';
import { HomesService } from '../../core/api/homes.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Device } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';
import { Map } from '../../shared/map/map';

@Component({
  selector: 'app-home-form',
  imports: [ReactiveFormsModule, RouterLink, Map],
  template: `
    <div class="d-flex align-items-center mb-3">
      <a routerLink="/viviendas" class="btn btn-sm btn-outline-secondary me-2" title="Volver">
        <i class="bi bi-arrow-left"></i>
      </a>
      <h2 class="h5 fw-bold mb-0">Nueva vivienda</h2>
    </div>

    <div class="row">
      <div class="col-12 col-lg-6">
        <div class="card border">
          <div class="card-body">
            <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
              <div class="mb-3">
                <label for="name" class="form-label small fw-medium">Nombre</label>
                <input id="name" type="text" class="form-control" formControlName="name" />
              </div>

              <div class="mb-3">
                <label for="neighborhoodId" class="form-label small fw-medium">Barrio</label>
                <!-- El combo ya viene filtrado: un municipio solo ve los suyos. -->
                <select id="neighborhoodId" class="form-select" formControlName="neighborhoodId">
                  <option [ngValue]="null">Elegí un barrio…</option>
                  @for (barrio of barrios(); track barrio.id) {
                    <option [ngValue]="barrio.id">{{ barrio.name }}</option>
                  }
                </select>
              </div>

              <div class="mb-3">
                <label for="address" class="form-label small fw-medium">
                  Dirección <span class="text-muted fw-normal">(opcional)</span>
                </label>
                <input id="address" type="text" class="form-control" formControlName="address" />
              </div>

              <div class="mb-3">
                <label for="contactPhone" class="form-label small fw-medium">
                  Teléfono del hogar <span class="text-muted fw-normal">(opcional)</span>
                </label>
                <input
                  id="contactPhone"
                  type="tel"
                  class="form-control"
                  formControlName="contactPhone"
                />
                <!-- Es DEL HOGAR: sobrevive a los cambios de titular. -->
                <div class="form-text">
                  Es de la casa, no del titular: si cambia el titular, este teléfono queda.
                </div>
              </div>

              <div class="mb-3">
                <label for="defaultDeviceId" class="form-label small fw-medium">
                  Alarma preferida <span class="text-muted fw-normal">(opcional)</span>
                </label>
                <select id="defaultDeviceId" class="form-select" formControlName="defaultDeviceId">
                  <option [ngValue]="null">Sin preferencia</option>
                  @for (device of devicesOfBarrio(); track device.id) {
                    <option [ngValue]="device.id">
                      {{ device.name ?? device.serial }} — {{ device.serial }}
                    </option>
                  }
                </select>
                <div class="form-text">
                  La alarma del barrio que responde primero por esta casa. Elegí el barrio antes.
                </div>
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
                    Guardando…
                  } @else {
                    Crear vivienda
                  }
                </button>
                <a routerLink="/viviendas" class="btn btn-outline-secondary">Cancelar</a>
              </div>
            </form>

            <!-- v2: sin cuentas HOME ni contratos por vivienda. El paso 2 son los MIEMBROS. -->
            <p class="text-muted small mb-0 mt-3 border-top pt-3">
              <i class="bi bi-info-circle me-1"></i>
              Después de crearla, cargá a sus <strong>miembros</strong> (un titular y sus
              familiares) desde la ficha de la vivienda.
            </p>
          </div>
        </div>
      </div>

      <div class="col-12 col-lg-6">
        <div class="card border">
          <div class="card-header bg-white border-bottom">
            <span class="fw-semibold small">
              <i class="bi bi-geo-alt me-1"></i> Ubicación
              <span class="text-muted fw-normal">(opcional)</span>
            </span>
          </div>
          <div class="card-body">
            <!-- Nadie tipea coordenadas: se clickea el mapa y listo. -->
            <p class="text-muted small mb-2">Hacé click en el mapa para marcar la casa.</p>
            <app-map [clickable]="true" (positionChange)="setPosition($event)" />
            @if (latitude() !== null) {
              <p class="small mb-0 mt-2">
                <i class="bi bi-check-circle text-success me-1"></i>
                <span class="font-monospace">{{ latitude() }}, {{ longitude() }}</span>
                <button
                  type="button"
                  class="btn btn-link btn-sm p-0 ms-2 align-baseline"
                  (click)="clearPosition()"
                >
                  Quitar
                </button>
              </p>
            }
          </div>
        </div>
      </div>
    </div>
  `,
})
export class HomeForm {
  private readonly homes = inject(HomesService);
  private readonly neighborhoods = inject(NeighborhoodsService);
  private readonly devices = inject(DevicesService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  protected readonly barrios = signal<Neighborhood[]>([]);
  protected readonly devicesOfBarrio = signal<Device[]>([]);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Ubicación elegida clickeando el mapa (opcional). */
  protected readonly latitude = signal<number | null>(null);
  protected readonly longitude = signal<number | null>(null);

  protected readonly form = this.fb.group({
    name: ['', Validators.required],
    neighborhoodId: [null as number | null, Validators.required],
    address: [''],
    contactPhone: [''],
    defaultDeviceId: [null as number | null],
  });

  constructor() {
    this.neighborhoods.list().subscribe({
      next: (barrios) => this.barrios.set(barrios),
      error: (err) => this.error.set(apiErrorMessage(err)),
    });

    // La alarma preferida tiene que ser DEL MISMO BARRIO: el combo se recarga.
    this.form.controls.neighborhoodId.valueChanges.subscribe((neighborhoodId) => {
      this.form.controls.defaultDeviceId.setValue(null);
      this.devicesOfBarrio.set([]);
      if (neighborhoodId) {
        this.devices.list(neighborhoodId).subscribe({
          next: (devices) => this.devicesOfBarrio.set(devices),
          error: () => this.devicesOfBarrio.set([]),
        });
      }
    });
  }

  protected setPosition(position: { latitude: number; longitude: number }): void {
    this.latitude.set(position.latitude);
    this.longitude.set(position.longitude);
  }

  protected clearPosition(): void {
    this.latitude.set(null);
    this.longitude.set(null);
  }

  protected submit(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const { name, neighborhoodId, address, contactPhone, defaultDeviceId } =
      this.form.getRawValue();

    this.saving.set(true);
    this.error.set(null);

    this.homes
      .create({
        name: name as string,
        neighborhoodId: neighborhoodId as number,
        address: address?.trim() ? address.trim() : undefined,
        contactPhone: contactPhone?.trim() ? contactPhone.trim() : undefined,
        defaultDeviceId: defaultDeviceId ?? undefined,
        latitude: this.latitude() ?? undefined,
        longitude: this.longitude() ?? undefined,
      })
      .subscribe({
        next: (home) => void this.router.navigate(['/viviendas', home.id]),
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }
}
