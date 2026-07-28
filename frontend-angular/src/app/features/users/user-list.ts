import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';

import { UsersService } from '../../core/api/users.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { User } from '../../core/models/api.models';

const PAGE_SIZE = 25;

@Component({
  selector: 'app-user-list',
  imports: [RouterLink, DatePipe, FormsModule],
  template: `
    <div class="d-flex align-items-center justify-content-between mb-3">
      <div>
        <h2 class="h5 fw-bold mb-0"><i class="bi bi-people-fill text-brand me-2"></i>Usuarios</h2>
        <!-- El padrón completo es solo de CPS. -->
        <p class="text-muted small mb-0">Padrón de personas del sistema</p>
      </div>

      <a routerLink="/usuarios/nuevo" class="btn btn-brand btn-sm">
        <i class="bi bi-plus-lg me-1"></i> Nueva persona
      </a>
    </div>

    <div class="mb-3" style="max-width: 320px">
      <input
        type="search"
        class="form-control form-control-sm"
        placeholder="Buscar por nombre, usuario o DNI…"
        [ngModel]="search"
        (ngModelChange)="onSearch($event)"
      />
    </div>

    @if (loading()) {
      <div class="text-center text-muted py-5">
        <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
        Cargando usuarios…
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
              <th scope="col">Persona</th>
              <th scope="col">Usuario</th>
              <th scope="col">Cuenta</th>
              <th scope="col">DNI</th>
              <th scope="col">Correo</th>
              <th scope="col">Estado</th>
              <th scope="col">Último ingreso</th>
            </tr>
          </thead>
          <tbody>
            @for (user of items(); track user.id) {
              <tr>
                <td class="fw-medium small">
                  {{ user.name }}
                  @if (user.kind === 'INSTITUTIONAL') {
                    <!-- La "cuenta root" de la organización: no es una persona. -->
                    <i class="bi bi-bank text-brand ms-1" title="Usuario institucional"></i>
                  }
                </td>
                <td class="small text-muted font-monospace">{{ user.username ?? '—' }}</td>
                <td class="small">
                  @if (user.account) {
                    {{ user.account.name }}
                    <span class="badge bg-light text-muted border ms-1">{{ user.account.role }}</span>
                  } @else {
                    <span class="text-muted">Sin cuenta</span>
                  }
                </td>
                <td class="small text-muted font-monospace">{{ user.dni ?? '—' }}</td>
                <td class="small text-muted">
                  <!-- El email es opcional: muchos vecinos no tienen correo. -->
                  @if (user.email) {
                    {{ user.email }}
                    @if (user.emailVerifiedAt) {
                      <i class="bi bi-patch-check-fill text-success ms-1" title="Verificado"></i>
                    }
                  } @else {
                    <span class="text-muted">Sin correo</span>
                  }
                </td>
                <td>
                  @if (user.status === 'ACTIVE') {
                    <span class="badge bg-success-soft text-success border">Activo</span>
                  } @else {
                    <span class="badge bg-light text-muted border">{{ user.status }}</span>
                  }
                </td>
                <td class="small text-muted">
                  {{ user.lastLoginAt ? (user.lastLoginAt | date: 'dd/MM/yy HH:mm') : 'Nunca' }}
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="7" class="text-muted small text-center py-4">
                  No hay usuarios para mostrar.
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="d-flex align-items-center justify-content-between">
        <span class="text-muted small">
          @if (total() > 0) {
            {{ offset() + 1 }}–{{ offset() + items().length }} de {{ total() }}
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
export class UserList {
  private readonly users = inject(UsersService);

  protected readonly items = signal<User[]>([]);
  protected readonly total = signal(0);
  protected readonly offset = signal(0);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected search = '';
  /** El tipeo no dispara un request por tecla: se espera medio segundo. */
  private readonly searchInput = new Subject<string>();

  protected readonly canPrev = computed(() => this.offset() > 0);
  protected readonly canNext = computed(() => this.offset() + PAGE_SIZE < this.total());

  constructor() {
    this.searchInput.pipe(debounceTime(400), distinctUntilChanged()).subscribe(() => {
      this.offset.set(0);
      this.load();
    });
    this.load();
  }

  protected onSearch(value: string): void {
    this.search = value;
    this.searchInput.next(value.trim());
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

    this.users
      .page({
        search: this.search.trim() ? this.search.trim() : undefined,
        limit: PAGE_SIZE,
        offset: this.offset(),
      })
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
