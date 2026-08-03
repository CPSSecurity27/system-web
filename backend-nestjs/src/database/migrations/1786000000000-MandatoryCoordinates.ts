import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Coordenadas obligatorias (2026-08-02).
 *
 * El panel pasa a tener un TABLERO DE CLIENTES CON MAPA: dónde está cada
 * cliente y cada barrio deja de ser un adorno de la ficha para ser la forma
 * principal de encontrarlos. Un dato opcional no sirve para eso — con la mitad
 * de los pines vacíos el mapa no se puede leer, y la alternativa (rellenar con
 * el centroide de la localidad) pinta como exacto algo que es el centro
 * geométrico de un departamento entero.
 *
 * 1) BARRIO: `latitude`/`longitude` pasan a NOT NULL. La incoherencia ya
 *    existía y esto la cierra: desde `HomeAddressAndNeighborResident` la
 *    VIVIENDA está obligada a tener GPS, y el barrio que la contiene no.
 *
 * 2) CUENTA: las coordenadas se exigen SOLO en ORGANIZATION, con un CHECK
 *    condicional. COMPANY es CPS, que no tiene territorio (su
 *    `jurisdiction_level` también es NULL): pedirle un punto en el mapa no
 *    significa nada. Es el mismo patrón que `chk_subtype_by_type` ya usa para
 *    los cupos, y por eso se EXTIENDE ese constraint en vez de agregar uno
 *    nuevo: dos CHECK sobre las mismas columnas se contradicen apenas alguien
 *    toca uno solo.
 *
 *    Qué punto es, según el subtipo:
 *      - COMMUNITY: el de su único barrio (el consorcio y su barrio son el
 *        mismo lugar; el alta ya lo copiaba a la cuenta).
 *      - MUNICIPAL: la sede de la municipalidad. Hasta ahora no se pedía en
 *        ningún lado y la columna quedaba siempre NULL.
 *
 *    OJO (regla 4): esto NO es un cupo. Las coordenadas las carga y corrige
 *    cualquier gestor con alcance sobre la cuenta; no van por `/quotas` ni
 *    exigen `audit_log`.
 *
 * No hay backfill: la base se rehace de cero (ver `docs/estado-proyecto.md`,
 * puntos 6 y 7 — el CHECK nuevo de la MAC y el rename PRIVATE→COMMUNITY ya la
 * obligaban). Rellenar con centroides habría metido exactamente la mentira que
 * este cambio quiere evitar.
 */
export class MandatoryCoordinates1786000000000 implements MigrationInterface {
  name = 'MandatoryCoordinates1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- 1) El barrio siempre está en algún lado ---
    await queryRunner.query(
      `ALTER TABLE neighborhood ALTER COLUMN latitude SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE neighborhood ALTER COLUMN longitude SET NOT NULL`,
    );
    await queryRunner.query(`
      COMMENT ON COLUMN neighborhood.latitude IS
        'Obligatoria: el barrio se ubica en el tablero de clientes y en el mapa
         del monitoreo. No es un cupo — la carga cualquier gestor del barrio.'
    `);

    // --- 2) El cliente también, salvo CPS ---
    await queryRunner.query(
      `ALTER TABLE account DROP CONSTRAINT chk_subtype_by_type`,
    );
    await queryRunner.query(`
      ALTER TABLE account ADD CONSTRAINT chk_subtype_by_type CHECK (
        (type = 'ORGANIZATION'
          AND subtype IS NOT NULL
          AND max_neighborhoods IS NOT NULL
          AND max_admin_users IS NOT NULL
          AND max_technician_users IS NOT NULL
          AND max_monitor_users IS NOT NULL
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL)
        OR
        (type = 'COMPANY'
          AND subtype IS NULL
          AND plan_id IS NULL
          AND max_neighborhoods IS NULL
          AND max_admin_users IS NULL
          AND max_technician_users IS NULL
          AND max_monitor_users IS NULL)
      )
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN account.latitude IS
        'Obligatoria en ORGANIZATION (lo exige chk_subtype_by_type): la sede de
         la municipalidad, o el punto del único barrio de la comunitaria. NULL
         solo en COMPANY: CPS no tiene territorio.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE account DROP CONSTRAINT chk_subtype_by_type`,
    );
    await queryRunner.query(`
      ALTER TABLE account ADD CONSTRAINT chk_subtype_by_type CHECK (
        (type = 'ORGANIZATION'
          AND subtype IS NOT NULL
          AND max_neighborhoods IS NOT NULL
          AND max_admin_users IS NOT NULL
          AND max_technician_users IS NOT NULL
          AND max_monitor_users IS NOT NULL)
        OR
        (type = 'COMPANY'
          AND subtype IS NULL
          AND plan_id IS NULL
          AND max_neighborhoods IS NULL
          AND max_admin_users IS NULL
          AND max_technician_users IS NULL
          AND max_monitor_users IS NULL)
      )
    `);
    await queryRunner.query(`COMMENT ON COLUMN account.latitude IS NULL`);

    await queryRunner.query(`COMMENT ON COLUMN neighborhood.latitude IS NULL`);
    await queryRunner.query(
      `ALTER TABLE neighborhood ALTER COLUMN longitude DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE neighborhood ALTER COLUMN latitude DROP NOT NULL`,
    );
  }
}
