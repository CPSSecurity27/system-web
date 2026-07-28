import { HttpClient } from '@angular/common/http';
import { Component, effect, inject, signal } from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';

import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const password = group.get('newPassword')?.value;
  const repeat = group.get('repeat')?.value;
  return password && repeat && password !== repeat ? { mismatch: true } : null;
}

@Component({
  selector: 'app-profile',
  imports: [ReactiveFormsModule],
  templateUrl: './profile.html',
})
export class Profile {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  protected readonly auth = inject(AuthService);

  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Estado del mail de verificación: 'sent' tras el 202. */
  protected readonly verificationSent = signal(false);
  protected readonly sendingVerification = signal(false);

  protected readonly form = this.fb.nonNullable.group(
    {
      currentPassword: ['', Validators.required],
      newPassword: ['', [Validators.required, Validators.minLength(8)]],
      repeat: ['', Validators.required],
      // Sin validators fijos: se activan solo mientras hay clave TEMPORAL
      // pendiente (ver el effect más abajo) — es el único momento garantizado
      // en que un OWNER institucional recién creado pasa por acá.
      email: [''],
    },
    { validators: passwordsMatch },
  );

  constructor() {
    effect(() => {
      const emailControl = this.form.controls.email;
      if (this.auth.mustChangePassword()) {
        emailControl.setValidators([Validators.required, Validators.email]);
      } else {
        emailControl.clearValidators();
      }
      emailControl.updateValueAndValidity();
    });
  }

  /**
   * change-password exige la contraseña ACTUAL (un access token robado no alcanza
   * para secuestrar la cuenta) y revoca TODAS las sesiones, incluida esta.
   *
   * Por eso, si sale bien, no hay nada que "actualizar" en pantalla: hay que
   * mandar al login. No es un bug, es lo que hace que cambiar la clave sirva
   * de algo.
   */
  protected submit(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const { currentPassword, newPassword, email } = this.form.getRawValue();

    this.saving.set(true);
    this.error.set(null);

    this.http
      .post(`${environment.apiUrl}/auth/change-password`, {
        currentPassword,
        newPassword,
        // Vacío no se manda: @IsOptional() del backend deja pasar "ausente",
        // no una string vacía, que le fallaría a @IsEmail.
        ...(email ? { email } : {}),
      })
      .subscribe({
        next: () => this.auth.forceLogout(),
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }

  /** Cierra la sesión en todos los dispositivos. */
  protected logoutAll(): void {
    this.auth.logoutAll().subscribe();
  }

  /** Manda el mail con el link de verificación (24 h, un solo uso). */
  protected requestVerification(): void {
    if (this.sendingVerification()) return;

    this.sendingVerification.set(true);
    this.error.set(null);

    this.http.post(`${environment.apiUrl}/auth/request-email-verification`, {}).subscribe({
      next: () => {
        this.verificationSent.set(true);
        this.sendingVerification.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.sendingVerification.set(false);
      },
    });
  }
}
