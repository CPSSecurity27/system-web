import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { CreatePlan, PlansService } from '../../core/api/plans.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { OrgSubtype, Plan } from '../../core/models/api.models';

/**
 * El catálogo comercial de CPS (solo CPS).
 *
 * Lo importante que la pantalla tiene que dejar claro, porque es la fuente de
 * malentendidos: un plan es una PLANTILLA. Editarlo NO le cambia los cupos a
 * ningún cliente que ya lo compró — esos números viven copiados en su cuenta y
 * solo se tocan desde su ficha, uno por uno y auditado. Por eso hay un aviso
 * fijo y por eso se muestra cuántos clientes tiene cada plan: para que quien
 * edita vea a cuántos NO va a afectar.
 *
 * Un plan no se borra: se DISCONTINÚA. Así deja de ofrecerse en el alta pero
 * los clientes vendidos con él conservan la etiqueta de con qué se vendieron.
 */
@Component({
  selector: 'app-plan-list',
  imports: [ReactiveFormsModule],
  template: `
    <div class="d-flex align-items-center justify-content-between mb-3">
      <div>
        <h2 class="h5 fw-bold mb-0"><i class="icon-tags text-brand me-2"></i>Planes</h2>
        <p class="text-muted small mb-0">Qué cupos otorga cada plan que vendemos</p>
      </div>
      <button type="button" class="btn btn-brand btn-sm" (click)="toggleCreate()">
        <i [class.icon-plus]="!creating()" [class.icon-x]="creating()"></i>
        {{ creating() ? 'Cancelar' : 'Nuevo plan' }}
      </button>
    </div>

    <!-- Nota informativa, NO un error: va con la familia de marca. -->
    <div class="alert bg-brand-soft text-brand border-0 py-2 small">
      <i class="icon-info me-1"></i>
      Los planes son <strong>plantillas</strong>: al vender, sus cupos se copian a la cuenta del
      cliente. Editar un plan no le cambia nada a quien ya lo compró — para eso está la ficha del
      cliente, que además deja el cambio auditado.
    </div>

    @if (error()) {
      <div class="alert bg-emergency-soft text-emergency border-0" role="alert">
        <i class="icon-triangle-alert me-2"></i>{{ error() }}
      </div>
    }

    @if (creating()) {
      <div class="card border mb-3">
        <div class="card-header bg-white border-bottom">
          <span class="fw-semibold small"><i class="icon-tag me-1"></i> Nuevo plan</span>
        </div>
        <div class="card-body">
          <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
            <div class="row g-3">
              <div class="col-12 col-sm-4">
                <label for="code" class="form-label small fw-medium">Código</label>
                <input
                  id="code"
                  type="text"
                  class="form-control form-control-sm font-monospace"
                  formControlName="code"
                  placeholder="MUNICIPAL_PLUS"
                  [class.is-invalid]="form.controls.code.touched && form.controls.code.invalid"
                />
                <div class="form-text">MAYÚSCULAS, sin espacios. No se puede cambiar después.</div>
              </div>
              <div class="col-12 col-sm-5">
                <label for="pName" class="form-label small fw-medium">Nombre</label>
                <input
                  id="pName"
                  type="text"
                  class="form-control form-control-sm"
                  formControlName="name"
                  placeholder="Municipal Plus"
                />
              </div>
              <div class="col-12 col-sm-3">
                <label for="appliesTo" class="form-label small fw-medium">Aplica a</label>
                <select
                  id="appliesTo"
                  class="form-select form-select-sm"
                  formControlName="appliesTo"
                >
                  <option value="MUNICIPAL">Municipal</option>
                  <option value="COMMUNITY">Comunitaria</option>
                </select>
              </div>

              <div class="col-12">
                <label for="description" class="form-label small fw-medium">Descripción</label>
                <input
                  id="description"
                  type="text"
                  class="form-control form-control-sm"
                  formControlName="description"
                />
              </div>

              <div class="col-6 col-sm-3">
                <label for="pNeigh" class="form-label small fw-medium">Barrios</label>
                <input
                  id="pNeigh"
                  type="number"
                  min="1"
                  class="form-control form-control-sm"
                  formControlName="maxNeighborhoods"
                />
                @if (isCommunityPlan()) {
                  <div class="form-text">
                    <i class="icon-lock me-1"></i>Fijo en 1: es comunitaria.
                  </div>
                }
              </div>
              <div class="col-6 col-sm-3">
                <label for="pAdmin" class="form-label small fw-medium">Admins</label>
                <input
                  id="pAdmin"
                  type="number"
                  min="0"
                  class="form-control form-control-sm"
                  formControlName="maxAdminUsers"
                />
              </div>
              <div class="col-6 col-sm-3">
                <label for="pTech" class="form-label small fw-medium">Técnicos</label>
                <input
                  id="pTech"
                  type="number"
                  min="0"
                  class="form-control form-control-sm"
                  formControlName="maxTechnicianUsers"
                />
                <div class="form-text">0 = el campo lo hace CPS.</div>
              </div>
              <div class="col-6 col-sm-3">
                <label for="pMon" class="form-label small fw-medium">Monitores</label>
                <input
                  id="pMon"
                  type="number"
                  min="0"
                  class="form-control form-control-sm"
                  formControlName="maxMonitorUsers"
                />
              </div>

              <div class="col-6 col-sm-3">
                <label for="pFam" class="form-label small fw-medium">Familiares por hogar</label>
                <input
                  id="pFam"
                  type="number"
                  min="0"
                  class="form-control form-control-sm"
                  formControlName="maxFamilyMembers"
                />
              </div>
              <div class="col-6 col-sm-3">
                <label for="pPrice" class="form-label small fw-medium">Precio de lista</label>
                <input
                  id="pPrice"
                  type="text"
                  inputmode="decimal"
                  class="form-control form-control-sm"
                  formControlName="priceReference"
                  placeholder="Opcional"
                />
              </div>
              <div class="col-12 col-sm-6 d-flex align-items-end">
                <div class="form-check">
                  <!-- Disparar TODAS las alarmas del barrio desde la app. -->
                  <input
                    id="pScope"
                    type="checkbox"
                    class="form-check-input"
                    formControlName="communityScopeEnabled"
                  />
                  <label class="form-check-label small" for="pScope">
                    Puede activar todo el barrio
                  </label>
                </div>
              </div>

              <div class="col-12">
                <button
                  type="submit"
                  class="btn btn-sm btn-brand"
                  [disabled]="saving() || form.invalid"
                >
                  @if (saving()) {
                    <span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
                  }
                  Crear plan
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    }

    @if (loading()) {
      <div class="text-center text-muted py-5">
        <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
        Cargando planes…
      </div>
    } @else {
      <div class="table-responsive">
        <table class="table table-hover align-middle">
          <thead>
            <tr class="small text-muted">
              <th scope="col">Plan</th>
              <th scope="col">Aplica a</th>
              <th scope="col">Barrios</th>
              <th scope="col">Admins</th>
              <th scope="col">Técnicos</th>
              <th scope="col">Monitores</th>
              <th scope="col">Familiares</th>
              <th scope="col">Estado</th>
              <th scope="col" class="text-end"></th>
            </tr>
          </thead>
          <tbody>
            @for (plan of plans(); track plan.id) {
              <tr [class.opacity-50]="!plan.active">
                <td>
                  <div class="fw-medium">{{ plan.name }}</div>
                  <div class="small text-muted font-monospace">{{ plan.code }}</div>
                </td>
                <td class="small">
                  @if (plan.appliesTo === 'MUNICIPAL') {
                    <span class="badge text-bg-light border">Municipal</span>
                  } @else {
                    <span class="badge text-bg-light border">Comunitaria</span>
                  }
                </td>
                <td class="small text-muted">{{ plan.maxNeighborhoods }}</td>
                <td class="small text-muted">{{ plan.maxAdminUsers }}</td>
                <td class="small text-muted">{{ plan.maxTechnicianUsers }}</td>
                <td class="small text-muted">{{ plan.maxMonitorUsers }}</td>
                <td class="small text-muted">{{ plan.maxFamilyMembers }}</td>
                <td class="small">
                  @if (plan.active) {
                    <span class="badge bg-success-soft text-success border">Vigente</span>
                  } @else {
                    <span class="badge text-bg-light border">Discontinuado</span>
                  }
                </td>
                <td class="text-end">
                  <!-- Discontinuar en vez de borrar: los clientes vendidos con
                       este plan conservan la etiqueta de con qué se vendieron. -->
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary"
                    [disabled]="saving()"
                    (click)="toggleActive(plan)"
                  >
                    {{ plan.active ? 'Discontinuar' : 'Reactivar' }}
                  </button>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="9" class="text-muted small text-center py-4">
                  Todavía no hay planes cargados.
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class PlanList {
  private readonly plansApi = inject(PlansService);
  private readonly fb = inject(FormBuilder);

  protected readonly plans = signal<Plan[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly creating = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    code: ['', [Validators.required, Validators.pattern(/^[A-Z0-9_]{2,32}$/)]],
    name: ['', Validators.required],
    description: [''],
    appliesTo: ['MUNICIPAL' as OrgSubtype, Validators.required],
    priceReference: [''],
    maxNeighborhoods: [1, [Validators.required, Validators.min(1)]],
    maxAdminUsers: [3, [Validators.required, Validators.min(0)]],
    maxTechnicianUsers: [0, [Validators.required, Validators.min(0)]],
    maxMonitorUsers: [1, [Validators.required, Validators.min(0)]],
    maxFamilyMembers: [3, [Validators.required, Validators.min(0)]],
    communityScopeEnabled: [true],
  });

  protected readonly isCommunityPlan = computed(
    () => this.form.controls.appliesTo.value === 'COMMUNITY',
  );

  constructor() {
    this.load();

    // Un plan comunitario es de un solo barrio, siempre: el backend y un CHECK
    // de la base lo rechazan. Se fija acá para no dejar escribir un número que
    // solo va a rebotar al guardar.
    this.form.controls.appliesTo.valueChanges.subscribe((appliesTo) => {
      if (appliesTo === 'COMMUNITY') {
        this.form.controls.maxNeighborhoods.setValue(1);
        this.form.controls.maxNeighborhoods.disable();
      } else {
        this.form.controls.maxNeighborhoods.enable();
      }
    });
  }

  protected toggleCreate(): void {
    this.creating.update((v) => !v);
  }

  protected submit(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();
    const plan: CreatePlan = {
      code: value.code,
      name: value.name,
      appliesTo: value.appliesTo,
      maxNeighborhoods: value.maxNeighborhoods,
      maxAdminUsers: value.maxAdminUsers,
      maxTechnicianUsers: value.maxTechnicianUsers,
      maxMonitorUsers: value.maxMonitorUsers,
      maxFamilyMembers: value.maxFamilyMembers,
      communityScopeEnabled: value.communityScopeEnabled,
      ...(value.description ? { description: value.description } : {}),
      ...(value.priceReference ? { priceReference: value.priceReference } : {}),
    };

    this.saving.set(true);
    this.error.set(null);

    this.plansApi.create(plan).subscribe({
      next: () => {
        this.saving.set(false);
        this.creating.set(false);
        this.form.reset();
        this.load();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  protected toggleActive(plan: Plan): void {
    this.saving.set(true);
    this.error.set(null);

    this.plansApi.update(plan.id, { active: !plan.active }).subscribe({
      next: () => {
        this.saving.set(false);
        this.load();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  private load(): void {
    this.loading.set(true);
    this.plansApi.list().subscribe({
      next: (plans) => {
        this.plans.set(plans);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }
}
