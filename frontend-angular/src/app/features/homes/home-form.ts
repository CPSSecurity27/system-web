import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { DevicesService } from '../../core/api/devices.service';
import { HomesService } from '../../core/api/homes.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Device } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';
import { Map } from '../../shared/map/map';

/** Alarma del barrio con su distancia a la casa, para sugerir la preferida. */
interface DeviceConDistancia {
  device: Device;
  metros: number | null;
}

@Component({
  selector: 'app-home-form',
  imports: [ReactiveFormsModule, RouterLink, Map],
  template: `
    <div class="d-flex align-items-center mb-3">
      <a routerLink="/viviendas" class="btn btn-sm btn-outline-secondary me-2" title="Volver">
        <i class="icon-arrow-left"></i>
      </a>
      <h2 class="h5 fw-bold mb-0">Nueva vivienda</h2>
    </div>

    <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <div class="row">
        <div class="col-12 col-lg-6">
          <div class="card border mb-3">
            <div class="card-header bg-white border-bottom">
              <span class="fw-semibold small"><i class="icon-house me-1"></i> La vivienda</span>
            </div>
            <div class="card-body">
              <div class="mb-3">
                <label for="address" class="form-label small fw-medium">Dirección</label>
                <!-- La dirección IDENTIFICA la vivienda: no hay nombre aparte. -->
                <input
                  id="address"
                  type="text"
                  class="form-control"
                  formControlName="address"
                  placeholder="Mza A Casa 5"
                />
                <div class="form-text">Así se la identifica en las listas y en el mapa.</div>
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

              <div class="mb-0">
                <label for="defaultDeviceId" class="form-label small fw-medium">
                  Alarma preferida <span class="text-muted fw-normal">(opcional)</span>
                </label>
                <select id="defaultDeviceId" class="form-select" formControlName="defaultDeviceId">
                  <option [ngValue]="null">Sin preferencia</option>
                  @for (item of alarmasCercanas(); track item.device.id) {
                    <option [ngValue]="item.device.id">
                      {{ item.device.name ?? item.device.serial }}
                      @if (item.metros !== null) {
                        — a {{ distancia(item.metros) }}
                      }
                    </option>
                  }
                </select>
                <!-- La alarma es del BARRIO: acá solo se elige cuál responde primero. -->
                <div class="form-text">
                  @if (sugerida()) {
                    Sugerida por cercanía: <strong>{{ sugerida() }}</strong
                    >. Podés cambiarla.
                  } @else {
                    La alarma del barrio que responde primero por esta casa. Elegí el barrio y marcá
                    la casa en el mapa.
                  }
                </div>
              </div>
            </div>
          </div>

          <div class="card border">
            <div class="card-header bg-white border-bottom">
              <span class="fw-semibold small"> <i class="icon-id-card me-1"></i> El titular </span>
            </div>
            <div class="card-body" formGroupName="titular">
              <!-- Una vivienda sin titular no sirve: se cargan juntos, en un acto. -->
              <p class="text-muted small mb-3">
                Con el DNI entra a la app de vecinos. La contraseña la fija él la primera vez.
              </p>

              <div class="mb-3">
                <label for="titularName" class="form-label small fw-medium">Nombre completo</label>
                <input id="titularName" type="text" class="form-control" formControlName="name" />
              </div>

              <div class="mb-3">
                <label for="titularDni" class="form-label small fw-medium">DNI</label>
                <input
                  id="titularDni"
                  type="text"
                  inputmode="numeric"
                  class="form-control"
                  formControlName="dni"
                  placeholder="30123456"
                />
                @if (dniInvalido()) {
                  <div class="form-text text-emergency">Son 7 a 9 dígitos, sin puntos.</div>
                } @else {
                  <div class="form-text">Sin puntos.</div>
                }
              </div>

              <button
                type="button"
                class="btn btn-link btn-sm p-0 mb-2"
                (click)="verOpcionales.set(!verOpcionales())"
              >
                <i
                  [class.icon-chevron-right]="!verOpcionales()"
                  [class.icon-chevron-down]="verOpcionales()"
                ></i>
                Datos opcionales
              </button>

              @if (verOpcionales()) {
                <div class="row g-2">
                  <div class="col-12 col-sm-6">
                    <label for="titularPhone" class="form-label small fw-medium">Teléfono</label>
                    <input
                      id="titularPhone"
                      type="tel"
                      class="form-control"
                      formControlName="telephone"
                    />
                  </div>
                  <div class="col-12 col-sm-6">
                    <label for="titularBirth" class="form-label small fw-medium">
                      Fecha de nacimiento
                    </label>
                    <input
                      id="titularBirth"
                      type="date"
                      class="form-control"
                      formControlName="birthDate"
                    />
                  </div>
                  <div class="col-12">
                    <label for="titularEmail" class="form-label small fw-medium">Correo</label>
                    <input
                      id="titularEmail"
                      type="email"
                      class="form-control"
                      formControlName="email"
                    />
                    <div class="form-text">
                      Si lo cargás, le llega un mail para activar la cuenta.
                    </div>
                  </div>
                </div>
              }
            </div>
          </div>
        </div>

        <div class="col-12 col-lg-6">
          <div class="card border">
            <div class="card-header bg-white border-bottom">
              <span class="fw-semibold small"><i class="icon-map-pin me-1"></i> Ubicación</span>
            </div>
            <div class="card-body">
              <!-- Nadie tipea coordenadas: se clickea el mapa y listo. -->
              <p class="text-muted small mb-2">Hacé click en el mapa para marcar la casa.</p>
              <app-map [clickable]="true" (positionChange)="setPosition($event)" />
              @if (latitude() !== null) {
                <p class="small mb-0 mt-2">
                  <i class="icon-circle-check text-success me-1"></i>
                  <span class="font-monospace">{{ latitude() }}, {{ longitude() }}</span>
                  <button
                    type="button"
                    class="btn btn-link btn-sm p-0 ms-2 align-baseline"
                    (click)="clearPosition()"
                  >
                    Quitar
                  </button>
                </p>
              } @else {
                <p class="small text-muted mb-0 mt-2">
                  <i class="icon-circle-alert me-1"></i>
                  Es obligatoria: sale en el mapa del monitoreo y en cada evento.
                </p>
              }
            </div>
          </div>
        </div>
      </div>

      @if (error()) {
        <div class="alert bg-emergency-soft text-emergency border-0 py-2 small mt-3" role="alert">
          <i class="icon-triangle-alert me-1"></i> {{ error() }}
        </div>
      }

      <div class="d-flex gap-2 mt-3">
        <button type="submit" class="btn btn-brand" [disabled]="saving() || !puedeGuardar()">
          @if (saving()) {
            <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
            Guardando…
          } @else {
            Crear vivienda con su titular
          }
        </button>
        <a routerLink="/viviendas" class="btn btn-outline-secondary">Cancelar</a>
      </div>

      <p class="text-muted small mb-0 mt-3">
        <i class="icon-info me-1"></i>
        Después podés cargar a los <strong>familiares</strong> desde la ficha de la vivienda.
      </p>
    </form>
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
  protected readonly verOpcionales = signal(false);

  /** Ubicación de la casa. OBLIGATORIA: sin esto no se puede guardar. */
  protected readonly latitude = signal<number | null>(null);
  protected readonly longitude = signal<number | null>(null);

  protected readonly form = this.fb.group({
    address: ['', Validators.required],
    neighborhoodId: [null as number | null, Validators.required],
    contactPhone: [''],
    defaultDeviceId: [null as number | null],
    titular: this.fb.group({
      name: ['', Validators.required],
      dni: ['', [Validators.required, Validators.pattern(/^\d{7,9}$/)]],
      telephone: [''],
      birthDate: [''],
      email: [''],
    }),
  });

  /**
   * Las alarmas del barrio ordenadas por cercanía a la casa. Sin punto marcado
   * quedan en el orden que vinieron: no hay contra qué medir.
   */
  protected readonly alarmasCercanas = computed<DeviceConDistancia[]>(() => {
    const lat = this.latitude();
    const lng = this.longitude();
    const items = this.devicesOfBarrio().map((device) => ({
      device,
      metros:
        lat !== null && lng !== null && device.latitude !== null && device.longitude !== null
          ? metrosEntre(lat, lng, device.latitude, device.longitude)
          : null,
    }));

    return items.sort((a, b) => (a.metros ?? Infinity) - (b.metros ?? Infinity));
  });

  /** Nombre de la alarma que se precargó sola, para explicarlo en el form. */
  protected readonly sugerida = signal<string | null>(null);

  protected readonly dniInvalido = computed(() => {
    const control = this.form.controls.titular.controls.dni;
    return control.touched && control.invalid && control.value !== '';
  });

  constructor() {
    this.neighborhoods.list().subscribe({
      next: (barrios) => this.barrios.set(barrios),
      error: (err) => this.error.set(apiErrorMessage(err)),
    });

    // La alarma preferida tiene que ser DEL MISMO BARRIO: el combo se recarga.
    this.form.controls.neighborhoodId.valueChanges.subscribe((neighborhoodId) => {
      this.form.controls.defaultDeviceId.setValue(null);
      this.sugerida.set(null);
      this.devicesOfBarrio.set([]);
      if (neighborhoodId) {
        this.devices.list(neighborhoodId).subscribe({
          next: (devices) => {
            this.devicesOfBarrio.set(devices);
            this.sugerirAlarma();
          },
          error: () => this.devicesOfBarrio.set([]),
        });
      }
    });
  }

  /** Sin GPS no hay alta: el botón lo dice antes de que el backend rebote. */
  protected puedeGuardar(): boolean {
    return this.form.valid && this.latitude() !== null && this.longitude() !== null;
  }

  protected distancia(metros: number): string {
    return metros < 1000 ? `${Math.round(metros)} m` : `${(metros / 1000).toFixed(1)} km`;
  }

  protected setPosition(position: { latitude: number; longitude: number }): void {
    this.latitude.set(position.latitude);
    this.longitude.set(position.longitude);
    this.sugerirAlarma();
  }

  protected clearPosition(): void {
    this.latitude.set(null);
    this.longitude.set(null);
    this.sugerida.set(null);
  }

  /**
   * Con la casa marcada y el barrio elegido, la alarma más cercana se precarga
   * sola. Solo si el gestor todavía no eligió una a mano: no le pisamos nada.
   */
  private sugerirAlarma(): void {
    if (this.form.controls.defaultDeviceId.value !== null) return;

    const mejor = this.alarmasCercanas()[0];
    if (!mejor || mejor.metros === null) return;

    this.form.controls.defaultDeviceId.setValue(mejor.device.id);
    this.sugerida.set(mejor.device.name ?? mejor.device.serial);
  }

  protected submit(): void {
    if (!this.puedeGuardar() || this.saving()) {
      this.form.markAllAsTouched();
      if (this.latitude() === null) {
        this.error.set('Marcá la ubicación de la vivienda en el mapa.');
      }
      return;
    }

    const { address, neighborhoodId, contactPhone, defaultDeviceId, titular } =
      this.form.getRawValue();

    this.saving.set(true);
    this.error.set(null);

    this.homes
      .create({
        address: (address as string).trim(),
        neighborhoodId: neighborhoodId as number,
        latitude: this.latitude() as number,
        longitude: this.longitude() as number,
        contactPhone: contactPhone?.trim() ? contactPhone.trim() : undefined,
        defaultDeviceId: defaultDeviceId ?? undefined,
        titular: {
          name: (titular.name as string).trim(),
          dni: (titular.dni as string).trim(),
          telephone: titular.telephone?.trim() ? titular.telephone.trim() : undefined,
          birthDate: titular.birthDate?.trim() ? titular.birthDate.trim() : undefined,
          email: titular.email?.trim() ? titular.email.trim() : undefined,
        },
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

/**
 * Distancia en metros por la fórmula del haversine. Alcanza y sobra para
 * ordenar postes dentro de un barrio, y evita traer una librería para esto.
 */
function metrosEntre(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const rad = (grados: number) => (grados * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
