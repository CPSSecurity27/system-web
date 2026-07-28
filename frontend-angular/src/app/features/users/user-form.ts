import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { UsersService } from '../../core/api/users.service';
import { apiErrorMessage } from '../../core/http/api-error';

@Component({
  selector: 'app-user-form',
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <div class="d-flex align-items-center mb-3">
      <a routerLink="/usuarios" class="btn btn-sm btn-outline-secondary me-2" title="Volver">
        <i class="bi bi-arrow-left"></i>
      </a>
      <h2 class="h5 fw-bold mb-0">Nueva persona</h2>
    </div>

    <div class="row">
      <div class="col-12 col-lg-6">
        <div class="card border">
          <div class="card-body">
            <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
              <div class="mb-3">
                <label for="name" class="form-label small fw-medium">Nombre y apellido</label>
                <input id="name" type="text" class="form-control" formControlName="name" />
              </div>

              <div class="mb-3">
                <label for="username" class="form-label small fw-medium">Usuario</label>
                <input
                  id="username"
                  type="text"
                  class="form-control font-monospace"
                  formControlName="username"
                  autocomplete="off"
                />
                <!-- El handle de login es el username, no el email. -->
                <div class="form-text">Con esto va a iniciar sesión (no con el correo).</div>
              </div>

              <div class="mb-3">
                <label for="password" class="form-label small fw-medium">Contraseña inicial</label>
                <input
                  id="password"
                  type="password"
                  class="form-control"
                  formControlName="password"
                  autocomplete="new-password"
                />
              </div>

              <div class="mb-3">
                <label for="email" class="form-label small fw-medium">
                  Correo <span class="text-muted fw-normal">(opcional)</span>
                </label>
                <input id="email" type="email" class="form-control" formControlName="email" />
                <!-- Sin correo no hay "olvidé mi contraseña": vale avisarlo acá. -->
                <div class="form-text">
                  Muchos vecinos no tienen. Sin correo, esta persona
                  <strong>no va a poder recuperar su contraseña</strong> sola.
                </div>
              </div>

              <div class="mb-3">
                <label for="telephone" class="form-label small fw-medium">
                  Teléfono <span class="text-muted fw-normal">(opcional)</span>
                </label>
                <input id="telephone" type="tel" class="form-control" formControlName="telephone" />
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
                    Crear persona
                  }
                </button>
                <a routerLink="/usuarios" class="btn btn-outline-secondary">Cancelar</a>
              </div>
            </form>

            <!--
              Crear al usuario NO le da acceso a nada. El acceso lo da la membresía:
              son dos pasos y la UI tiene que hacer los dos.
            -->
            <p class="text-muted small mb-0 mt-3 border-top pt-3">
              <i class="bi bi-info-circle me-1"></i>
              Crear la persona <strong>no le da acceso a nada</strong>. Después hay que sumarla a
              una <a routerLink="/cuentas">cuenta</a> con un rol.
            </p>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class UserForm {
  private readonly users = inject(UsersService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    username: ['', Validators.required],
    password: ['', [Validators.required, Validators.minLength(8)]],
    email: ['', Validators.email],
    telephone: [''],
  });

  protected submit(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();

    this.saving.set(true);
    this.error.set(null);

    this.users
      .create({
        name: value.name,
        username: value.username,
        password: value.password,
        email: value.email.trim() ? value.email.trim() : undefined,
        telephone: value.telephone.trim() ? value.telephone.trim() : undefined,
      })
      .subscribe({
        next: () => void this.router.navigate(['/usuarios']),
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }
}
