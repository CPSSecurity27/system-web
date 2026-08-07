import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  BoardModel,
  ColaComandos,
  Device,
  DeviceConfig,
  DeviceState,
  DeviceType,
  EstadoRf,
  FuenteConfig,
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
  /**
   * OBLIGATORIAS: el tablero de monitoreo es un mapa y una alarma sin punto es
   * una alarma que nadie va a mirar cuando suene. La base lo impone con
   * `chk_device_gps` y el DTO del backend las exige.
   */
  latitude: number;
  longitude: number;
}

/**
 * ADOPTAR: sumar un equipo al stock propio con serial + código.
 *
 * El otro uso del código además de instalar. Solo sobre equipos SIN DUEÑO: uno
 * que ya es de alguien se entrega, no se adopta.
 *
 * `organizationId` se omite si pertenecés a una sola organización. CPS SÍ tiene
 * que mandarlo: su stock es la fábrica, así que adopta en nombre de un cliente.
 */
export interface AdoptDevice {
  serial: string;
  claimCode: string;
  organizationId?: number;
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

  /**
   * El STOCK: lo que está LISTO para entregar o instalar. CPS ve todo; una
   * organización, el suyo.
   *
   * Un equipo entra al stock cuando alguien le da el visto bueno de fábrica, no
   * cuando se fabrica: antes de eso vive en la pantalla de Fábrica, que es donde
   * se lo termina de poner a punto.
   *
   * `incluirSinAprobar` trae también los que no tienen el visto bueno. Lo usa
   * SOLO la pantalla de fábrica — sin eso, un equipo recién fabricado
   * desaparecería de la única pantalla desde la que se lo puede aprobar.
   */
  inventory(incluirSinAprobar = false): Observable<Device[]> {
    return this.http.get<Device[]>(`${this.api}/devices/inventory`, {
      params: incluirSinAprobar ? { incluirSinAprobar: 'true' } : {},
    });
  }

  get(id: number): Observable<Device> {
    return this.http.get<Device>(`${this.api}/devices/${id}`);
  }

  // --- Papelera -------------------------------------------------------------

  /** Los removidos. No aparecen en `list()` ni en `inventory()`. Solo CPS. */
  removidos(): Observable<Device[]> {
    return this.http.get<Device[]>(`${this.api}/devices/removed`);
  }

  /**
   * A la papelera: lo saca de todas las listas y REVOCA su credencial del
   * broker. Si estaba instalado, lo desvincula del barrio.
   */
  remover(id: number): Observable<Device> {
    return this.http.post<Device>(`${this.api}/devices/${id}/remove`, {});
  }

  /**
   * De vuelta a circulación, al STOCK DE FÁBRICA. Le genera un claim code nuevo
   * —el anterior quedó impreso en una etiqueta— y vuelve a pedir su credencial.
   */
  reactivar(id: number): Observable<Device> {
    return this.http.post<Device>(`${this.api}/devices/${id}/restore`, {});
  }

  /**
   * Borrado DEFINITIVO, solo desde la papelera y solo OWNER. Se lleva la
   * bitácora de mantenimiento; un equipo con eventos no se puede borrar.
   */
  borrarDefinitivo(id: number): Observable<{ mensaje: string }> {
    return this.http.delete<{ mensaje: string }>(`${this.api}/devices/${id}`);
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
  publicarConfig(id: number, patch: Record<string, unknown>): Observable<DeviceConfig> {
    return this.http.put<DeviceConfig>(`${this.api}/devices/${id}/config`, {
      patch,
    });
  }

  /**
   * Que el equipo busque redes. El resultado NO vuelve acá: llega después por
   * su cuenta y aparece en el próximo `config()`.
   */
  pedirScan(id: number): Observable<{ mensaje: string }> {
    return this.http.post<{ mensaje: string }>(`${this.api}/devices/${id}/config/scan`, {});
  }

  /** Pedirle su configuración actual. Es el desbloqueo cuando no hay espejo. */
  pedirRefresh(id: number): Observable<{ mensaje: string }> {
    return this.http.post<{ mensaje: string }>(`${this.api}/devices/${id}/config/refresh`, {});
  }

  /** Las passwords en claro. Solo CPS, y queda en `audit_log`. */
  revelarWifi(id: number): Observable<RedWifiRevelada[]> {
    return this.http.post<RedWifiRevelada[]>(`${this.api}/devices/${id}/config/reveal-wifi`, {});
  }

  /** Los equipos del mismo barrio de los que se puede copiar la configuración. */
  fuentesDeConfig(id: number): Observable<FuenteConfig[]> {
    return this.http.get<FuenteConfig[]>(`${this.api}/devices/${id}/config/sources`);
  }

  // --- La base de controles del equipo ----------------------------------

  /**
   * Qué controles tiene cargados el equipo, cuáles faltan y cuáles sobran.
   *
   * Alcanza con poder VER el equipo: entender por qué un control no dispara es
   * parte de mirarlo. Lo que se puede HACER viene en `puedeSincronizar`.
   */
  baseRf(id: number): Observable<EstadoRf> {
    return this.http.get<EstadoRf>(`${this.api}/devices/${id}/rf`);
  }

  /**
   * Carga la base en el equipo. Encola la tanda entera pero sale de a un paso:
   * cada ack destraba el siguiente.
   *
   * Devuelve el estado con la tanda ya en curso, así la pantalla muestra el
   * progreso sin volver a pedirlo.
   */
  sincronizarRf(id: number): Observable<EstadoRf> {
    return this.http.post<EstadoRf>(`${this.api}/devices/${id}/rf/sync`, {});
  }

  // --- Comandos al panel ------------------------------------------------

  /** Los últimos 20, con su estado. Alcanza con poder VER el equipo. */
  comandos(id: number): Observable<ColaComandos> {
    return this.http.get<ColaComandos>(`${this.api}/devices/${id}/commands`);
  }

  /**
   * Encola un comando. Devuelve la cola ya actualizada, así la pantalla no
   * tiene que adivinar en qué quedó ni pedirla de nuevo.
   */
  mandarComando(
    id: number,
    tipo: string,
    params: Record<string, unknown> = {},
    confirmacion?: string,
  ): Observable<ColaComandos> {
    return this.http.post<ColaComandos>(`${this.api}/devices/${id}/commands`, {
      tipo,
      params,
      confirmacion,
    });
  }

  /** Solo si sigue en la cola: lo publicado el panel lo recibe igual. */
  cancelarComando(id: number, cid: string): Observable<ColaComandos> {
    return this.http.post<ColaComandos>(`${this.api}/devices/${id}/commands/${cid}/cancel`, {});
  }

  /**
   * Disparar o apagar la alarma a distancia. Es la única acción sobre el equipo
   * que también tiene el MONITOR.
   */
  dispararAlarma(id: number, modo: string): Observable<ColaComandos> {
    return this.http.post<ColaComandos>(`${this.api}/devices/${id}/alarm`, {
      modo,
    });
  }

  /**
   * Pedir el alta de la credencial en el broker. Solo CPS.
   *
   * El alta de fábrica ya encola sola: esto es para reintentar un fallo o para
   * los equipos que quedaron sin registrar.
   */
  pedirProvision(id: number): Observable<{ mensaje: string }> {
    return this.http.post<{ mensaje: string }>(`${this.api}/devices/${id}/provision`, {});
  }

  /** Dar de baja la credencial. Siempre manual: ningún estado la revoca sola. */
  revocarCredencial(id: number): Observable<{ mensaje: string }> {
    return this.http.post<{ mensaje: string }>(`${this.api}/devices/${id}/revoke-credential`, {});
  }

  /** Modelos de placa: el desplegable / la referencia de prefijos válidos. */
  boardModels(): Observable<BoardModel[]> {
    return this.http.get<BoardModel[]>(`${this.api}/devices/board-models`);
  }

  /**
   * FABRICAR: solo CPS. MAC o número de placa repetidos dan 409.
   *
   * Es ATÓMICA y por eso puede tardar: no vuelve hasta que el provisioner
   * registró la credencial en el broker y derivó las del portal. Si algo falla,
   * el backend BORRA el equipo y responde 503 — no queda nada a medias y se
   * puede reintentar con los mismos datos.
   */
  create(device: CreateDevice): Observable<Device> {
    return this.http.post<Device>(`${this.api}/devices`, device);
  }

  /**
   * La password del usuario `cps` del portal. Endpoint aparte y no un campo de
   * la ficha: es la credencial de nivel FÁBRICA, el firmware manda no
   * imprimirla nunca, y cada lectura queda en audit_log. Solo OWNER/ADMIN de CPS.
   */
  passwordCps(id: number): Observable<{ usuario: 'cps'; password: string }> {
    return this.http.get<{ usuario: 'cps'; password: string }>(
      `${this.api}/devices/${id}/portal-cps`,
    );
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
    milestones: { labeled?: boolean; connected?: boolean; tested?: boolean; ready?: boolean },
  ): Observable<Device> {
    return this.http.patch<Device>(`${this.api}/devices/${id}/milestones`, milestones);
  }

  /**
   * INSTALAR con serial + código. Lo que gobierna es de QUIÉN ES el equipo, no
   * el código: sin dueño lo reclama cualquiera; con dueño, solo esa
   * organización o CPS hacia un barrio de ella.
   *
   * El código NO se quema: si el equipo se remueve, vuelve al stock con él.
   */
  claim(claim: ClaimDevice): Observable<Device> {
    return this.http.post<Device>(`${this.api}/devices/claim`, claim);
  }

  /** Sumar un equipo SIN DUEÑO al stock propio. No lo instala. */
  adopt(adopt: AdoptDevice): Observable<Device> {
    return this.http.post<Device>(`${this.api}/devices/adopt`, adopt);
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
