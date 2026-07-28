import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { forkJoin, switchMap } from 'rxjs';

import { HomesService } from '../../core/api/homes.service';
import { UsersService } from '../../core/api/users.service';
import { AuthService } from '../../core/auth/auth.service';
import { HomeMemberRole } from '../../core/auth/auth.models';
import { apiErrorMessage } from '../../core/http/api-error';
import { Home, HomeMember } from '../../core/models/api.models';

/**
 * Los MIEMBROS del hogar (nuevo en v2): un TITULAR y sus FAMILIARES, hasta el
 * cupo del barrio. Reemplaza a las cuentas HOME del modelo viejo.
 *
 * El vecino se crea con EMAIL (v2.1: SMS/WhatsApp salían caros y no hay
 * proveedor contratado): nace sin contraseña y recibe un mail para activar
 * la cuenta y elegirla. El DNI queda como dato opcional. Las reglas duras
 * (titular único, cupo, titular no borrable) las impone el backend — acá
 * solo se muestran sus mensajes.
 */
@Component({
  selector: 'app-home-members',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './home-members.html',
})
export class HomeMembers {
  private readonly homes = inject(HomesService);
  private readonly users = inject(UsersService);
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

  /**
   * Alta de vecino + membresía en un paso: nombre + email (obligatorio, activa
   * la cuenta por mail), DNI opcional. Sin contraseña: la fija el vecino.
   */
  protected readonly form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
    dni: ['', Validators.pattern(/^\d{7,9}$/)],
    telephone: [''],
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

    // Dos pasos: crear al vecino (email, sin password) y sumarlo al hogar.
    this.users
      .create({
        name: value.name,
        email: value.email,
        dni: value.dni.trim() ? value.dni.trim() : undefined,
        telephone: value.telephone.trim() ? value.telephone.trim() : undefined,
      })
      .pipe(switchMap((user) => this.homes.addMember(this.id, user.id, value.role)))
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.form.reset({ name: '', email: '', dni: '', telephone: '', role: 'FAMILIAR' });
          this.reloadMembers();
        },
        error: (err) => {
          // 400 del cupo de familiares (mensaje comercial) o 409 de titular
          // repetido: se muestran tal cual.
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
