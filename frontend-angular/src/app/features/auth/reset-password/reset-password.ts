import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';
import { apiErrorMessage } from '../../../core/http/api-error';

/** Las dos contraseñas tienen que coincidir. */
function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const password = group.get('newPassword')?.value;
  const repeat = group.get('repeat')?.value;
  return password && repeat && password !== repeat ? { mismatch: true } : null;
}

@Component({
  selector: 'app-reset-password',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './reset-password.html',
})
export class ResetPassword {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /**
   * El token viene en la query del link del mail: FRONTEND_URL/reset-password?token=...
   * Es lo ÚNICO que prueba la identidad acá (el usuario no puede entrar, así que
   * no hay contraseña actual que pedirle). Vence en 1 hora y es de un solo uso.
   */
  protected readonly token = this.route.snapshot.queryParamMap.get('token');

  /**
   * Misma pantalla para "activar cuenta" (vecino nuevo, sin contraseña) y
   * "olvidé mi contraseña": para el backend son el mismo endpoint (fijar la
   * clave es indistinguible de resetearla). Solo cambia el texto — lo decide
   * la ruta (`/activar-cuenta` vs `/reset-password`), ver app.routes.ts.
   */
  protected readonly activation = this.route.snapshot.data['activation'] === true;

  protected readonly loading = signal(false);
  protected readonly done = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group(
    {
      newPassword: ['', [Validators.required, Validators.minLength(8)]],
      repeat: ['', Validators.required],
    },
    { validators: passwordsMatch },
  );

  protected submit(): void {
    if (this.form.invalid || this.loading() || !this.token) {
      this.form.markAllAsTouched();
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    this.http
      .post(`${environment.apiUrl}/auth/reset-password`, {
        token: this.token,
        newPassword: this.form.getRawValue().newPassword,
      })
      .subscribe({
        next: () => {
          // reset-password revoca TODAS las sesiones: no se puede autologuear.
          // Hay que mandar al login sí o sí.
          this.done.set(true);
          this.loading.set(false);
          setTimeout(() => void this.router.navigate(['/login']), 2500);
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.loading.set(false);
        },
      });
  }
}
