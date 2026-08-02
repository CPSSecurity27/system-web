import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { HomesService } from '../../core/api/homes.service';
import { AuthService } from '../../core/auth/auth.service';
import { HomeMemberRole } from '../../core/auth/auth.models';
import { apiErrorMessage } from '../../core/http/api-error';
import { Home, HomeMember } from '../../core/models/api.models';

/**
 * Los MIEMBROS del hogar (nuevo en v2): un TITULAR y sus FAMILIARES, hasta el
 * cupo del barrio. Reemplaza a las cuentas HOME del modelo viejo.
 *
 * v2.3 (2026-08-02): el vecino se crea con NOMBRE + DNI — el DNI es su
 * identidad de login en la app. El email quedó como dato opcional (si está,
 * le llega un mail de activación como atajo). Nace sin contraseña: la fija él
 * la primera vez, y hasta entonces la lista lo muestra "sin activar".
 *
 * El alta es UNA sola llamada (`addPerson`): la persona y la membresía se
 * crean juntas en el backend, en una transacción. Las reglas duras (titular
 * único, una persona una casa, cupo, titular no borrable) las impone el
 * backend — acá solo se muestran sus mensajes.
 */
@Component({
  selector: 'app-home-members',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './home-members.html',
})
export class HomeMembers {
  private readonly homes = inject(HomesService);
  private readonly route = inject(ActivatedRoute);
  private readonly fb = inject(FormBuilder);
  protected readonly auth = inject(AuthService);

  protected readonly id = Number(this.route.snapshot.paramMap.get('id'));

  protected readonly home = signal<Home | null>(null);
  protected readonly members = signal<HomeMember[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly titular = computed(
    () => this.members().find((m) => m.role === 'TITULAR') ?? null,
  );
  protected readonly hasTitular = computed(() => this.titular() !== null);

  /** Datos opcionales plegados: el alta normal es nombre + DNI y listo. */
  protected readonly verOpcionales = signal(false);

  /**
   * Alta de vecino + membresía en UNA llamada: nombre + DNI (su login),
   * el resto opcional. Sin contraseña: la fija el vecino.
   */
  protected readonly form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    dni: ['', [Validators.required, Validators.pattern(/^\d{7,9}$/)]],
    telephone: [''],
    birthDate: [''],
    email: ['', Validators.email],
    role: ['FAMILIAR' as HomeMemberRole, Validators.required],
  });

  constructor() {
    this.load();
  }

  private load(): void {
    this.loading.set(true);

    forkJoin({
      home: this.homes.get(this.id),
      members: this.homes.members(this.id),
    }).subscribe({
      next: ({ home, members }) => {
        this.home.set(home);
        this.members.set(members);
        // El primer miembro de una casa vacía es, naturalmente, el titular.
        if (!members.some((m) => m.role === 'TITULAR')) {
          this.form.controls.role.setValue('TITULAR');
        }
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  private reloadMembers(): void {
    this.homes.members(this.id).subscribe((members) => this.members.set(members));
  }

  protected addMember(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();

    this.saving.set(true);
    this.error.set(null);

    // UNA llamada: el backend crea la persona y la membresía en la misma
    // transacción. Antes eran dos, y un fallo en la segunda dejaba un vecino
    // suelto en el padrón sin casa.
    this.homes
      .addPerson(
        this.id,
        {
          name: value.name.trim(),
          dni: value.dni.trim(),
          telephone: value.telephone.trim() || undefined,
          birthDate: value.birthDate.trim() || undefined,
          email: value.email.trim() || undefined,
        },
        value.role,
      )
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.form.reset({
            name: '',
            dni: '',
            telephone: '',
            birthDate: '',
            email: '',
            role: 'FAMILIAR',
          });
          this.reloadMembers();
        },
        error: (err) => {
          // 400 del cupo de familiares (mensaje comercial) o 409 de DNI ya
          // cargado en otra vivienda: se muestran tal cual, dicen dónde está.
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }

  protected toggleSuspension(member: HomeMember): void {
    if (this.saving()) return;

    const status = member.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';

    this.saving.set(true);
    this.error.set(null);

    this.homes.updateMemberStatus(this.id, member.userId, status).subscribe({
      next: () => {
        this.saving.set(false);
        this.reloadMembers();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  /** Solo gestores: el backend valida; acá el botón ni se muestra al vecino. */
  protected makeTitular(member: HomeMember): void {
    if (member.role === 'TITULAR' || this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    this.homes.transferTitular(this.id, member.userId).subscribe({
      next: (members) => {
        this.saving.set(false);
        this.members.set(members);
      },
      error: (err) => {
        // 400 (suspendido) o 409 (ya es titular de otro hogar): tal cual.
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  protected removeMember(member: HomeMember): void {
    // Al TITULAR no se lo borra: se transfiere (operación pendiente).
    if (member.role === 'TITULAR' || this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    this.homes.removeMember(this.id, member.userId).subscribe({
      next: () => {
        this.saving.set(false);
        this.reloadMembers();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }
}
