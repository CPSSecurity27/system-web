import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { HomesService } from '../../core/api/homes.service';
import { RemotesService } from '../../core/api/remotes.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Home, HomeMember, Remote, RemoteCode } from '../../core/models/api.models';

@Component({
  selector: 'app-remote-list',
  imports: [RouterLink, FormsModule],
  templateUrl: './remote-list.html',
})
export class RemoteList {
  private readonly remotes = inject(RemotesService);
  private readonly homes = inject(HomesService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly auth = inject(AuthService);

  protected readonly items = signal<Remote[]>([]);
  protected readonly homeList = signal<Home[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected filter: number | '' = '';

  /** Entrega desde el stock: a qué vivienda va el control abierto. */
  protected assignHomeId: number | '' = '';

  /** Códigos del control abierto. Solo posición y fecha: el valor NO viene acá. */
  protected readonly openRemoteId = signal<number | null>(null);
  protected readonly codes = signal<RemoteCode[]>([]);
  protected readonly loadingCodes = signal(false);

  /** Alta de código RF (solo CPS): posición 1..4, se cifra en el backend. */
  protected newCode = '';
  protected newCodePosition: number | '' = '';

  /**
   * Cambio de PORTADOR del control abierto. El portador debe ser miembro del
   * hogar dueño; los candidatos se cargan recién al abrir el panel.
   */
  protected readonly carrierRemoteId = signal<number | null>(null);
  protected readonly carrierMembers = signal<HomeMember[]>([]);
  protected readonly loadingMembers = signal(false);
  protected carrierUserId: number | '' = '';

  /**
   * Código revelado, en memoria y de a UNO. Se borra al cerrar el panel o al
   * revelar otro. No se cachea, no se loguea, no va a ningún estado global:
   * es material sensible y su dueño es el backend, no la UI.
   */
  protected readonly revealed = signal<{ codeId: number; code: string } | null>(null);

  constructor() {
    const homeId = this.route.snapshot.queryParamMap.get('homeId');
    this.filter = homeId ? Number(homeId) : '';

    forkJoin({
      remotes: this.remotes.list(this.filter === '' ? undefined : Number(this.filter)),
      homes: this.homes.list(),
    }).subscribe({
      next: ({ remotes, homes }) => {
        this.items.set(remotes);
        this.homeList.set(homes);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected onFilterChange(): void {
    void this.router.navigate([], {
      queryParams: this.filter === '' ? {} : { homeId: this.filter },
    });

    this.loading.set(true);
    this.closeCodes();
    this.reload();
  }

  private reload(): void {
    this.remotes.list(this.filter === '' ? undefined : Number(this.filter)).subscribe({
      next: (remotes) => {
        this.items.set(remotes);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  /** Entrega física: control en INVENTORY → una vivienda. El dueño ya no cambia. */
  protected assign(remote: Remote): void {
    if (this.assignHomeId === '' || this.saving()) {
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    this.remotes.assign(remote.id, Number(this.assignHomeId)).subscribe({
      next: () => {
        this.saving.set(false);
        this.assignHomeId = '';
        this.loading.set(true);
        this.reload();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  /** Abre el selector de portador con los miembros del hogar dueño. */
  protected toggleCarrier(remote: Remote): void {
    if (this.carrierRemoteId() === remote.id || remote.homeId === null) {
      this.closeCarrier();
      return;
    }

    this.carrierRemoteId.set(remote.id);
    this.carrierUserId = remote.assignedToUserId ?? '';
    this.carrierMembers.set([]);
    this.loadingMembers.set(true);

    this.homes.members(remote.homeId).subscribe({
      next: (members) => {
        this.carrierMembers.set(members.filter((m) => m.status === 'ACTIVE'));
        this.loadingMembers.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loadingMembers.set(false);
      },
    });
  }

  protected closeCarrier(): void {
    this.carrierRemoteId.set(null);
    this.carrierMembers.set([]);
    this.carrierUserId = '';
  }

  /** Reasigna el portador ('' = queda en la casa, sin portador). */
  protected saveCarrier(remote: Remote): void {
    if (this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    const userId = this.carrierUserId === '' ? null : Number(this.carrierUserId);
    this.remotes.reassign(remote.id, userId).subscribe({
      next: () => {
        this.saving.set(false);
        this.closeCarrier();
        this.loading.set(true);
        this.reload();
      },
      error: (err) => {
        // 400: el elegido no es miembro del hogar.
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  protected toggleCodes(remote: Remote): void {
    if (this.openRemoteId() === remote.id) {
      this.closeCodes();
      return;
    }

    this.openRemoteId.set(remote.id);
    this.revealed.set(null);
    this.codes.set([]);
    this.loadingCodes.set(true);

    this.remotes.codes(remote.id).subscribe({
      next: (codes) => {
        this.codes.set(codes);
        this.loadingCodes.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loadingCodes.set(false);
      },
    });
  }

  protected closeCodes(): void {
    this.openRemoteId.set(null);
    this.codes.set([]);
    this.revealed.set(null);
    this.newCode = '';
    this.newCodePosition = '';
  }

  /** Solo CPS. El código viaja en claro únicamente en este POST. */
  protected addCode(): void {
    const remoteId = this.openRemoteId();
    if (!remoteId || !this.newCode || this.newCodePosition === '' || this.saving()) {
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    this.remotes.addCode(remoteId, this.newCode, Number(this.newCodePosition)).subscribe({
      next: () => {
        this.saving.set(false);
        this.newCode = '';
        this.newCodePosition = '';
        this.remotes.codes(remoteId).subscribe((codes) => this.codes.set(codes));
      },
      error: (err) => {
        // 400: posición fuera de 1..4 o ya ocupada.
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  /** El único endpoint que descifra un código. Solo CPS, de a uno, auditado. */
  protected reveal(codeId: number): void {
    const remoteId = this.openRemoteId();
    if (!remoteId) {
      return;
    }

    this.remotes.reveal(remoteId, codeId).subscribe({
      next: ({ code }) => this.revealed.set({ codeId, code }),
      error: (err) => this.error.set(apiErrorMessage(err)),
    });
  }

  protected hide(): void {
    this.revealed.set(null);
  }

  protected homeName(id: number | null): string {
    if (id === null) return 'En stock';
    return this.homeList().find((h) => h.id === id)?.address ?? `Vivienda #${id}`;
  }
}
