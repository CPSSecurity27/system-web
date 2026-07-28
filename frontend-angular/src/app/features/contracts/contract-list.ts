import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { AccountsService } from '../../core/api/accounts.service';
import { ContractsService } from '../../core/api/contracts.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Account, Contract, ContractStatus } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';

@Component({
  selector: 'app-contract-list',
  imports: [RouterLink, DatePipe, CurrencyPipe],
  template: `
    <div class="d-flex align-items-center justify-content-between mb-3">
      <div>
        <h2 class="h5 fw-bold mb-0">
          <i class="bi bi-file-earmark-text-fill text-brand me-2"></i>Contratos
        </h2>
        <!-- v2: comercial puro. El alcance ya NO sale de acá (sale de la estructura). -->
        <p class="text-muted small mb-0">Lo comercial: cada organización y su barrio</p>
      </div>

      @if (auth.isCps()) {
        <a routerLink="/contratos/nuevo" class="btn btn-brand btn-sm">
          <i class="bi bi-plus-lg me-1"></i> Nuevo contrato
        </a>
      }
    </div>

    @if (error()) {
      <div class="alert bg-brand-soft text-brand border-0" role="alert">
        <i class="bi bi-exclamation-triangle-fill me-2"></i>{{ error() }}
      </div>
    }

    @if (loading()) {
      <div class="text-center text-muted py-5">
        <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
        Cargando contratos…
      </div>
    } @else if (items().length === 0) {
      <div class="text-center text-muted py-5 bg-light rounded">
        <i class="bi bi-file-earmark d-block mb-2" style="font-size: 2rem;"></i>
        No hay contratos para mostrar.
      </div>
    } @else {
      <div class="table-responsive">
        <table class="table table-hover align-middle">
          <thead>
            <tr class="small text-muted">
              <th scope="col">Organización</th>
              <th scope="col">Barrio</th>
              <th scope="col">Precio</th>
              <th scope="col">Desde</th>
              <th scope="col">Hasta</th>
              <th scope="col">Estado</th>
              @if (auth.isCps()) {
                <th scope="col" class="text-end"></th>
              }
            </tr>
          </thead>
          <tbody>
            @for (contract of items(); track contract.id) {
              <tr>
                <td class="fw-medium small">{{ accountName(contract.accountId) }}</td>
                <td class="small text-muted">
                  <i class="bi bi-houses me-1"></i>{{ barrioName(contract.neighborhoodId) }}
                </td>
                <!-- El precio está CONGELADO al valor de la firma. -->
                <td class="small">{{ contract.price | currency: 'ARS' : 'symbol-narrow' }}</td>
                <td class="small text-muted">{{ contract.startDate | date: 'dd/MM/yyyy' }}</td>
                <td class="small text-muted">
                  {{ contract.endDate ? (contract.endDate | date: 'dd/MM/yyyy') : '—' }}
                </td>
                <td>
                  @switch (contract.status) {
                    @case ('ACTIVE') {
                      <span class="badge bg-success-soft text-success border">Activo</span>
                    }
                    @case ('SUSPENDED') {
                      <span class="badge bg-warning-soft text-warning border">Suspendido</span>
                    }
                    @case ('EXPIRED') {
                      <span class="badge bg-light text-muted border">Vencido</span>
                    }
                    @default {
                      <span class="badge bg-light text-muted border">Cancelado</span>
                    }
                  }
                </td>
                @if (auth.isCps()) {
                  <td class="text-end text-nowrap">
                    <!-- Cuenta, barrio y precio están CONGELADOS: solo el estado se toca. -->
                    @switch (contract.status) {
                      @case ('ACTIVE') {
                        <button
                          type="button"
                          class="btn btn-sm btn-outline-secondary me-1"
                          title="Suspender"
                          [disabled]="saving()"
                          (click)="setStatus(contract, 'SUSPENDED')"
                        >
                          <i class="bi bi-pause"></i>
                        </button>
                        <button
                          type="button"
                          class="btn btn-sm btn-outline-danger"
                          title="Cancelar el contrato (cierre definitivo)"
                          [disabled]="saving()"
                          (click)="cancel(contract)"
                        >
                          <i class="bi bi-x-lg"></i>
                        </button>
                      }
                      @case ('SUSPENDED') {
                        <button
                          type="button"
                          class="btn btn-sm btn-outline-success me-1"
                          title="Reactivar"
                          [disabled]="saving()"
                          (click)="setStatus(contract, 'ACTIVE')"
                        >
                          <i class="bi bi-play"></i>
                        </button>
                        <button
                          type="button"
                          class="btn btn-sm btn-outline-danger"
                          title="Cancelar el contrato (cierre definitivo)"
                          [disabled]="saving()"
                          (click)="cancel(contract)"
                        >
                          <i class="bi bi-x-lg"></i>
                        </button>
                      }
                      @default {
                        <!-- EXPIRED/CANCELLED: historial. Para volver, se firma otro. -->
                      }
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class ContractList {
  private readonly contracts = inject(ContractsService);
  private readonly accounts = inject(AccountsService);
  private readonly neighborhoods = inject(NeighborhoodsService);
  protected readonly auth = inject(AuthService);

  protected readonly items = signal<Contract[]>([]);
  protected readonly accountList = signal<Account[]>([]);
  protected readonly barrioList = signal<Neighborhood[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    forkJoin({
      contracts: this.contracts.list(),
      accounts: this.accounts.list(),
      barrios: this.neighborhoods.list(),
    }).subscribe({
      next: ({ contracts, accounts, barrios }) => {
        this.items.set(contracts);
        this.accountList.set(accounts);
        this.barrioList.set(barrios);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  /** Suspender/reactivar. Reactivar puede dar 409 si el barrio ya tiene otro ACTIVE. */
  protected setStatus(contract: Contract, status: ContractStatus): void {
    if (this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    this.contracts.update(contract.id, { status }).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.items.update((list) => list.map((c) => (c.id === updated.id ? updated : c)));
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  /**
   * Cierre definitivo: CANCELLED con fin = hoy. No se reabre: para volver se
   * firma OTRO contrato (así queda el historial, como una factura anulada).
   */
  protected cancel(contract: Contract): void {
    const hoy = new Date().toISOString().slice(0, 10);
    if (this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    this.contracts.update(contract.id, { status: 'CANCELLED', endDate: hoy }).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.items.update((list) => list.map((c) => (c.id === updated.id ? updated : c)));
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  protected accountName(id: number): string {
    return this.accountList().find((a) => a.id === id)?.name ?? `Cuenta #${id}`;
  }

  protected barrioName(id: number): string {
    return this.barrioList().find((b) => b.id === id)?.name ?? `Barrio #${id}`;
  }
}
