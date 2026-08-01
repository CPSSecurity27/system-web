import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { AccountsService } from '../../core/api/accounts.service';
import { DevicesService } from '../../core/api/devices.service';
import { HomesService } from '../../core/api/homes.service';
import { RemotesService } from '../../core/api/remotes.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Account, Device, Home, Remote } from '../../core/models/api.models';

/**
 * v2: el control puede nacer en una VIVIENDA (alta directa) o en el STOCK
 * (solo CPS; con organización opcional). La entrega stock → vivienda se hace
 * después desde el listado (assign).
 */
@Component({
  selector: 'app-remote-form',
  imports: [ReactiveFormsModule, FormsModule, RouterLink],
  template: `
    <div class="d-flex align-items-center mb-3">
      <a routerLink="/controles" class="btn btn-sm btn-outline-secondary me-2" title="Volver">
        <i class="bi bi-arrow-left"></i>
      </a>
      <h2 class="h5 fw-bold mb-0">Nuevo control remoto</h2>
    </div>

    <div class="row">
      <div class="col-12 col-lg-6">
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
                  placeholder="Llavero cocina"
                />
              </div>

              @if (auth.isCps()) {
                <div class="mb-3">
                  <label for="destino" class="form-label small fw-medium">Destino</label>
                  <select id="destino" class="form-select" formControlName="destino">
                    <option value="HOME">Directo a una vivienda</option>
                    <option value="STOCK">A stock (entregar después)</option>
                  </select>
                </div>
              }

              @if (form.controls.destino.value === 'HOME') {
                <div class="mb-3">
                  <label for="homeId" class="form-label small fw-medium">Vivienda dueña</label>
                  <select id="homeId" class="form-select" formControlName="homeId">
                    <option [ngValue]="null">Elegí una vivienda…</option>
                    @for (home of homes(); track home.id) {
                      <option [ngValue]="home.id">{{ home.name }}</option>
                    }
                  </select>
                  <!-- El dueño no se cambia después: es la casa, no la persona. -->
                  <div class="form-text">
                    La vivienda es la <strong>dueña</strong> del control y no cambia. Quién lo lleva
                    encima sí se reasigna. El barrio debe tener controles habilitados.
                  </div>
                </div>

                <div class="mb-3">
                  <label for="deviceId" class="form-label small fw-medium">
                    Alarma que dispara <span class="text-muted fw-normal">(opcional)</span>
                  </label>
                  <select id="deviceId" class="form-select" formControlName="deviceId">
                    <option [ngValue]="null">Sin asociar</option>
                    @for (device of devices(); track device.id) {
                      <option [ngValue]="device.id">
                        {{ device.name ?? device.serial }} — {{ device.serial }}
                      </option>
                    }
                  </select>
                </div>
              } @else {
                <div class="mb-3">
                  <label for="organizationId" class="form-label small fw-medium">
                    Al stock de <span class="text-muted fw-normal">(opcional)</span>
                  </label>
                  <select id="organizationId" class="form-select" formControlName="organizationId">
                    <option [ngValue]="null">Fábrica CPS</option>
                    @for (org of organizations(); track org.id) {
                      <option [ngValue]="org.id">{{ org.name }}</option>
                    }
                  </select>
                </div>
              }

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
                    Crear control
                  }
                </button>
                <a routerLink="/controles" class="btn btn-outline-secondary">Cancelar</a>
              </div>
            </form>
          </div>
        </div>
      </div>

      <!--
        EL STOCK: los controles que todavía NO están en ninguna vivienda.
        Mismo corte que en alarmas — Operar es lo que está en uso, Inventario lo
        que está esperando. Acá se entregan, que es la operación que faltaba
        para una municipalidad.
      -->
      <div class="col-12 col-lg-6">
        <div class="card border">
          <div class="card-header bg-white border-bottom d-flex align-items-center">
            <span class="fw-semibold small">
              <i class="bi bi-box-seam me-1"></i> Controles en stock
            </span>
            <span class="badge text-bg-light border ms-2">{{ stock().length }}</span>
          </div>
          <div class="card-body">
            @if (loadingStock()) {
              <p class="text-muted small mb-0">
                <span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
                Cargando…
              </p>
            } @else if (stock().length === 0) {
              <p class="text-muted small mb-0">
                No hay controles en stock. Los que ya están en una vivienda se ven en
                <a routerLink="/controles">Controles</a>.
              </p>
            } @else {
              @if (assignMessage()) {
                <div class="alert bg-success-soft border-0 py-2 small">{{ assignMessage() }}</div>
              }
              <ul class="list-unstyled small mb-0">
                @for (remote of stock(); track remote.id) {
                  <li class="border-bottom py-2">
                    <div class="fw-medium">{{ remote.name ?? 'Control #' + remote.id }}</div>
                    <div class="d-flex gap-2 align-items-center mt-1 flex-wrap">
                      <select
                        class="form-select form-select-sm"
                        style="max-width: 240px"
                        [(ngModel)]="assignTo[remote.id]"
                        [ngModelOptions]="{ standalone: true }"
                      >
                        <option [ngValue]="undefined">Entregar a…</option>
                        @for (home of homes(); track home.id) {
                          <option [ngValue]="home.id">{{ home.name }}</option>
                        }
                      </select>
                      <button
                        type="button"
                        class="btn btn-sm btn-outline-brand"
                        [disabled]="saving() || !assignTo[remote.id]"
                        (click)="assign(remote.id)"
                      >
                        Entregar
                      </button>
                    </div>
                  </li>
                }
              </ul>
            }
          </div>
        </div>
      </div>
    </div>
  `,
})
export class RemoteForm {
  private readonly remotes = inject(RemotesService);
  private readonly homesService = inject(HomesService);
  private readonly devicesService = inject(DevicesService);
  private readonly accounts = inject(AccountsService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  protected readonly auth = inject(AuthService);

  protected readonly homes = signal<Home[]>([]);
  protected readonly devices = signal<Device[]>([]);
  protected readonly accountList = signal<Account[]>([]);
  protected readonly organizations = computed(() =>
    this.accountList().filter((a) => a.type === 'ORGANIZATION'),
  );
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly form = this.fb.group({
    name: ['', Validators.required],
    destino: ['HOME' as 'HOME' | 'STOCK'],
    homeId: [null as number | null],
    organizationId: [null as number | null],
    deviceId: [null as number | null],
  });

  /** El stock: controles sin vivienda. CPS ve todo; una organización, el suyo. */
  protected readonly stock = signal<Remote[]>([]);
  protected readonly loadingStock = signal(true);
  protected readonly assignMessage = signal<string | null>(null);
  /** A qué vivienda va cada control, indexado por id. */
  protected assignTo: Record<number, number | undefined> = {};

  private loadStock(): void {
    this.loadingStock.set(true);
    this.remotes.inventory().subscribe({
      next: (stock) => {
        this.stock.set(stock);
        this.loadingStock.set(false);
      },
      error: () => {
        this.stock.set([]);
        this.loadingStock.set(false);
      },
    });
  }

  /** Entrega física: del stock a una vivienda. El dueño del control no cambia. */
  protected assign(remoteId: number): void {
    const homeId = this.assignTo[remoteId];
    if (!homeId || this.saving()) return;

    this.saving.set(true);
    this.error.set(null);
    this.assignMessage.set(null);

    this.remotes.assign(remoteId, homeId).subscribe({
      next: () => {
        this.saving.set(false);
        this.assignTo[remoteId] = undefined;
        const home = this.homes().find((h) => h.id === homeId);
        this.assignMessage.set(`Control entregado a ${home?.name ?? 'la vivienda'}.`);
        this.loadStock();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  constructor() {
    this.loadStock();

    forkJoin({ homes: this.homesService.list(), devices: this.devicesService.list() }).subscribe({
      next: ({ homes, devices }) => {
        this.homes.set(homes);
        this.devices.set(devices);
      },
      error: (err) => this.error.set(apiErrorMessage(err)),
    });

    if (this.auth.isCps()) {
      this.accounts.list().subscribe({
        next: (accounts) => this.accountList.set(accounts),
        error: () => this.accountList.set([]),
      });
    }
  }

  protected submit(): void {
    const value = this.form.getRawValue();
    const aVivienda = value.destino === 'HOME';

    if (this.form.invalid || (aVivienda && !value.homeId) || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    this.remotes
      .create({
        name: value.name as string,
        ...(aVivienda
          ? { homeId: value.homeId as number, deviceId: value.deviceId ?? undefined }
          : { organizationId: value.organizationId ?? undefined }),
      })
      .subscribe({
        next: () => void this.router.navigate(['/controles']),
        error: (err) => {
          // 400 típico: el barrio no tiene controles habilitados (cupo).
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }
}
