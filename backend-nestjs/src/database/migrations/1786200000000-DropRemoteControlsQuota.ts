import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Se elimina el CUPO `remote_controls_enabled` (2026-08-03).
 *
 * Decisión de negocio: los controles remotos dejan de ser algo que se habilita
 * o se deshabilita por barrio. El producto los tiene y punto; cómo se manejan
 * se define aparte.
 *
 * QUÉ CAMBIA EN LA CONDUCTA — no es solo borrar una columna:
 * `RemotesService` la usaba como PUERTA ("Este barrio no tiene controles
 * remotos habilitados"). Sin ella, **cualquier barrio puede tener controles**.
 * Ese chequeo se va con la columna, porque una puerta que siempre está abierta
 * es peor que ninguna: confunde a quien lee el código.
 *
 * Se borra de las TRES tablas de la cadena —plan (plantilla), account (lo
 * vendido) y neighborhood (lo aplicado)— y del CHECK que la exigía en toda
 * ORGANIZATION. Lo que NO se toca es la tabla `remote` ni `remote_code`: los
 * llaveros siguen existiendo, con su custodia de tres niveles y sus códigos RF.
 *
 * Ojo con el `down()`: repone las columnas con su default (`true`), que es lo
 * más honesto que se puede hacer — el valor que cada barrio tenía se pierde al
 * bajar. Con el default puesto, ningún barrio queda peor que antes.
 */
export class DropRemoteControlsQuota1786200000000 implements MigrationInterface {
  name = 'DropRemoteControlsQuota1786200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // El CHECK la nombra: hay que rehacerlo ANTES de tirar la columna.
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
          AND max_family_members IS NOT NULL
          AND community_scope_enabled IS NOT NULL
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL)
        OR
        (type = 'COMPANY'
          AND subtype IS NULL
          AND plan_id IS NULL
          AND max_neighborhoods IS NULL
          AND max_admin_users IS NULL
          AND max_technician_users IS NULL
          AND max_monitor_users IS NULL
          AND max_family_members IS NULL
          AND community_scope_enabled IS NULL)
      )
    `);

    await queryRunner.query(
      `ALTER TABLE neighborhood DROP COLUMN remote_controls_enabled`,
    );
    await queryRunner.query(
      `ALTER TABLE account DROP COLUMN remote_controls_enabled`,
    );
    await queryRunner.query(
      `ALTER TABLE plan DROP COLUMN remote_controls_enabled`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE plan
        ADD COLUMN remote_controls_enabled BOOLEAN NOT NULL DEFAULT true
    `);
    await queryRunner.query(
      `ALTER TABLE account ADD COLUMN remote_controls_enabled BOOLEAN`,
    );
    await queryRunner.query(`
      UPDATE account SET remote_controls_enabled = true
      WHERE type = 'ORGANIZATION'
    `);
    await queryRunner.query(`
      ALTER TABLE neighborhood
        ADD COLUMN remote_controls_enabled BOOLEAN NOT NULL DEFAULT true
    `);

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
          AND max_family_members IS NOT NULL
          AND remote_controls_enabled IS NOT NULL
          AND community_scope_enabled IS NOT NULL
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL)
        OR
        (type = 'COMPANY'
          AND subtype IS NULL
          AND plan_id IS NULL
          AND max_neighborhoods IS NULL
          AND max_admin_users IS NULL
          AND max_technician_users IS NULL
          AND max_monitor_users IS NULL
          AND max_family_members IS NULL
          AND remote_controls_enabled IS NULL
          AND community_scope_enabled IS NULL)
      )
    `);
  }
}
