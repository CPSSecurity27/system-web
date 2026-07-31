import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AccountsService } from '../../core/api/accounts.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Account } from '../../core/models/api.models';

const PAGE_SIZE = 25;

@Component({
  selector: 'app-account-list',
  imports: [RouterLink],
  template: `
    <div class="d-flex align-items-center justify-content-between mb-3">
      <div>
        <h2 class="h5 fw-bold mb-0">
          <i class="bi bi-briefcase-fill text-brand me-2"></i>Clientes
        </h2>
        <p class="text-muted small mb-0">
          Organizaciones municipales y comunitarias, con sus cupos de tarifa
        </p>
      </div>

      <a routerLink="/clientes/nuevo" class="btn btn-brand btn-sm">
        <i class="bi bi-plus-lg me-1"></i> Nuevo cliente
      </a>
    </div>

    @if (loading()) {
      <div class="text-center text-muted py-5">
        <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
        Cargando cuentas…
      </div>
    } @else if (error()) {
      <div class="alert bg-brand-soft text-brand border-0" role="alert">
        <i class="bi bi-exclamation-triangle-fill me-2"></i>{{ error() }}
      </div>
    } @else {
      <div class="table-responsive">
        <table class="table table-hover align-middle">
          <thead>
            <tr class="small text-muted">
              <th scope="col">Cliente</th>
              <th scope="col">Tipo</th>
              <th scope="col">Barrios</th>
              <th scope="col" class="text-nowrap">Admins</th>
              <th scope="col" class="text-nowrap">Técnicos</th>
              <th scope="col" class="text-nowrap">Monitores</th>
              <th scope="col">Estado</th>
              <th scope="col" class="text-end"></th>
            </tr>
          </thead>
          <tbody>
            <!-- CPS no aparece acá: no es un cliente. Su ficha vive en Mi Empresa
                 y la lista se pide filtrada a ORGANIZATION (ver load()). Por eso
                 las columnas de cupo ya no necesitan su caso "—": una
                 ORGANIZATION siempre tiene los cuatro números. -->
            @for (account of items(); track account.id) {
              <tr>
                <td class="fw-medium">{{ account.name }}</td>
                <td>
                  @if (account.subtype === 'MUNICIPAL') {
                    <span class="badge text-bg-light border">Municipal</span>
                  } @else {
                    <span class="badge text-bg-light border">Comunitaria</span>
                  }
                </td>
                <td class="small text-muted">{{ account.maxNeighborhoods }}</td>
                <td class="small text-muted">{{ account.maxAdminUsers }}</td>
                <!-- 0 no es "cupo agotado": es "no tiene ese rol", y se lee distinto. -->
                <td class="small text-muted">
                  @if (account.maxTechnicianUsers === 0) {
                    <span class="text-muted" title="Sin técnicos propios: el campo lo hace CPS"
                      >—</span
                    >
                  } @else {
                    {{ account.maxTechnicianUsers }}
                  }
                </td>
                <td class="small text-muted">
                  @if (account.maxMonitorUsers === 0) {
                    <span class="text-muted" title="Sin usuarios de monitoreo">—</span>
                  } @else {
                    {{ account.maxMonitorUsers }}
                  }
                </td>
                <td class="small text-muted">{{ account.status }}</td>
                <td class="text-end">
                  <a [routerLink]="['/clientes', account.id]" class="btn btn-sm btn-outline-brand">
                    <i class="bi bi-people me-1"></i> Gestionar
                  </a>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="d-flex align-items-center justify-content-between">
        <span class="text-muted small">
          @if (total() > 0) {
            {{ offset() + 1 }} – {{ offset() + items().length }} de {{ total() }}
          }
        </span>
        <div class="btn-group">
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            [disabled]="!canPrev() || loading()"
            (click)="prev()"
          >
            <i class="bi bi-chevron-left"></i> Anteriores
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            [disabled]="!canNext() || loading()"
            (click)="next()"
          >
            Siguientes <i class="bi bi-chevron-right"></i>
          </button>
        </div>
      </div>
    }
  `,
})
export class AccountList {
  private readonly accounts = inject(AccountsService);

  protected readonly items = signal<Account[]>([]);
  protected readonly total = signal(0);
  protected readonly offset = signal(0);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly canPrev = computed(() => this.offset() > 0);
  protected readonly canNext = computed(() => this.offset() + PAGE_SIZE < this.total());

  constructor() {
    this.load();
  }

  protected prev(): void {
    if (!this.canPrev()) return;
    this.offset.set(Math.max(0, this.offset() - PAGE_SIZE));
    this.load();
  }

  protected next(): void {
    if (!this.canNext()) return;
    this.offset.set(this.offset() + PAGE_SIZE);
    this.load();
  }

  private load(): void {
    this.loading.set(true);

    // type=ORGANIZATION: CPS no es un cliente y no tiene nada que hacer en esta
    // lista (sus cupos son NULL y sus columnas quedarían todas vacías). Su
    // ficha se administra desde Mi Empresa.
    this.accounts
      .page({ limit: PAGE_SIZE, offset: this.offset(), type: 'ORGANIZATION' })
      .subscribe({
        next: (page) => {
          this.items.set(page.items);
          this.total.set(page.total);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.loading.set(false);
        },
      });
  }
}
