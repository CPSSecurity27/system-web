import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  BoardModel,
  Device,
  DeviceConfig,
  DeviceState,
  DeviceType,
  InstallationData,
  Maintenance,
  RedWifiRevelada,
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

/**
 * Edición del equipo ya instalado. La puede hacer CPS o la organización dueña
 * —incluido su TÉCNICO—: el que subió a la escalera tiene que poder corregir
 * el punto en el mapa sin pedirle permiso a nadie.
 *
 * Lo que queda para CPS (baja definitiva, entrega de stock, testeo) lo frena
 * el backend con un 403, no este tipo.
 */
export interface UpdateDevice extends Partial<InstallationData> {
  name?: string;
  latitude?: number;
  longitude?: number;
  installedAt?: string;
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

  /**
   * La configuración que el equipo DICE que corre (su espejo), más el estado de
   * lo que le mandamos. NUNCA trae passwords: cada red dice si tiene una.
   */
  config(id: number): Observable<DeviceConfig> {
    return this.http.get<DeviceConfig>(`${this.api}/devices/${id}/config`);
  }

  /**
   * Publica un patch. Se mergea contra el espejo POR SECCIÓN del lado del
   * servidor, así que mandar solo lo que cambió es lo correcto — y además
   * necesario: el panel acepta 1024 bytes y cada byte cuenta.
   *
   * Una red sin `psw` conserva la que ya tiene guardada.
   */
  publicarConfig(
    id: number,
    patch: Record<string, unknown>,
  ): Observable<DeviceConfig> {
    return this.http.put<DeviceConfig>(`${this.api}/devices/${id}/config`, {
      patch,
    });
  }

  /**
   * Que el equipo busque redes. El resultado NO vuelve acá: llega después por
   * su cuenta y aparece en el próximo `config()`.
   */
  pedirScan(id: number): Observable<{ mensaje: string }> {
    return this.http.post<{ mensaje: string }>(
      `${this.api}/devices/${id}/config/scan`,
      {},
    );
  }

  /** Pedirle su configuración actual. Es el desbloqueo cuando no hay espejo. */
  pedirRefresh(id: number): Observable<{ mensaje: string }> {
    return this.http.post<{ mensaje: string }>(
      `${this.api}/devices/${id}/config/refresh`,
      {},
    );
  }

  /** Las passwords en claro. Solo CPS, y queda en `audit_log`. */
  revelarWifi(id: number): Observable<RedWifiRevelada[]> {
    return this.http.post<RedWifiRevelada[]>(
      `${this.api}/devices/${id}/config/reveal-wifi`,
      {},
    );
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
   * Editar el equipo: nombre, ubicación y datos de instalación. Gestores y
   * TÉCNICOS, de CPS o de la organización dueña.
   */
  update(id: number, changes: UpdateDevice): Observable<Device> {
    return this.http.patch<Device>(`${this.api}/devices/${id}`, changes);
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
