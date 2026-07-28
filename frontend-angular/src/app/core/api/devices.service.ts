import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { Device, DeviceState, DeviceType, Maintenance } from '../models/api.models';

/**
 * Alta = FÁBRICA (solo CPS). Sin neighborhoodId el equipo nace en INVENTORY
 * con claim code; con organizationId nace directo en el stock de esa org.
 */
export interface CreateDevice {
  serial: string;
  name?: string;
  type?: DeviceType;
  organizationId?: number;
  neighborhoodId?: number;
  tested?: boolean;
}

/** Instalación por reclamo: serial + código de UN SOLO USO → queda en el barrio. */
export interface ClaimDevice {
  serial: string;
  claimCode: string;
  neighborhoodId: number;
  name?: string;
  latitude?: number;
  longitude?: number;
}

@Injectable({ providedIn: 'root' })
export class DevicesService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  /** Las INSTALADAS, ya filtradas por alcance. El stock va por inventory(). */
  list(neighborhoodId?: number): Observable<Device[]> {
    return this.http.get<Device[]>(`${this.api}/devices`, {
      params: neighborhoodId ? { neighborhoodId } : {},
    });
  }

  /** CPS: todo el stock; organización: SU stock. */
  inventory(): Observable<Device[]> {
    return this.http.get<Device[]>(`${this.api}/devices/inventory`);
  }

  get(id: number): Observable<Device> {
    return this.http.get<Device>(`${this.api}/devices/${id}`);
  }

  /**
   * Estado VIVO (online / disparada). null hasta que exista el servicio de
   * alarmas: mostrar "sin datos", no inventar.
   */
  state(id: number): Observable<DeviceState | null> {
    return this.http.get<DeviceState | null>(`${this.api}/devices/${id}/state`);
  }

  /** Solo CPS (fabricación). El serial repetido da 409. */
  create(device: CreateDevice): Observable<Device> {
    return this.http.post<Device>(`${this.api}/devices`, device);
  }

  /** El técnico (CPS o de la org dueña del stock) vincula el equipo a SU barrio. */
  claim(claim: ClaimDevice): Observable<Device> {
    return this.http.post<Device>(`${this.api}/devices/claim`, claim);
  }

  /** Entrega del lote: fábrica → stock de una organización (null = devolver). */
  deliverToOrganization(id: number, organizationId: number | null): Observable<Device> {
    return this.http.patch<Device>(`${this.api}/devices/${id}`, { organizationId });
  }

  /** Bitácora del técnico. */
  maintenances(deviceId: number): Observable<Maintenance[]> {
    return this.http.get<Maintenance[]>(`${this.api}/devices/${deviceId}/maintenances`);
  }
}
