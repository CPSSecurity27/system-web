import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  BoardModel,
  Device,
  DeviceState,
  DeviceType,
  InstallationData,
  Maintenance,
} from '../models/api.models';

/**
 * Alta = FÁBRICA (solo CPS). Sin neighborhoodId el equipo nace en INVENTORY
 * con claim code; con organizationId nace directo en el stock de esa org.
 *
 * NO lleva `serial`: se deriva de la MAC del lado del backend. Los dos datos
 * obligatorios se LEEN de la placa en la estación de flasheo.
 */
export interface CreateDevice {
  /** Como la devuelve `esptool read_mac`. Con o sin ":" da igual. */
  mac: string;
  /** El número impreso en la placa, completo: `ALOY0043`. */
  boardNumber: string;
  name?: string;
  type?: DeviceType;
  organizationId?: number;
  neighborhoodId?: number;
  tested?: boolean;
}

/** Instalación por reclamo: serial + código de UN SOLO USO → queda en el barrio. */
/**
 * El reclamo instala el equipo en un barrio. Lo hace un técnico —de CPS o de la
 * organización dueña del stock— con el serial y el código de un solo uso.
 *
 * Lleva los datos de instalación porque el mejor momento para cargarlos es
 * cuando el técnico está parado abajo del poste.
 */
export interface ClaimDevice extends InstallationData {
  serial: string;
  claimCode: string;
  neighborhoodId: number;
  name?: string;
  latitude?: number;
  longitude?: number;
}

/** Entrega de LOTE: fábrica → organización, en una sola llamada. Solo CPS. */
export interface DeliverDevices {
  deviceIds: number[];
  /** null = vuelve al stock de fábrica. */
  organizationId: number | null;
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

  /** Modelos de placa: el desplegable / la referencia de prefijos válidos. */
  boardModels(): Observable<BoardModel[]> {
    return this.http.get<BoardModel[]>(`${this.api}/devices/board-models`);
  }

  /** Solo CPS (fabricación). MAC o número de placa repetidos dan 409. */
  create(device: CreateDevice): Observable<Device> {
    return this.http.post<Device>(`${this.api}/devices`, device);
  }

  /**
   * Hitos de fábrica (solo CPS). `true` sella el hito con la hora del
   * servidor, `false` lo borra. La fecha nunca la manda el cliente.
   *
   * Marcar la primera conexión a mano queda registrado como MANUAL y auditado:
   * lo normal es que lo informe el servicio de alarmas, y esto es la muleta
   * hasta que exista.
   */
  updateMilestones(
    id: number,
    milestones: { labeled?: boolean; connected?: boolean },
  ): Observable<Device> {
    return this.http.patch<Device>(`${this.api}/devices/${id}/milestones`, milestones);
  }

  /** El técnico (CPS o de la org dueña del stock) vincula el equipo a SU barrio. */
  claim(claim: ClaimDevice): Observable<Device> {
    return this.http.post<Device>(`${this.api}/devices/claim`, claim);
  }

  /**
   * ENTREGA DE LOTE: fábrica → stock de una organización (null = devolver).
   *
   * Una sola llamada para N equipos: antes era un PATCH por equipo, y con 50
   * alarmas cualquier falla dejaba el lote a medio entregar.
   */
  deliver(dto: DeliverDevices): Observable<{ delivered: number }> {
    return this.http.post<{ delivered: number }>(`${this.api}/devices/deliver`, dto);
  }

  /** Bitácora del técnico. */
  maintenances(deviceId: number): Observable<Maintenance[]> {
    return this.http.get<Maintenance[]>(`${this.api}/devices/${deviceId}/maintenances`);
  }
}
