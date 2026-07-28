import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { EventsService } from '../../core/api/events.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { AlarmEvent, EventStatus } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';

const PAGE_SIZE = 20;

/**
 * El tablero del monitoreo (NUEVO en v2): la pantalla principal del MONITOR.
 *
 * Los eventos son append-only e ilimitados; la única mutación es la
 * RESOLUCIÓN (resuelto o falsa alarma), y la hace el monitoreo. El activador
 * es un snapshot congelado: se muestra tal cual quedó al momento del evento.
 */
@Component({
  selector: 'app-event-list',
  imports: [FormsModule, DatePipe],
  templateUrl: './event-list.html',
})
export class EventList {
  private readonly events = inject(EventsService);
  private readonly neighborhoods = inject(NeighborhoodsService);
  protected readonly auth = inject(AuthService);

  protected readonly items = signal<AlarmEvent[]>([]);
  protected readonly total = signal(0);
  protected readonly offset = signal(0);
  protected readonly barrios = signal<Neighborhood[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Filtros del tablero. */
  protected filterBarrio: number | '' = '';
  protected filterStatus: EventStatus | '' = '';

  /** Alta manual (origin PANEL): registrar un llamado telefónico, por ejemplo. */
  protected readonly showCreate = signal(false);
  protected createBarrio: number | '' = '';

  protected readonly pageSize = PAGE_SIZE;
  protected readonly canPrev = computed(() => this.offset() > 0);
  protected readonly canNext = computed(() => this.offset() + PAGE_SIZE < this.total());

  /** Resolver: MONITOR, ADMIN u OWNER. El backend valida igual. */
  protected readonly canResolve = computed(() => this.auth.isMonitor() || this.auth.isManager());

  /**
   * Detalle expandido: las RESPUESTAS ("estoy yendo") viven en GET /events/:id,
   * el listado no las trae. Cualquiera con alcance puede responder, una vez.
   */
  protected readonly openEventId = signal<string | null>(null);
  protected readonly detail = signal<AlarmEvent | null>(null);
  protected readonly loadingDetail = signal(false);
  protected respondNote = '';

  constructor() {
    this.neighborhoods.list().subscribe({
      next: (barrios) => this.barrios.set(barrios),
      error: () => this.barrios.set([]),
    });
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);

    this.events
      .list({
        neighborhoodId: this.filterBarrio === '' ? undefined : Number(this.filterBarrio),
        status: this.filterStatus === '' ? undefined : this.filterStatus,
        limit: PAGE_SIZE,
        offset: this.offset(),
      })
      .subscribe({
        next: (page) => {
          this.items.set(page.items);
          this.total.set(page.total);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.loading.set(false);
        },
      });
  }

  protected onFilterChange(): void {
    this.offset.set(0);
    this.load();
  }

  protected prev(): void {
    if (!this.canPrev()) return;
    this.offset.set(Math.max(0, this.offset() - PAGE_SIZE));
    this.load();
  }

  protected next(): void {
    if (!this.canNext()) return;
    this.offset.set(this.offset() + PAGE_SIZE);
    this.load();
  }

  protected resolve(event: AlarmEvent, status: 'RESOLVED' | 'FALSE_ALARM'): void {
    if (this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    this.events.resolve(event.id, status).subscribe({
      next: () => {
        this.saving.set(false);
        this.load();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  protected create(): void {
    if (this.createBarrio === '' || this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    this.events
      .create({
        neighborhoodId: Number(this.createBarrio),
        origin: 'PANEL',
        scope: 'COMMUNITY',
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.showCreate.set(false);
          this.createBarrio = '';
          this.offset.set(0);
          this.load();
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }

  protected toggleDetail(event: AlarmEvent): void {
    if (this.openEventId() === event.id) {
      this.closeDetail();
      return;
    }

    this.openEventId.set(event.id);
    this.detail.set(null);
    this.respondNote = '';
    this.loadingDetail.set(true);

    this.events.get(event.id).subscribe({
      next: (detail) => {
        this.detail.set(detail);
        this.loadingDetail.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loadingDetail.set(false);
      },
    });
  }

  protected closeDetail(): void {
    this.openEventId.set(null);
    this.detail.set(null);
    this.respondNote = '';
  }

  /** "Estoy yendo": idempotente en el backend (una respuesta por persona). */
  protected respond(): void {
    const id = this.openEventId();
    if (!id || this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    const note = this.respondNote.trim();
    this.events.respond(id, note ? note : undefined).subscribe({
      next: () => {
        this.saving.set(false);
        this.respondNote = '';
        this.events.get(id).subscribe((detail) => this.detail.set(detail));
      },
      error: (err) => {
        // 400: el evento ya está cerrado.
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  /** ¿El usuario logueado ya respondió a este evento? */
  protected alreadyResponded(): boolean {
    const me = this.auth.user()?.id;
    return !!me && (this.detail()?.responses ?? []).some((r) => r.userId === me);
  }

  protected barrioName(id: number): string {
    return this.barrios().find((b) => b.id === id)?.name ?? `Barrio #${id}`;
  }
}
