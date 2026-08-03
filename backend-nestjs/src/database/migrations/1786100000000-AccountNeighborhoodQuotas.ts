import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Los cupos DE BARRIO pasan a definirse en la CUENTA (2026-08-03).
 *
 * Cierra el pendiente anotado en `docs/estado-proyecto.md` §8: hasta ahora
 * `max_family_members`, `remote_controls_enabled` y `community_scope_enabled`
 * vivían en `plan` (la plantilla) y en `neighborhood` (donde se aplican), pero
 * NO en el medio. Resultado: al crear un barrio nadie los copiaba y nacía con
 * los DEFAULT de la base (3 familiares, controles sí, scope sí), sin importar
 * qué se le había vendido al cliente.
 *
 * Por qué en `account` y no leyendo el plan al crear el barrio: la regla 4 dice
 * que el plan es una PLANTILLA que se copia al vender y NUNCA se lee en vivo.
 * Un barrio creado seis meses después que fuera a buscar `plan.max_family_members`
 * heredaría un plan ya reconfigurado — justo el grandfathering que la regla
 * protege. La cadena correcta es:
 *
 *     plan (plantilla)  ->  account (lo que se VENDIÓ)  ->  neighborhood (lo que APLICA)
 *
 * Cada flecha es una COPIA en el momento del alta. `PATCH /neighborhoods/:id/quotas`
 * sigue existiendo para ajustar un barrio puntual sin tocar el resto.
 *
 * Siguen siendo CUPOS (regla 4): solo CPS los escribe, con `audit_log`.
 *
 * Los tres se suman a `chk_subtype_by_type` —el mismo CHECK que ya exige los
 * otros cuatro— y no a uno nuevo: dos CHECK sobre las mismas columnas se
 * contradicen apenas se toca uno solo. Obligatorios en ORGANIZATION, NULL en
 * COMPANY: CPS no se vende cupos a sí misma.
 *
 * Las filas existentes se rellenan con el default de la base, que es lo que sus
 * barrios ya tienen — así el backfill no cambia nada de lo que hoy está vivo.
 */
export class AccountNeighborhoodQuotas1786100000000 implements MigrationInterface {
  name = 'AccountNeighborhoodQuotas1786100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE account
        ADD COLUMN max_family_members      INT,
        ADD COLUMN remote_controls_enabled BOOLEAN,
        ADD COLUMN community_scope_enabled BOOLEAN
    `);
    await queryRunner.query(`
      ALTER TABLE account
        ADD CONSTRAINT chk_account_max_family_members
        CHECK (max_family_members IS NULL OR max_family_members >= 0)
    `);

    // Backfill con los MISMOS defaults que hoy tienen los barrios, para que la
    // cuenta declare lo que ya está pasando y no una tarifa inventada.
    await queryRunner.query(`
      UPDATE account SET
        max_family_members      = 3,
        remote_controls_enabled = true,
        community_scope_enabled = true
      WHERE type = 'ORGANIZATION'
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

    await queryRunner.query(`
      COMMENT ON COLUMN account.max_family_members IS
        'CUPO (solo CPS): familiares por hogar que se COPIA a cada barrio nuevo
         de esta cuenta. Después, cada barrio se puede ajustar por /quotas.'
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
    await queryRunner.query(
      `ALTER TABLE account DROP CONSTRAINT chk_account_max_family_members`,
    );
    await queryRunner.query(`
      ALTER TABLE account
        DROP COLUMN community_scope_enabled,
        DROP COLUMN remote_controls_enabled,
        DROP COLUMN max_family_members
    `);
  }
}
