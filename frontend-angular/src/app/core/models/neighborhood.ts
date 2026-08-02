import { ManagedBy } from './api.models';

export type NeighborhoodStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

/**
 * El backend devuelve el árbol geográfico COMPLETO (localidad + departamento +
 * provincia) porque hace falta para desambiguar: hay 3 "Villa María" en el país.
 */
export interface Province {
  id: number;
  name: string;
}

export interface Department {
  id: number;
  name: string;
  province: Province;
}

export interface Locality {
  id: number;
  name: string;
  department: Department;
}

/**
 * v2: el barrio pertenece a una ORGANIZACIÓN (municipio o comunidad) y sabe
 * quién lo opera (managedBy). Sus CUPOS (maxFamilyMembers,
 * remoteControlsEnabled) son tarifa: solo CPS los modifica.
 */
export interface Neighborhood {
  id: number;
  name: string;
  status: NeighborhoodStatus;
  organizationId: number;
  managedBy: ManagedBy;
  /** Cupo de FAMILIARES por hogar (el titular no cuenta). null = sin límite. */
  maxFamilyMembers: number | null;
  remoteControlsEnabled: boolean;
  /** Disparar TODAS las alarmas del barrio desde la app del vecino. */
  communityScopeEnabled: boolean;
  latitude: number | null;
  longitude: number | null;
  localityId: number;
  locality: Locality;
  createdAt: string;
  updatedAt: string;
}
