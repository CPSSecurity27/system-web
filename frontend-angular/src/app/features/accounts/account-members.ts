import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { forkJoin, Observable, of, switchMap } from 'rxjs';

import { AccountsService } from '../../core/api/accounts.service';
import { ContractsService } from '../../core/api/contracts.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { UsersService } from '../../core/api/users.service';
import { AuthService } from '../../core/auth/auth.service';
import { UserRole } from '../../core/auth/auth.models';
import { apiErrorMessage } from '../../core/http/api-error';
import { Account, Contract, ContractStatus, Member, User } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';
import { Alert } from '../../shared/ui/alert/alert';

/**
 * Miembros, cupos y CONTRATO de una cuenta. Se monta en TRES rutas:
 *
 *   /clientes/:id      -> la ficha de un cliente (la de siempre)
 *   /empresa/personal  -> el personal de CPS, sin `:id`
 *   /mi-organizacion   -> la ficha del PROPIO cliente, sin `:id`
 *
 * Es el mismo trabajo sobre la misma tabla, así que es el mismo componente:
 * duplicarlo habría dejado tres pantallas que hay que acordarse de tocar
 * juntas. Lo único que cambia es de dónde sale el id — de la ruta, o de la
 * sesión cuando la ruta no lo trae.
 */
@Component({
  selector: 'app-account-members',
  imports: [CurrencyPipe, DatePipe, ReactiveFormsModule, RouterLink, Alert],
  templateUrl: './account-members.html',
})
export class AccountMembers {
  private readonly accounts = inject(AccountsService);
  private readonly contractsApi = inject(ContractsService);
  private readonly neighborhoods = inject(NeighborhoodsService);
  private readonly users = inject(UsersService);
  private readonly route = inject(ActivatedRoute);
  private readonly fb = inject(FormBuilder);
  protected readonly auth = inject(AuthService);

  private readonly routeId = this.route.snapshot.paramMap.get('id');
  /** Sin `:id`: o es Mi Empresa (CPS) o es Mi organización (el cliente). */
  protected readonly isOwnAccountView = this.routeId === null;
  /** Mi Empresa: solo cuando el que mira ES CPS. Cambia el volver y los títulos. */
  protected readonly isCompanyView = this.isOwnAccountView && this.auth.isCps();

  protected readonly id = this.routeId
    ? Number(this.routeId)
    : ((this.auth.isCps() ? this.auth.companyAccountId() : this.auth.organizationAccountId()) ?? 0);

  protected readonly account = signal<Account | null>(null);
  protected readonly members = signal<Member[]>([]);
  protected readonly allUsers = signal<User[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly savingQuotas = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly quotasMessage = signal<string | null>(null);

  /**
   * CONTRATOS de esta cuenta. Acá viven desde que dejaron de ser pestaña
   * (2026-07-31): el contrato es de la cuenta, uno ACTIVE por cliente, así que
   * una lista aparte era la lista de clientes con otras columnas.
   */
  protected readonly contracts = signal<Contract[]>([]);
  protected readonly savingContract = signal(false);
  protected readonly showRenew = signal(false);

  /** El vigente. Puede no haber: un contrato vencido o cancelado deja la cuenta sin ACTIVE. */
  protected readonly activeContract = computed(
    () => this.contracts().find((c) => c.status === 'ACTIVE') ?? null,
  );

  /** Los cerrados, del más nuevo al más viejo: el historial comercial. */
  protected readonly pastContracts = computed(() =>
    this.contracts().filter((c) => c.status !== 'ACTIVE'),
  );

  protected readonly renewForm = this.fb.nonNullable.group({
    price: [null as number | null, [Validators.required, Validators.min(0)]],
    startDate: ['', Validators.required],
    endDate: ['', Validators.required],
    description: [''],
  });

  /**
   * OWNER no se ofrece: es el usuario institucional, único, y nace con la
   * cuenta. Los otros tres están sujetos a CUPO; si el cupo es 0 la cuenta
   * directamente no tiene ese rol y no se ofrece (ver availableRoles).
   */
  protected readonly roles: UserRole[] = ['ADMIN', 'TECHNICIAN', 'MONITOR'];

  /** Cupo contratado para un rol. null = no aplica (COMPANY: CPS no se cobra cupos). */
  protected roleQuota(role: UserRole): number | null {
    const account = this.account();
    if (!account) return null;
    switch (role) {
      case 'ADMIN':
        return account.maxAdminUsers;
      case 'TECHNICIAN':
        return account.maxTechnicianUsers;
      case 'MONITOR':
        return account.maxMonitorUsers;
      default:
        return null;
    }
  }

  protected roleUsed(role: UserRole): number {
    return this.members().filter((m) => m.role === role).length;
  }

  /**
   * Los roles que esta cuenta PUEDE tener. Cupo 0 = el plan no incluye ese
   * rol, así que ni se ofrece: el backend lo rechazaría con un 400 y ofrecer
   * una opción que siempre falla es peor que no ofrecerla.
   *
   * Cupo AGOTADO es distinto: el rol sigue en la lista (la cuenta lo tiene
   * contratado) y el 400 explica que hay que ampliar. Eso es información útil;
   * esconder la opción escondería el motivo.
   */
  protected readonly availableRoles = computed(() =>
    this.roles.filter((role) => this.roleQuota(role) !== 0),
  );

  /** Ya miembros: no tiene sentido ofrecerlos de nuevo. */
  protected readonly candidates = computed(() => {
    const taken = new Set(this.members().map((m) => m.userId));
    // Los vecinos (sin username) no van a cuentas: son miembros de hogar.
    return this.allUsers().filter((u) => !taken.has(u.id) && u.username !== null);
  });

  /** Sumar persona EXISTENTE (padrón, solo CPS). */
  protected readonly form = this.fb.group({
    userId: [null as number | null, Validators.required],
    role: ['ADMIN' as UserRole, Validators.required],
  });

  /** Crear persona nueva del panel + sumarla, en un paso (autogestión). */
  protected readonly createForm = this.fb.nonNullable.group({
    name: ['', Validators.required],
    username: ['', [Validators.required, Validators.minLength(3)]],
    password: ['', [Validators.required, Validators.minLength(8)]],
    role: ['ADMIN' as UserRole, Validators.required],
  });

  /**
   * Cupos: solo CPS. Son la tarifa. Barrios no admite "sin límite" ni 0; los
   * de personal SÍ admiten 0, que quiere decir "esta cuenta no tiene ese rol".
   */
  protected readonly quotasForm = this.fb.group({
    maxNeighborhoods: [null as number | null, [Validators.required, Validators.min(1)]],
    maxAdminUsers: [null as number | null, [Validators.required, Validators.min(0)]],
    maxTechnicianUsers: [null as number | null, [Validators.required, Validators.min(0)]],
    maxMonitorUsers: [null as number | null, [Validators.required, Validators.min(0)]],
  });

  /**
   * Asignaciones por barrio (staff_assignment), solo para TECHNICIAN/MONITOR:
   * sin barrios tildados el miembro ve TODA su organización; con barrios, solo
   * esos. Los barrios de la organización se cargan una vez.
   */
  protected readonly orgBarrios = signal<Neighborhood[]>([]);
  protected readonly assignmentsMember = signal<Member | null>(null);
  protected readonly loadingAssignments = signal(false);
  protected readonly assignedIds = signal<Set<number>>(new Set());

  constructor() {
    this.load();
  }

  private load(): void {
    this.loading.set(true);

    forkJoin({
      account: this.accounts.get(this.id),
      members: this.accounts.members(this.id),
    }).subscribe({
      next: ({ account, members }) => {
        this.account.set(account);
        this.members.set(members);
        this.quotasForm.reset({
          maxNeighborhoods: account.maxNeighborhoods,
          maxAdminUsers: account.maxAdminUsers,
          maxTechnicianUsers: account.maxTechnicianUsers,
          maxMonitorUsers: account.maxMonitorUsers,
        });
        // Una organización comunitaria gestiona un único barrio: el backend lo
        // rechaza si se intenta cambiar, así que ni se ofrece editarlo.
        if (account.subtype === 'COMMUNITY') {
          this.quotasForm.controls.maxNeighborhoods.disable();
        } else {
          this.quotasForm.controls.maxNeighborhoods.enable();
        }
        this.loading.set(false);

        // Para asignar personal por barrio hacen falta los barrios de la org.
        if (account.type === 'ORGANIZATION') {
          this.neighborhoods.list().subscribe({
            next: (barrios) =>
              this.orgBarrios.set(barrios.filter((b) => b.organizationId === this.id)),
            error: () => this.orgBarrios.set([]),
          });
        }

        // El padrón completo es solo de CPS: el 403 no rompe la pantalla.
        if (this.auth.isCps()) {
          this.users.list().subscribe({
            next: (users) => this.allUsers.set(users),
            error: () => this.allUsers.set([]),
          });
        }

        // CPS no contrata (es quien presta el servicio): no tiene contratos.
        if (account.type === 'ORGANIZATION') this.loadContracts();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  /** El backend ya recorta por alcance: una organización solo ve los suyos. */
  private loadContracts(): void {
    this.contracts.set([]);
    this.contractsApi.list().subscribe({
      next: (all) => this.contracts.set(all.filter((c) => c.accountId === this.id)),
      error: () => this.contracts.set([]),
    });
  }

  /**
   * RENOVAR es firmar uno NUEVO, no estirar el vigente: el precio está
   * congelado y es POR EL PERÍODO, así que correr la fecha de fin abarataría el
   * servicio en silencio. El vigente se cierra primero (EXPIRED) porque la base
   * solo admite un ACTIVE por cuenta.
   */
  protected abrirRenovacion(): void {
    const vigente = this.activeContract();
    const desde = vigente
      ? this.diaSiguiente(vigente.endDate)
      : new Date().toISOString().slice(0, 10);
    this.renewForm.reset({
      price: vigente?.price ?? null,
      startDate: desde,
      endDate: '',
      description: '',
    });
    this.showRenew.set(true);
  }

  protected aplicarPlazoRenovacion(meses: number): void {
    const desde = this.renewForm.controls.startDate.value;
    if (!desde) return;
    const [a, m, d] = desde.split('-').map(Number);
    const destino = new Date(a, m - 1 + meses, 1);
    const ultimoDia = new Date(destino.getFullYear(), destino.getMonth() + 1, 0).getDate();
    destino.setDate(Math.min(d, ultimoDia));
    const mm = String(destino.getMonth() + 1).padStart(2, '0');
    const dd = String(destino.getDate()).padStart(2, '0');
    this.renewForm.controls.endDate.setValue(`${destino.getFullYear()}-${mm}-${dd}`);
  }

  private diaSiguiente(fecha: string): string {
    const [a, m, d] = fecha.split('-').map(Number);
    const siguiente = new Date(a, m - 1, d + 1);
    const mm = String(siguiente.getMonth() + 1).padStart(2, '0');
    const dd = String(siguiente.getDate()).padStart(2, '0');
    return `${siguiente.getFullYear()}-${mm}-${dd}`;
  }

  protected renovar(): void {
    if (this.renewForm.invalid || this.savingContract()) {
      this.renewForm.markAllAsTouched();
      return;
    }

    const value = this.renewForm.getRawValue();
    const vigente = this.activeContract();

    this.savingContract.set(true);
    this.error.set(null);

    // Cerrar el vigente ANTES de firmar: si se hiciera al revés, el índice
    // único parcial rechazaría el nuevo con un 409.
    const cerrar: Observable<unknown> = vigente
      ? this.contractsApi.update(vigente.id, { status: 'EXPIRED' })
      : of(null);

    cerrar
      .pipe(
        switchMap(() =>
          this.contractsApi.create({
            accountId: this.id,
            price: Number(value.price),
            startDate: value.startDate,
            endDate: value.endDate,
            ...(value.description ? { description: value.description } : {}),
          }),
        ),
      )
      .subscribe({
        next: () => {
          this.savingContract.set(false);
          this.showRenew.set(false);
          this.loadContracts();
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.savingContract.set(false);
          this.loadContracts();
        },
      });
  }

  protected cambiarEstadoContrato(contract: Contract, status: ContractStatus): void {
    if (this.savingContract()) return;

    this.savingContract.set(true);
    this.error.set(null);

    this.contractsApi.update(contract.id, { status }).subscribe({
      next: () => {
        this.savingContract.set(false);
        this.loadContracts();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.savingContract.set(false);
      },
    });
  }

  private reloadMembers(): void {
    this.accounts.members(this.id).subscribe((members) => this.members.set(members));
  }

  protected addMember(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const { userId, role } = this.form.getRawValue();

    this.saving.set(true);
    this.error.set(null);

    this.accounts
      .addMember(this.id, { userId: userId as number, role: role as UserRole })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.form.reset({ userId: null, role: 'ADMIN' });
          this.reloadMembers();
        },
        error: (err) => {
          // 400 de cupo de monitores o de rol inválido: mensaje tal cual.
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }

  protected createAndAdd(): void {
    if (this.createForm.invalid || this.saving()) {
      this.createForm.markAllAsTouched();
      return;
    }

    const value = this.createForm.getRawValue();

    this.saving.set(true);
    this.error.set(null);

    this.users
      .create({ name: value.name, username: value.username, password: value.password })
      .pipe(
        switchMap((user) =>
          this.accounts.addMember(this.id, { userId: user.id, role: value.role }),
        ),
      )
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.createForm.reset({ name: '', username: '', password: '', role: 'ADMIN' });
          this.reloadMembers();
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }

  protected removeMember(member: Member): void {
    if (member.role === 'OWNER' || this.saving()) {
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    this.accounts.removeMember(this.id, member.userId).subscribe({
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

  /** ¿Este miembro puede acotarse por barrio? Solo el personal operativo. */
  protected isStaff(member: Member): boolean {
    return member.role === 'TECHNICIAN' || member.role === 'MONITOR';
  }

  protected toggleAssignments(member: Member): void {
    if (this.assignmentsMember()?.id === member.id) {
      this.closeAssignments();
      return;
    }

    this.assignmentsMember.set(member);
    this.assignedIds.set(new Set());
    this.loadingAssignments.set(true);

    this.accounts.assignments(this.id, member.userId).subscribe({
      next: (assignments) => {
        this.assignedIds.set(new Set(assignments.map((a) => a.neighborhoodId)));
        this.loadingAssignments.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loadingAssignments.set(false);
      },
    });
  }

  protected closeAssignments(): void {
    this.assignmentsMember.set(null);
    this.assignedIds.set(new Set());
  }

  protected toggleBarrio(neighborhoodId: number): void {
    this.assignedIds.update((ids) => {
      const next = new Set(ids);
      if (next.has(neighborhoodId)) next.delete(neighborhoodId);
      else next.add(neighborhoodId);
      return next;
    });
  }

  /** PUT: lo tildado es lo que queda. Nada tildado = ve toda la organización. */
  protected saveAssignments(): void {
    const member = this.assignmentsMember();
    if (!member || this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    this.accounts.setAssignments(this.id, member.userId, [...this.assignedIds()]).subscribe({
      next: () => {
        this.saving.set(false);
        this.closeAssignments();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  protected saveQuotas(): void {
    if (this.quotasForm.invalid || this.savingQuotas()) {
      this.quotasForm.markAllAsTouched();
      return;
    }

    const value = this.quotasForm.getRawValue();

    this.savingQuotas.set(true);
    this.error.set(null);
    this.quotasMessage.set(null);

    // El form ya validó que no son null (Validators.required + min).
    this.accounts
      .updateQuotas(this.id, {
        maxNeighborhoods: value.maxNeighborhoods!,
        maxAdminUsers: value.maxAdminUsers!,
        maxTechnicianUsers: value.maxTechnicianUsers!,
        maxMonitorUsers: value.maxMonitorUsers!,
      })
      .subscribe({
        next: (account) => {
          this.account.set(account);
          this.savingQuotas.set(false);
          this.quotasMessage.set('Cupos actualizados. El cambio quedó auditado.');
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.savingQuotas.set(false);
        },
      });
  }
}
