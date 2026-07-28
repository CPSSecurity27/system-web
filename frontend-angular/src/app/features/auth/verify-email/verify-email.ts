import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';
import { apiErrorMessage } from '../../../core/http/api-error';
import { AuthService } from '../../../core/auth/auth.service';

/**
 * El link del mail cae acá: /verify-email?token=...
 *
 * Verificar el correo NO es requisito para entrar: habilita cosas puntuales
 * (recuperar la clave, recibir avisos). Por eso no hay guard: el link tiene
 * que funcionar logueado o no, en cualquier dispositivo. Lo que autentica es
 * el token (24 h, un solo uso), no la sesión.
 */
@Component({
  selector: 'app-verify-email',
  imports: [RouterLink],
  templateUrl: './verify-email.html',
})
export class VerifyEmail {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  protected readonly auth = inject(AuthService);

  protected readonly token = this.route.snapshot.queryParamMap.get('token');

  protected readonly done = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    // Sin formulario no hay nada que tipear: se verifica al entrar.
    if (this.token) {
      this.http.post(`${environment.apiUrl}/auth/verify-email`, { token: this.token }).subscribe({
        next: () => this.done.set(true),
        error: (err) => this.error.set(apiErrorMessage(err)),
      });
    }
  }
}
