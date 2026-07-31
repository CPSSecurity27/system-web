import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { debounceTime, distinctUntilChanged, switchMap } from 'rxjs';

import { AccountsService } from '../../core/api/accounts.service';
import { GeographyService } from '../../core/api/geography.service';
import { PlansService } from '../../core/api/plans.service';
import { UsersService } from '../../core/api/users.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { ManagedBy, OrgSubtype, Plan } from '../../core/models/api.models';
import { Locality } from '../../core/models/neighborhood';

/** Lo que queda para mostrar una sola vez tras crear la cuenta: la clave no se puede volver a leer. */
interface CreatedAccountResult {
  accountId: number;
  ownerUsername: string;
  temporaryPassword: string;
}

/**
 * Onboarding de un cliente (solo CPS): cuenta + cupos + OWNER institucional,
 * en un solo paso. El OWNER es un usuario SIN persona detrás (tipo cuenta
 * root): el personal municipal rota, la institución queda.
 *
 * El OWNER nace con una clave TEMPORAL generada por el backend (no la elige
 * quien completa este form): se muestra UNA sola vez acá, antes de navegar a
 * la ficha de la cuenta, y hay que cambiarla en el primer login.
 *
 * Los CUPOS salen del PLAN, que los precarga en los inputs y se puede pisar a
 * mano: el plan es una plantilla, no una jaula. Se manda igual `planId` para
 * dejar registrado con qué se vendió, aunque los números finales sean otros.
 *
 * COMMUNITY es un caso aparte: gestiona un único barrio y no tiene sentido de
 * negocio sin él, así que el form pide el barrio en el MISMO paso y todo se
 * manda junto a `onboardCommunity()` (atómico en el backend — todo o nada).
 * Ahí también se elige la MODALIDAD: llave en mano (opera CPS) o autogestión.
 * MUNICIPAL carga sus barrios después, y decide la modalidad barrio por barrio.
 */
@Component({
  selector: 'app-account-form',
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <div class="d-flex align-items-center mb-3">
      <a routerLink="/clientes" class="btn btn-sm btn-outline-secondary me-2" title="Volver">
        <i class="bi bi-arrow-left"></i>
      </a>
      <h2 class="h5 fw-bold mb-0">Nuevo cliente</h2>
    </div>

    <div class="row">
      <div class="col-12 col-lg-7">
        @if (created(); as result) {
          <div class="card border">
            <div class="card-body">
              <p class="fw-semibold text-success mb-2">
                <i class="bi bi-check-circle-fill me-1"></i> Cuenta creada
              </p>
              <p class="small text-muted">
                Clave temporal para
                <strong class="font-monospace">{{ result.ownerUsername }}</strong
                >. Copiala ahora: no se va a volver a mostrar. El OWNER la va a tener que cambiar en
                su primer login.
              </p>
              <div class="input-group mb-3">
                <input
                  type="text"
                  class="form-control font-monospace"
                  [value]="result.temporaryPassword"
                  readonly
                />
                <button
                  type="button"
                  class="btn btn-outline-secondary"
                  (click)="copyTemporaryPassword(result.temporaryPassword)"
                >
                  <i
                    class="bi"
                    [class.bi-clipboard]="!copied()"
                    [class.bi-clipboard-check]="copied()"
                  ></i>
                  {{ copied() ? 'Copiada' : 'Copiar' }}
                </button>
              </div>
              <button
                type="button"
                class="btn btn-brand"
                (click)="continueToAccount(result.accountId)"
              >
                Continuar a la cuenta
              </button>
            </div>
          </div>
        } @else {
          <div class="card border">
            <div class="card-body">
              <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
                <div class="mb-3">
                  <label for="name" class="form-label small fw-medium">Nombre</label>
                  <input
                    id="name"
                    type="text"
                    class="form-control"
                    formControlName="name"
                    placeholder="Municipalidad de San Pedro / Comunidad Los Lapachos"
                  />
                </div>

                <div class="mb-3">
                  <label for="subtype" class="form-label small fw-medium"
                    >Tipo de organización</label
                  >
                  <!-- El subtipo dice la ESCALA. Quién opera cada barrio es otra
                       cosa (managedBy) y se elige más abajo. -->
                  <select id="subtype" class="form-select" formControlName="subtype">
                    <option value="MUNICIPAL">Municipal (varios barrios)</option>
                    <option value="COMMUNITY">Comunitaria (un solo barrio)</option>
                  </select>
                  <div class="form-text">
                    Define cuántos barrios gestiona. Quién los <em>opera</em> —CPS o el propio
                    cliente— se decide por barrio, no acá.
                  </div>
                </div>

                <div class="mb-3">
                  <label for="planId" class="form-label small fw-medium">Plan</label>
                  <select id="planId" class="form-select" formControlName="planId">
                    <option [value]="null">Sin plan — cupos a mano</option>
                    @for (plan of plansForSubtype(); track plan.id) {
                      <option [value]="plan.id">{{ plan.name }}</option>
                    }
                  </select>
                  <div class="form-text">
                    El plan precarga los cupos de abajo; podés ajustarlos para esta venta sin crear
                    un plan nuevo. Los cupos quedan copiados en la cuenta: si mañana se reconfigura
                    el plan, este cliente no cambia.
                  </div>
                </div>

                <div class="row g-3 mb-3">
                  @if (!isCommunity()) {
                    <div class="col-12 col-sm-6">
                      <label for="maxNeighborhoods" class="form-label small fw-medium">
                        Cupo de barrios
                      </label>
                      <input
                        id="maxNeighborhoods"
                        type="number"
                        min="1"
                        class="form-control"
                        [class.is-invalid]="
                          form.controls.maxNeighborhoods.touched &&
                          form.controls.maxNeighborhoods.invalid
                        "
                        formControlName="maxNeighborhoods"
                        placeholder="Ej: 5"
                      />
                      @if (
                        form.controls.maxNeighborhoods.touched &&
                        form.controls.maxNeighborhoods.invalid
                      ) {
                        <div class="invalid-feedback">Obligatorio, al menos 1.</div>
                      }
                    </div>
                  }

                  <div class="col-12 col-sm-6">
                    <label for="maxAdminUsers" class="form-label small fw-medium">
                      Cupo de administradores
                    </label>
                    <input
                      id="maxAdminUsers"
                      type="number"
                      min="0"
                      class="form-control"
                      [class.is-invalid]="
                        form.controls.maxAdminUsers.touched && form.controls.maxAdminUsers.invalid
                      "
                      formControlName="maxAdminUsers"
                    />
                    @if (
                      form.controls.maxAdminUsers.touched && form.controls.maxAdminUsers.invalid
                    ) {
                      <div class="invalid-feedback">Obligatorio, 0 o más.</div>
                    }
                  </div>

                  <div class="col-12 col-sm-6">
                    <label for="maxTechnicianUsers" class="form-label small fw-medium">
                      Cupo de técnicos
                    </label>
                    <input
                      id="maxTechnicianUsers"
                      type="number"
                      min="0"
                      class="form-control"
                      [class.is-invalid]="
                        form.controls.maxTechnicianUsers.touched &&
                        form.controls.maxTechnicianUsers.invalid
                      "
                      formControlName="maxTechnicianUsers"
                    />
                    <div class="form-text">0 = sin técnicos propios: el campo lo hace CPS.</div>
                  </div>

                  <div class="col-12 col-sm-6">
                    <label for="maxMonitorUsers" class="form-label small fw-medium">
                      Cupo de monitores
                    </label>
                    <input
                      id="maxMonitorUsers"
                      type="number"
                      min="0"
                      class="form-control"
                      [class.is-invalid]="
                        form.controls.maxMonitorUsers.touched &&
                        form.controls.maxMonitorUsers.invalid
                      "
                      formControlName="maxMonitorUsers"
                    />
                    @if (
                      form.controls.maxMonitorUsers.touched && form.controls.maxMonitorUsers.invalid
                    ) {
                      <div class="invalid-feedback">Obligatorio, 0 o más.</div>
                    }
                  </div>

                  <!-- Los cupos son la TARIFA: después solo se tocan por /quotas (auditado). -->
                  <div class="form-text mt-1">
                    Los cupos son parte de la tarifa: no existe "sin límite" para los barrios. En
                    los de personal, <strong>0 significa que la cuenta no tiene ese rol</strong>.
                    Después se cambian desde la ficha del cliente (solo CPS, queda auditado).
                  </div>
                </div>

                @if (isCommunity()) {
                  <hr />
                  <p class="fw-semibold small mb-1">
                    <i class="bi bi-houses me-1"></i> Barrio de la comunidad
                  </p>
                  <p class="text-muted small">
                    Una organización comunitaria gestiona UN único barrio: sin él, la cuenta queda
                    incompleta. Se crea en este mismo paso.
                  </p>

                  <div class="mb-3">
                    <label for="managedBy" class="form-label small fw-medium">
                      Modalidad del servicio
                    </label>
                    <select id="managedBy" class="form-select" formControlName="managedBy">
                      <option value="CPS">Llave en mano — lo opera CPS</option>
                      <option value="ORGANIZATION">Autogestión — lo opera la comunidad</option>
                    </select>
                    <div class="form-text">
                      Llave en mano: CPS carga viviendas, vecinos y equipos, y la comunidad ve todo
                      sin poder editarlo. Autogestión: sus administradores operan el barrio. Se
                      puede cambiar después (solo CPS, auditado).
                    </div>
                  </div>

                  <div class="mb-3">
                    <label for="neighborhoodName" class="form-label small fw-medium">
                      Nombre del barrio
                    </label>
                    <input
                      id="neighborhoodName"
                      type="text"
                      class="form-control"
                      formControlName="neighborhoodName"
                      [class.is-invalid]="
                        form.controls.neighborhoodName.touched &&
                        form.controls.neighborhoodName.invalid
                      "
                    />
                    @if (
                      form.controls.neighborhoodName.touched &&
                      form.controls.neighborhoodName.invalid
                    ) {
                      <div class="invalid-feedback">El nombre del barrio es obligatorio.</div>
                    }
                  </div>

                  <div class="mb-3 position-relative">
                    <label for="localitySearch" class="form-label small fw-medium">Localidad</label>
                    <input
                      id="localitySearch"
                      type="text"
                      class="form-control"
                      formControlName="localitySearch"
                      placeholder="Escribí al menos 2 letras…"
                      autocomplete="off"
                    />
                    <div class="form-text">
                      Se ignoran acentos y mayúsculas: “cordoba” encuentra “Córdoba”.
                    </div>

                    @if (searchingLocality()) {
                      <div class="form-text text-muted">
                        <span
                          class="spinner-border spinner-border-sm me-1"
                          aria-hidden="true"
                        ></span>
                        Buscando…
                      </div>
                    }

                    @if (localityResults().length > 0) {
                      <ul
                        class="list-group position-absolute w-100 shadow-sm"
                        style="z-index: 5; max-height: 260px; overflow-y: auto"
                      >
                        @for (locality of localityResults(); track locality.id) {
                          <li>
                            <button
                              type="button"
                              class="list-group-item list-group-item-action text-start"
                              (click)="selectLocality(locality)"
                            >
                              {{ fullLocalityName(locality) }}
                            </button>
                          </li>
                        }
                      </ul>
                    }
                  </div>

                  @if (selectedLocality(); as locality) {
                    <div class="alert bg-success-soft border-0 py-2 small mb-3">
                      <i class="bi bi-geo-alt-fill me-1"></i>
                      Localidad elegida: <strong>{{ fullLocalityName(locality) }}</strong>
                    </div>
                  } @else {
                    <div class="alert bg-warning-soft border-0 py-2 small mb-3">
                      <i class="bi bi-info-circle me-1"></i>
                      Elegí una localidad de la lista antes de crear la cuenta.
                    </div>
                  }
                }

                <hr />
                <p class="fw-semibold small mb-1">
                  <i class="bi bi-bank me-1"></i> Usuario institucional (OWNER)
                </p>
                <p class="text-muted small">
                  Es la cuenta de la <strong>institución</strong>, no de una persona: el personal
                  rota, este usuario queda. Con él, el cliente crea sus propios administradores.
                </p>

                <div class="mb-3">
                  <label for="ownerUsername" class="form-label small fw-medium">Usuario</label>
                  <input
                    id="ownerUsername"
                    type="text"
                    class="form-control font-monospace"
                    formControlName="ownerUsername"
                    placeholder="muni_sanpedro"
                    autocomplete="off"
                  />
                  <div class="form-text">
                    Sin contraseña: el sistema genera una clave TEMPORAL que se muestra una sola vez
                    al crear la cuenta. El OWNER la cambia en su primer login.
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
                      Creando…
                    } @else {
                      Crear cliente con su OWNER
                    }
                  </button>
                  <a routerLink="/clientes" class="btn btn-outline-secondary">Cancelar</a>
                </div>
              </form>
            </div>
          </div>
        }
      </div>
    </div>
  `,
})
export class AccountForm {
  private readonly accounts = inject(AccountsService);
  private readonly users = inject(UsersService);
  private readonly geography = inject(GeographyService);
  private readonly plans = inject(PlansService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly created = signal<CreatedAccountResult | null>(null);
  protected readonly copied = signal(false);

  /** Solo los VIGENTES: un plan discontinuado no se puede vender (el backend lo rechaza). */
  private readonly plansCatalog = signal<Plan[]>([]);

  /** Autocomplete de localidad (solo COMMUNITY). Mismo patrón que neighborhood-form. */
  protected readonly localityResults = signal<Locality[]>([]);
  protected readonly searchingLocality = signal(false);
  protected readonly selectedLocality = signal<Locality | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    subtype: ['MUNICIPAL' as OrgSubtype, Validators.required],
    planId: [null as number | null],
    // No existe "sin límite" (2026-07-23) para los barrios. Los de personal
    // admiten 0, que significa "esta cuenta no tiene ese rol".
    maxNeighborhoods: [null as number | null, [Validators.required, Validators.min(1)]],
    maxAdminUsers: [null as number | null, [Validators.required, Validators.min(0)]],
    maxTechnicianUsers: [null as number | null, [Validators.required, Validators.min(0)]],
    maxMonitorUsers: [null as number | null, [Validators.required, Validators.min(0)]],
    ownerUsername: ['', [Validators.required, Validators.minLength(3)]],
    // Solo aplican (con validators) cuando subtype = COMMUNITY, ver constructor.
    managedBy: ['CPS' as ManagedBy],
    neighborhoodName: [''],
    localitySearch: [''],
  });

  protected readonly isCommunity = () => this.form.controls.subtype.value === 'COMMUNITY';

  /** El combo de planes se recorta por subtipo: un plan municipal no se le vende a una comunitaria. */
  protected readonly plansForSubtype = () =>
    this.plansCatalog().filter((p) => p.appliesTo === this.form.controls.subtype.value);

  constructor() {
    this.plans.list({ active: true }).subscribe({
      next: (plans) => this.plansCatalog.set(plans),
      // Sin catálogo el alta sigue andando con los cupos a mano: no vale la
      // pena bloquear una venta porque no cargó un combo de conveniencia.
      error: () => this.plansCatalog.set([]),
    });

    // COMMUNITY gestiona un único barrio y ese barrio se crea acá mismo: el
    // cupo de barrios deja de ser un input (lo fija el backend en 1) y en
    // cambio hacen falta el nombre del barrio, su localidad y la modalidad.
    this.form.controls.subtype.valueChanges.subscribe((subtype) => {
      const community = subtype === 'COMMUNITY';

      if (community) {
        this.form.controls.maxNeighborhoods.disable();
        this.form.controls.maxNeighborhoods.clearValidators();
        this.form.controls.neighborhoodName.setValidators(Validators.required);
      } else {
        this.form.controls.maxNeighborhoods.enable();
        this.form.controls.maxNeighborhoods.setValidators([Validators.required, Validators.min(1)]);
        this.form.controls.neighborhoodName.clearValidators();
        this.selectedLocality.set(null);
        this.form.controls.localitySearch.setValue('');
      }
      this.form.controls.maxNeighborhoods.updateValueAndValidity();
      this.form.controls.neighborhoodName.updateValueAndValidity();

      // El plan elegido puede no aplicar al subtipo nuevo: se limpia en vez de
      // quedar seleccionado en un combo donde ya no figura.
      const plan = this.selectedPlan();
      if (plan && plan.appliesTo !== subtype) this.form.controls.planId.setValue(null);
    });

    // Elegir un plan PRECARGA los cupos, no los congela: quedan editables para
    // el ajuste puntual de esa venta. Se manda igual el planId, para dejar
    // registrado con qué se vendió aunque los números finales sean otros.
    this.form.controls.planId.valueChanges.subscribe(() => {
      const plan = this.selectedPlan();
      if (!plan) return;
      this.form.patchValue(
        {
          maxNeighborhoods: plan.maxNeighborhoods,
          maxAdminUsers: plan.maxAdminUsers,
          maxTechnicianUsers: plan.maxTechnicianUsers,
          maxMonitorUsers: plan.maxMonitorUsers,
        },
        { emitEvent: false },
      );
    });

    this.form.controls.localitySearch.valueChanges
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((term) => {
          if ((term ?? '').trim().length < 2) {
            this.localityResults.set([]);
            this.searchingLocality.set(false);
            return [];
          }
          this.searchingLocality.set(true);
          return this.geography.searchLocalities((term ?? '').trim());
        }),
      )
      .subscribe({
        next: (localities) => {
          this.localityResults.set(localities);
          this.searchingLocality.set(false);
        },
        error: () => this.searchingLocality.set(false),
      });
  }

  /** El `<select>` devuelve string aunque el valor sea numérico: se normaliza acá. */
  private selectedPlan(): Plan | null {
    const raw = this.form.controls.planId.value;
    if (raw === null || raw === undefined || String(raw) === 'null') return null;
    return this.plansCatalog().find((p) => p.id === Number(raw)) ?? null;
  }

  protected selectLocality(locality: Locality): void {
    this.selectedLocality.set(locality);
    this.localityResults.set([]);
    this.form.controls.localitySearch.setValue(this.fullLocalityName(locality), {
      emitEvent: false,
    });
  }

  /** Localidad + departamento + provincia: hay 3 "Villa María" en el país. */
  protected fullLocalityName(locality: Locality): string {
    return `${locality.name}, ${locality.department.name}, ${locality.department.province.name}`;
  }

  protected submit(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();
    const planId = this.selectedPlan()?.id;

    if (this.isCommunity()) {
      const locality = this.selectedLocality();
      if (!locality) {
        this.form.markAllAsTouched();
        return;
      }

      this.saving.set(true);
      this.error.set(null);

      // Todo en un solo POST atómico: el backend lo hace todo o nada, así
      // nunca queda una cuenta comunitaria sin su barrio.
      this.accounts
        .onboardCommunity({
          name: value.name,
          managedBy: value.managedBy,
          ...(planId ? { planId } : {}),
          maxAdminUsers: value.maxAdminUsers!,
          maxTechnicianUsers: value.maxTechnicianUsers!,
          maxMonitorUsers: value.maxMonitorUsers!,
          ownerUsername: value.ownerUsername,
          neighborhood: { name: value.neighborhoodName, localityId: locality.id },
        })
        .subscribe({
          next: (result) => {
            this.saving.set(false);
            this.created.set({
              accountId: result.account.id,
              ownerUsername: result.ownerUsername,
              temporaryPassword: result.temporaryPassword,
            });
          },
          error: (err) => {
            this.error.set(apiErrorMessage(err));
            this.saving.set(false);
          },
        });
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    // MUNICIPAL: tres pasos encadenados (carga sus barrios después, no los
    // necesita en este paso). Si un paso del medio falla, el mensaje del
    // backend dice exactamente cuál.
    this.accounts
      .create({
        name: value.name,
        type: 'ORGANIZATION',
        subtype: value.subtype,
        ...(planId ? { planId } : {}),
        // El form ya validó que no son null (Validators.required + min).
        maxNeighborhoods: value.maxNeighborhoods!,
        maxAdminUsers: value.maxAdminUsers!,
        maxTechnicianUsers: value.maxTechnicianUsers!,
        maxMonitorUsers: value.maxMonitorUsers!,
      })
      .pipe(
        switchMap((account) =>
          this.users
            .create({
              name: value.name,
              kind: 'INSTITUTIONAL',
              username: value.ownerUsername,
            })
            .pipe(
              switchMap((owner) =>
                this.accounts
                  .addMember(account.id, { userId: owner.id, role: 'OWNER' })
                  .pipe(switchMap(() => [{ account, owner }])),
              ),
            ),
        ),
      )
      .subscribe({
        next: ({ account, owner }) => {
          this.saving.set(false);
          // Sin temporaryPassword no hay nada que mostrar: se navega directo
          // (no debería pasar para un alta institucional, pero por las dudas
          // no se deja al admin colgado en una pantalla sin salida).
          if (!owner.temporaryPassword) {
            void this.router.navigate(['/clientes', account.id]);
            return;
          }
          this.created.set({
            accountId: account.id,
            ownerUsername: value.ownerUsername,
            temporaryPassword: owner.temporaryPassword,
          });
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }

  protected copyTemporaryPassword(value: string): void {
    void navigator.clipboard.writeText(value).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    });
  }

  protected continueToAccount(accountId: number): void {
    void this.router.navigate(['/clientes', accountId]);
  }
}
