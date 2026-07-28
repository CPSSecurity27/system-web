import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { apiErrorMessage } from '../../../core/http/api-error';
import { AuthService } from '../../../core/auth/auth.service';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './login.html',
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly fb = inject(FormBuilder);

  private readonly passwordInput = viewChild<ElementRef<HTMLInputElement>>('passwordInput');

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Los errores de validación no se muestran hasta el primer intento de envío. */
  protected readonly submitted = signal(false);

  /** Un solo campo para todos: username (panel), o email/DNI (vecino). */
  protected readonly form = this.fb.nonNullable.group({
    identifier: ['', Validators.required],
    password: ['', Validators.required],
  });

  protected submit(): void {
    this.submitted.set(true);

    if (this.form.invalid || this.loading()) {
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    this.auth.login(this.form.getRawValue()).subscribe({
      next: () => {
        const redirect = this.route.snapshot.queryParamMap.get('redirect') ?? '/';
        void this.router.navigateByUrl(redirect);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);

        // El 401 es ambiguo a propósito (no revela si falló el usuario o la
        // contraseña): se limpia la contraseña para que no quede una
        // incorrecta cargada, sin marcarla como "campo requerido" todavía.
        this.form.controls.password.reset('');
        this.submitted.set(false);
        this.passwordInput()?.nativeElement.focus();
      },
    });
  }
}
