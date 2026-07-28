import { Injectable, Logger } from '@nestjs/common';

const GEOREF_BASE = 'https://apis.datos.gob.ar/georef/api';

// Tope duro de la API: pedir más devuelve error 1001.
// Hoy el país entra en una sola página (24 / 529 / ~4000), pero el cliente
// pagina igual por si algún día crece.
const PAGE_SIZE = 5000;

interface Centroide {
  lat: number;
  lon: number;
}

interface GeorefRef {
  id: string;
  nombre: string;
}

export interface GeorefProvince {
  id: string;
  nombre: string;
  centroide?: Centroide;
}

export interface GeorefDepartment extends GeorefProvince {
  provincia: GeorefRef;
}

export interface GeorefLocality extends GeorefProvince {
  departamento: GeorefRef | null;
}

/**
 * Cliente de la API de georef (apis.datos.gob.ar). Solo lee.
 *
 * `locality` se alimenta de /localidades-censales y NO de /localidades:
 * localidades-censales devuelve la ciudad o pueblo real ("Córdoba"), mientras
 * que /localidades devuelve sub-unidades de esa ciudad ("La Floresta"), que se
 * solaparían con nuestro propio concepto de neighborhood.
 */
@Injectable()
export class GeorefClient {
  private readonly logger = new Logger(GeorefClient.name);

  fetchProvinces(): Promise<GeorefProvince[]> {
    return this.fetchAll<GeorefProvince>('provincias', 'provincias');
  }

  fetchDepartments(): Promise<GeorefDepartment[]> {
    return this.fetchAll<GeorefDepartment>('departamentos', 'departamentos');
  }

  fetchLocalities(): Promise<GeorefLocality[]> {
    return this.fetchAll<GeorefLocality>(
      'localidades-censales',
      'localidades_censales',
    );
  }

  private async fetchAll<T>(
    resource: string,
    payloadKey: string,
  ): Promise<T[]> {
    const items: T[] = [];
    let inicio = 0;
    let total = Infinity;

    while (inicio < total) {
      const url = `${GEOREF_BASE}/${resource}?max=${PAGE_SIZE}&inicio=${inicio}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `georef respondió ${response.status} ${response.statusText} para ${resource}`,
        );
      }

      const body = (await response.json()) as Record<string, unknown>;
      const page = body[payloadKey] as T[] | undefined;

      if (!Array.isArray(page)) {
        throw new Error(
          `Respuesta inesperada de georef para ${resource}: falta "${payloadKey}"`,
        );
      }

      items.push(...page);
      total = body.total as number;
      inicio += page.length;

      // Sin esto un `total` mentiroso o una página vacía serían un loop infinito.
      if (page.length === 0) break;
    }

    this.logger.log(`georef ${resource}: ${items.length} de ${total}`);
    return items;
  }
}
