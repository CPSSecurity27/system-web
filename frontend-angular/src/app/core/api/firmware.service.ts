import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  ChequeoFirmware,
  FirmwareRanura,
  FirmwareRelease,
  FirmwareSlot,
  FlotaFirmware,
  ResultadoActualizacion,
} from '../models/api.models';

/**
 * El catálogo de firmwares y el gestor de actualizaciones. **Todo solo CPS.**
 *
 * Ojo con el `.bin`: NO se sube por acá como JSON. Va como `multipart/form-data`
 * y sin `Content-Type` a mano — el navegador tiene que ponerlo él para incluir
 * el `boundary`, y fijarlo rompe el parseo del lado del servidor.
 */
@Injectable({ providedIn: 'root' })
export class FirmwareService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/firmware`;

  listar(): Observable<FirmwareRelease[]> {
    return this.http.get<FirmwareRelease[]>(this.base);
  }

  ranuras(): Observable<FirmwareRanura[]> {
    return this.http.get<FirmwareRanura[]>(`${this.base}/slots`);
  }

  /**
   * Sube un `.bin` y lo siembra en el servidor.
   *
   * El backend lee del archivo el proyecto, el tamaño y el sha256; la versión es
   * lo único que se tipea, porque el binario del firmware declara su
   * `git describe` y no la versión OTA.
   */
  subir(
    archivo: File,
    version: string,
    notes?: string,
  ): Observable<FirmwareRelease> {
    const form = new FormData();
    form.append('archivo', archivo);
    form.append('version', version);
    if (notes) form.append('notes', notes);
    return this.http.post<FirmwareRelease>(this.base, form);
  }

  /** `new` = la que baja un OTA automático. `emergency` = el último bueno conocido. */
  publicar(id: number, slot: FirmwareSlot): Observable<FirmwareRanura[]> {
    return this.http.post<FirmwareRanura[]>(`${this.base}/${id}/publish`, {
      slot,
    });
  }

  borrar(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/${id}`);
  }

  /** Que el disco tenga lo que la base dice. El modo de falla del OTA es silencioso. */
  verificar(): Observable<ChequeoFirmware> {
    return this.http.get<ChequeoFirmware>(`${this.base}/check`);
  }

  flota(): Observable<FlotaFirmware> {
    return this.http.get<FlotaFirmware>(`${this.base}/fleet`);
  }

  /**
   * Manda el OTA a los equipos elegidos. **No es un broadcast**: cada uno recibe
   * su propio comando, y la respuesta dice qué pasó con cada uno.
   */
  actualizar(deviceIds: number[]): Observable<ResultadoActualizacion[]> {
    return this.http.post<ResultadoActualizacion[]>(`${this.base}/fleet/update`, {
      deviceIds,
    });
  }
}
