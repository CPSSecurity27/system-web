import { ManagedBy } from './api.models';

export type NeighborhoodStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

/**
 * El backend devuelve el árbol geográfico COMPLETO (localidad + departamento +
 * provincia) porque hace falta para desambiguar: hay 3 "Villa María" en el país.
 */
/**
 * El CENTROIDE que trae georef en cada nivel (`geography:sync` lo guarda).
 * Nullable porque la columna lo es: georef no siempre lo publica.
 *
 * Lo usa el alta para acompañar la elección con el mapa —elegís Jujuy y el mapa
 * vuela a Jujuy—, así que es una referencia para MIRAR, nunca la ubicación de
 * nada: el punto del cliente y el del barrio se marcan a mano.
 */
export interface Centroide {
  latitude: number | null;
  longitude: number | null;
}

export interface Province extends Centroide {
  id: number;
  name: string;
}

export interface Department extends Centroide {
  id: number;
  name: string;
  province: Province;
}

export interface Locality extends Centroide {
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
  /** Obligatorias: el barrio sale en el tablero de clientes y en el monitoreo. */
  latitude: number;
  longitude: number;
  localityId: number;
  locality: Locality;
  createdAt: string;
  updatedAt: string;
}
