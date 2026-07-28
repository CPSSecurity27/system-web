import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  AlarmEvent,
  EventOrigin,
  EventResponse,
  EventScope,
  EventStatus,
  Paginated,
} from '../models/api.models';

export interface FindEvents {
  neighborhoodId?: number;
  status?: EventStatus;
  limit?: number;
  offset?: number;
}

/** Alta manual desde el panel. El servicio de alarmas NO pasa por acá. */
export interface CreateEvent {
  neighborhoodId: number;
  origin: EventOrigin;
  scope?: EventScope;
  deviceId?: number;
  homeId?: number;
  remoteId?: number;
  triggerMode?: string;
}

/**
 * El tablero del monitoreo (NUEVO en v2). Los eventos son APPEND-ONLY e
 * ILIMITADOS; la única mutación permitida es la resolución. El `id` es string
 * (bigint): no convertirlo a number.
 */
@Injectable({ providedIn: 'root' })
export class EventsService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  list(query: FindEvents = {}): Observable<Paginated<AlarmEvent>> {
    const params: Record<string, string | number> = {};
    if (query.neighborhoodId) params['neighborhoodId'] = query.neighborhoodId;
    if (query.status) params['status'] = query.status;
    if (query.limit !== undefined) params['limit'] = query.limit;
    if (query.offset !== undefined) params['offset'] = query.offset;
    return this.http.get<Paginated<AlarmEvent>>(`${this.api}/events`, { params });
  }

  get(id: string): Observable<AlarmEvent> {
    return this.http.get<AlarmEvent>(`${this.api}/events/${id}`);
  }

  create(event: CreateEvent): Observable<AlarmEvent> {
    return this.http.post<AlarmEvent>(`${this.api}/events`, event);
  }

  /** El MONITOR (o ADMIN/OWNER) cierra el evento: resuelto o falsa alarma. */
  resolve(id: string, status: 'RESOLVED' | 'FALSE_ALARM'): Observable<AlarmEvent> {
    return this.http.patch<AlarmEvent>(`${this.api}/events/${id}/resolve`, { status });
  }

  /** "Estoy yendo": una respuesta por persona. */
  respond(id: string, note?: string): Observable<EventResponse> {
    return this.http.post<EventResponse>(`${this.api}/events/${id}/responses`, {
      ...(note ? { note } : {}),
    });
  }
}
