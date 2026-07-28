import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';
import { apiErrorMessage } from '../../../core/http/api-error';

@Component({
  selector: 'app-forgot-password',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './forgot-password.html',
})
export class ForgotPassword {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);

  protected readonly loading = signal(false);
  protected readonly sent = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  /**
   * El backend responde 202 SIEMPRE, exista o no el correo — si devolviera 404
   * sería un buscador gratuito de quién tiene cuenta. El front tampoco puede
   * saber si el mail salió: por eso el mensaje de éxito es deliberadamente
   * ambiguo ("si el correo existe..."). No lo hagas más específico.
   */
  protected submit(): void {
    if (this.form.invalid || this.loading()) {
      this.form.markAllAsTouched();
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    this.http
      .post(`${environment.apiUrl}/auth/forgot-password`, this.form.getRawValue())
      .subscribe({
        next: () => {
          this.sent.set(true);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.loading.set(false);
        },
      });
  }
}
