import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { Department, Locality, Province } from '../models/neighborhood';

@Injectable({ providedIn: 'root' })
export class GeographyService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  provinces(): Observable<Province[]> {
    return this.http.get<Province[]>(`${this.api}/geography/provinces`);
  }

  departments(provinceId: number): Observable<Department[]> {
    return this.http.get<Department[]>(`${this.api}/geography/provinces/${provinceId}/departments`);
  }

  localities(departmentId: number): Observable<Locality[]> {
    return this.http.get<Locality[]>(
      `${this.api}/geography/departments/${departmentId}/localities`,
    );
  }

  /**
   * Busca ignorando acentos y mayúsculas ("cordoba" encuentra "Córdoba").
   * Mínimo 2 caracteres. Devuelve el árbol completo (localidad + depto + provincia)
   * porque hace falta para desambiguar: hay 3 "Villa María" en el país.
   */
  searchLocalities(search: string, limit = 20): Observable<Locality[]> {
    return this.http.get<Locality[]>(`${this.api}/geography/localities/search`, {
      params: { search, limit },
    });
  }
}
