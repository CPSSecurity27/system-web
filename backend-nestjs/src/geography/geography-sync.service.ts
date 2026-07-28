import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  QueryDeepPartialEntity,
} from 'typeorm';
import { Department } from './entities/department.entity';
import { Locality } from './entities/locality.entity';
import { Province } from './entities/province.entity';
import { GeorefClient } from './georef.client';

export interface LevelReport {
  recibidas: number;
  guardadas: number;
  huerfanas: string[];
}

export interface SyncReport {
  provinces: LevelReport;
  departments: LevelReport;
  localities: LevelReport;
}

/**
 * Sincronización MANUAL de la geografía contra la API de georef.
 *
 * Tres propiedades que la hacen segura de correr a mano, las veces que sea:
 *
 *  - **Idempotente**: upsert por georef_id (la clave de reconciliación). Correrla
 *    diez veces da el mismo resultado que correrla una. El id interno nunca
 *    cambia, así que un neighborhood que apunta a una localidad la sigue
 *    apuntando después de re-sincronizar.
 *  - **Transaccional**: si georef se corta a mitad, no queda geografía a medias
 *    (departamentos sin provincia).
 *  - **No borra nunca**: si algo desaparece de georef, se reporta como huérfano
 *    y sigue. Puede haber un barrio colgando (el FK es ON DELETE RESTRICT).
 *    Borrar es una decisión humana.
 */
@Injectable()
export class GeographySyncService {
  private readonly logger = new Logger(GeographySyncService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly georef: GeorefClient,
  ) {}

  async run(): Promise<SyncReport> {
    // Se descarga TODO antes de abrir la transacción: no se tiene una
    // transacción abierta esperando a la red.
    const [provinces, departments, localities] = await Promise.all([
      this.georef.fetchProvinces(),
      this.georef.fetchDepartments(),
      this.georef.fetchLocalities(),
    ]);

    return this.dataSource.transaction(async (manager) => {
      // El orden lo imponen las FKs: provincia → departamento → localidad.
      const provinceReport = await this.upsert(
        manager,
        Province,
        provinces.map((p) => ({
          georefId: p.id,
          name: p.nombre,
          latitude: p.centroide?.lat ?? null,
          longitude: p.centroide?.lon ?? null,
        })),
      );

      const provinceIds = await this.idsByGeorefId(manager, Province);

      const departmentRows = departments
        .filter((d) => provinceIds.has(d.provincia.id))
        .map((d) => ({
          georefId: d.id,
          name: d.nombre,
          latitude: d.centroide?.lat ?? null,
          longitude: d.centroide?.lon ?? null,
          provinceId: provinceIds.get(d.provincia.id)!,
        }));

      // Un departamento cuya provincia no existe no se puede insertar (FK).
      // No debería pasar; si pasa, quiero verlo, no un crash opaco.
      this.warnDropped(
        departments.length,
        departmentRows.length,
        'departamento',
      );
      const departmentReport = await this.upsert(
        manager,
        Department,
        departmentRows,
      );

      const departmentIds = await this.idsByGeorefId(manager, Department);

      const localityRows = localities
        .filter((l) => l.departamento && departmentIds.has(l.departamento.id))
        .map((l) => ({
          georefId: l.id,
          name: l.nombre,
          latitude: l.centroide?.lat ?? null,
          longitude: l.centroide?.lon ?? null,
          departmentId: departmentIds.get(l.departamento!.id)!,
        }));

      this.warnDropped(localities.length, localityRows.length, 'localidad');
      const localityReport = await this.upsert(manager, Locality, localityRows);

      return {
        provinces: {
          ...provinceReport,
          huerfanas: await this.orphans(manager, Province, provinces),
        },
        departments: {
          ...departmentReport,
          huerfanas: await this.orphans(manager, Department, departments),
        },
        localities: {
          ...localityReport,
          huerfanas: await this.orphans(manager, Locality, localities),
        },
      };
    });
  }

  /** INSERT ... ON CONFLICT (georef_id) DO UPDATE. */
  private async upsert<T extends ObjectLiteral>(
    manager: EntityManager,
    entity: EntityTarget<T>,
    rows: QueryDeepPartialEntity<T>[],
  ): Promise<Omit<LevelReport, 'huerfanas'>> {
    if (rows.length === 0) return { recibidas: 0, guardadas: 0 };

    // Se parte en lotes para no chocar con el tope de parámetros de Postgres.
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await manager
        .createQueryBuilder()
        .insert()
        .into(entity)
        .values(rows.slice(i, i + CHUNK))
        .orUpdate(
          ['name', 'latitude', 'longitude', 'updated_at'],
          ['georef_id'],
        )
        .execute();
    }

    return { recibidas: rows.length, guardadas: rows.length };
  }

  private async idsByGeorefId<T extends ObjectLiteral>(
    manager: EntityManager,
    entity: EntityTarget<T>,
  ): Promise<Map<string, number>> {
    const rows: { id: number; georefId: string }[] = await manager
      .createQueryBuilder(entity, 'e')
      .select(['e.id AS id', 'e.georef_id AS "georefId"'])
      .getRawMany();

    return new Map(rows.map((r) => [r.georefId, r.id]));
  }

  /** Filas que están en nuestra base pero ya no vienen de georef. No se borran. */
  private async orphans<T extends ObjectLiteral>(
    manager: EntityManager,
    entity: EntityTarget<T>,
    incoming: { id: string }[],
  ): Promise<string[]> {
    const vivos = new Set(incoming.map((i) => i.id));
    const existentes = await this.idsByGeorefId(manager, entity);

    const huerfanas = [...existentes.keys()].filter((g) => !vivos.has(g));
    if (huerfanas.length > 0) {
      this.logger.warn(
        `${huerfanas.length} fila(s) ya no existen en georef y NO se borran ` +
          `(puede haber barrios colgando): ${huerfanas.join(', ')}`,
      );
    }
    return huerfanas;
  }

  private warnDropped(recibidas: number, usadas: number, nivel: string): void {
    if (recibidas !== usadas) {
      this.logger.warn(
        `${recibidas - usadas} ${nivel}(es) de georef vienen sin padre válido y se ignoran`,
      );
    }
  }
}
