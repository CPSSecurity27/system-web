import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  EtiquetaControl,
  Paginated,
  Remote,
  RemoteCode,
  RemoteFabricado,
  RemoteModel,
  RemoteStatus,
  ResultadoBusqueda,
} from '../models/api.models';

/**
 * Filtros del listado de controles ENTREGADOS.
 *
 * Todos se intersectan con el alcance del usuario en el backend: pedir el
 * barrio de otro cliente devuelve vacío, no un error.
 */
export interface FindRemotes {
  /** El CLIENTE dueño del barrio (municipio o comunidad). */
  organizationId?: number;
  neighborhoodId?: number;
  homeId?: number;
  /** La alarma PREFERIDA del hogar (`home.defaultDeviceId`). */
  defaultDeviceId?: number;
  status?: RemoteStatus;
  /** Un solo buscador: DNI, serial, dirección o nombre del portador. */
  q?: string;
  limit?: number;
  offset?: number;
}

/**
 * Sin homeId el control nace en INVENTARIO (solo CPS; organizationId opcional
 * para cargarlo directo al stock de una org). Con homeId, alta directa en la
 * vivienda — falla si el barrio no tiene controles habilitados (cupo).
 */
export interface CreateRemote {
  name: string;
  homeId?: number;
  organizationId?: number;
  assignedToUserId?: number;
  deviceId?: number;
}

@Injectable({ providedIn: 'root' })
export class RemotesService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  /**
   * Los controles ENTREGADOS, paginados. El stock NO sale acá: tiene su propia
   * pantalla (`inventory()`), y sus filas no tienen barrio, cliente ni portador.
   */
  list(query: FindRemotes = {}): Observable<Paginated<Remote>> {
    const params: Record<string, string | number> = {};
    if (query.organizationId) params['organizationId'] = query.organizationId;
    if (query.neighborhoodId) params['neighborhoodId'] = query.neighborhoodId;
    if (query.homeId) params['homeId'] = query.homeId;
    if (query.defaultDeviceId) params['defaultDeviceId'] = query.defaultDeviceId;
    if (query.status) params['status'] = query.status;
    if (query.q) params['q'] = query.q;
    if (query.limit !== undefined) params['limit'] = query.limit;
    if (query.offset !== undefined) params['offset'] = query.offset;
    return this.http.get<Paginated<Remote>>(`${this.api}/remotes`, { params });
  }

  /** CPS: todo el stock; organización: SU stock. */
  inventory(): Observable<Remote[]> {
    return this.http.get<Remote[]>(`${this.api}/remotes/inventory`);
  }

  // --- Fábrica (solo CPS) ----------------------------------------------

  /** El catálogo de modelos. Lo que define un modelo es cuántos botones tiene. */
  modelos(): Observable<RemoteModel[]> {
    return this.http.get<RemoteModel[]>(`${this.api}/remotes/models`);
  }

  /**
   * Fabrica un control: serial, modelo y códigos en una sola transacción.
   *
   * `correlativo` sigue la numeración del último código emitido en vez de
   * sortear. `codigos` son los tipeados a mano: van TODOS o no va ninguno, y en
   * ese caso el backend ignora `correlativo` porque no genera nada.
   *
   * Devuelve los códigos EN CLARO porque hay que grabarlos en el control — es la
   * única respuesta que los trae sin pedirlos aparte.
   */
  fabricar(
    modelId: number,
    correlativo = false,
    codigos?: number[],
  ): Observable<RemoteFabricado> {
    const cuerpo: { modelId: number; correlativo: boolean; codigos?: number[] } =
      { modelId, correlativo };
    // Un array vacío no es "sin códigos" para el DTO: se omite la clave.
    if (codigos && codigos.length > 0) cuerpo.codigos = codigos;
    return this.http.post<RemoteFabricado>(
      `${this.api}/remotes/manufacture`,
      cuerpo,
    );
  }

  /** Todo lo fabricado, lo último arriba. Es el registro de la fábrica. */
  fabricados(): Observable<ResultadoBusqueda[]> {
    return this.http.get<ResultadoBusqueda[]>(`${this.api}/remotes/manufactured`);
  }

  /**
   * El visto bueno de fábrica. Hasta que no está, el control NO entra al stock.
   *
   * Se puede desmarcar: el error más común es marcar de más, y obligar a borrar
   * el control para corregirlo sería peor que el error.
   */
  marcarListo(id: number, listo: boolean): Observable<ResultadoBusqueda> {
    return this.http.post<ResultadoBusqueda>(`${this.api}/remotes/${id}/ready`, { listo });
  }

  // --- Custodia: stock -> cliente -> vivienda ---------------------------

  /**
   * Entrega de LOTE: del stock de CPS al de una organización. Solo CPS.
   *
   * `organizationId: null` los devuelve al stock de fábrica.
   */
  entregarLote(
    remoteIds: number[],
    organizationId: number | null,
  ): Observable<{ delivered: number }> {
    return this.http.post<{ delivered: number }>(`${this.api}/remotes/deliver`, {
      remoteIds,
      organizationId,
    });
  }

  /**
   * ADOPTAR: sumar un control al stock propio con serial + código.
   *
   * El código es lo que demuestra que el control está en tus manos: el serial
   * solo está impreso a la vista y viaja en los listados.
   */
  adoptar(serial: string, claimCode: string, organizationId?: number): Observable<Remote> {
    return this.http.post<Remote>(`${this.api}/remotes/adopt`, {
      serial,
      claimCode,
      organizationId,
    });
  }

  /**
   * DEVOLVER al stock: la familia entregó el control.
   *
   * Vuelve al inventario de quien opera el barrio, sin portador, listo para otra
   * casa. NO borra sus códigos de los paneles.
   */
  devolver(id: number): Observable<Remote> {
    return this.http.post<Remote>(`${this.api}/remotes/${id}/return`, {});
  }

  // --- Papelera (solo CPS) ----------------------------------------------

  /** Los removidos. No aparecen en ninguna otra lista. */
  removidos(): Observable<ResultadoBusqueda[]> {
    return this.http.get<ResultadoBusqueda[]>(`${this.api}/remotes/removed`);
  }

  /**
   * A la papelera. Lo desvincula de la vivienda y lo saca de todas las listas.
   *
   * OJO: no deja el control sin efecto — sus códigos siguen grabados en la
   * memoria de cada alarma y la web todavía no los sincroniza.
   */
  remover(id: number): Observable<ResultadoBusqueda> {
    return this.http.post<ResultadoBusqueda>(`${this.api}/remotes/${id}/remove`, {});
  }

  /** De vuelta al stock de fábrica, y SIN el visto bueno: hay que revisarlo. */
  restaurar(id: number): Observable<ResultadoBusqueda> {
    return this.http.post<ResultadoBusqueda>(`${this.api}/remotes/${id}/restore`, {});
  }

  /**
   * Borrado DEFINITIVO, solo desde la papelera y solo OWNER.
   *
   * Se lleva los códigos, y con ellos la reserva de esos números: vuelven a
   * quedar disponibles. Un control con eventos no se puede borrar.
   */
  borrarDefinitivo(id: number): Observable<{ mensaje: string }> {
    return this.http.delete<{ mensaje: string }>(`${this.api}/remotes/${id}`);
  }

  /**
   * Buscar por número de serie o por un código.
   *
   * Por código solo encuentra con el número COMPLETO: el backend lo compara
   * contra el HMAC, que es exacto. No devuelve códigos.
   */
  buscar(q: string): Observable<ResultadoBusqueda[]> {
    return this.http.get<ResultadoBusqueda[]>(`${this.api}/remotes/search`, {
      params: { q },
    });
  }

  /** Los datos de la etiqueta. Cada llamada queda en `audit_log`. */
  etiqueta(id: number): Observable<EtiquetaControl> {
    return this.http.get<EtiquetaControl>(`${this.api}/remotes/${id}/label`);
  }

  create(remote: CreateRemote): Observable<Remote> {
    return this.http.post<Remote>(`${this.api}/remotes`, remote);
  }

  /**
   * Entrega física: del stock a una vivienda, con su portador.
   *
   * El portador es OBLIGATORIO: el `dni` que viaja en la alarma sale de ahí, así
   * que un control entregado sin nombre es un evento que después no se le puede
   * atribuir a nadie. Cambiarlo después es `reassign`.
   *
   * Para moverlo a otra casa hay que devolverlo al stock primero.
   */
  assign(id: number, homeId: number, assignedToUserId: number): Observable<Remote> {
    return this.http.post<Remote>(`${this.api}/remotes/${id}/assign`, {
      homeId,
      assignedToUserId,
    });
  }

  /**
   * Reasigna el PORTADOR (null = queda en la casa sin portador). Debe ser
   * MIEMBRO del hogar: si no, 400.
   */
  reassign(id: number, assignedToUserId: number | null): Observable<Remote> {
    return this.http.patch<Remote>(`${this.api}/remotes/${id}`, { assignedToUserId });
  }

  /** Devuelve posición (1..4) y fecha. NUNCA el código. */
  codes(remoteId: number): Observable<RemoteCode[]> {
    return this.http.get<RemoteCode[]>(`${this.api}/remotes/${remoteId}/codes`);
  }

  /** Solo CPS. El código viaja en claro SOLO acá: se cifra antes de guardarse. */
  addCode(remoteId: number, code: string, position: number): Observable<RemoteCode> {
    return this.http.post<RemoteCode>(`${this.api}/remotes/${remoteId}/codes`, {
      code,
      position,
    });
  }

  /**
   * El único endpoint que descifra un código RF. Solo CPS. Se pide de a uno,
   * se muestra y se descarta: no se cachea ni se guarda en estado global.
   * Cada llamada queda en audit_log.
   */
  reveal(remoteId: number, codeId: number): Observable<{ position: number; code: string }> {
    return this.http.get<{ position: number; code: string }>(
      `${this.api}/remotes/${remoteId}/codes/${codeId}/reveal`,
    );
  }
}
