import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { Contract, ContractStatus } from '../models/api.models';

/**
 * v2: el contrato es SIEMPRE organización → barrio y es comercial PURO.
 * Los cupos ya NO viven acá: van en la cuenta y en el barrio (solo CPS).
 */
/**
 * El contrato es del CLIENTE, no de un barrio (desde 2026-07-31): el sistema se
 * vende a nivel municipal y la cuenta paga por los barrios de su cupo.
 */
export interface CreateContract {
  accountId: number;
  /** Se CONGELA al firmar, como el precio en una factura. */
  price: number;
  /** 'YYYY-MM-DD', NO un timestamp ISO. */
  startDate: string;
  /** OBLIGATORIA: el precio es por EL PERÍODO del contrato. */
  endDate: string;
  description?: string;
}

@Injectable({ providedIn: 'root' })
export class ContractsService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  list(): Observable<Contract[]> {
    return this.http.get<Contract[]>(`${this.api}/contracts`);
  }

  /**
   * 409 → ese barrio ya tiene un contrato ACTIVE (cerrar el anterior primero).
   * El alcance ya NO sale del contrato (sale de la estructura): un contrato
   * vencido no deja a nadie a oscuras, es un dato comercial.
   */
  create(contract: CreateContract): Observable<Contract> {
    return this.http.post<Contract>(`${this.api}/contracts`, contract);
  }

  /** Precio, cuenta y barrio están congelados: solo estado/fechas/nota. */
  update(
    id: number,
    changes: { status?: ContractStatus; endDate?: string; description?: string },
  ): Observable<Contract> {
    return this.http.patch<Contract>(`${this.api}/contracts/${id}`, changes);
  }
}
