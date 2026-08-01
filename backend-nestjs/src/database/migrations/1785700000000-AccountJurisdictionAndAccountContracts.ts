import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Jurisdicción de la cuenta y contratos POR CUENTA (2026-07-31).
 *
 * Dos cambios que van juntos porque los dos salen de la misma definición de
 * negocio: el sistema se vende A NIVEL MUNICIPAL, a una localidad o a un
 * departamento.
 *
 * 1) JURISDICCIÓN. `account` no tenía dirección: la de un consorcio es la de su
 *    barrio, pero la de una municipalidad es la de su sede, que no es ninguno
 *    de sus barrios. Y el LÍMITE de dónde puede crear barrios depende de qué se
 *    le vendió a ese cliente:
 *      - nivel LOCALITY   -> sus barrios van en ESA localidad
 *      - nivel DEPARTMENT -> sus barrios van en cualquier localidad de ESE depto
 *    Con datos reales: San Pedro y Ledesma son dos DEPARTAMENTOS de Jujuy, y
 *    "Rosario de Río Grande (ex Barro Negro)" está DENTRO del departamento San
 *    Pedro pero es otro municipio. Una regla global a nivel departamento
 *    dejaría que San Pedro cree en Barro Negro; una a nivel localidad impediría
 *    vender a un cliente departamental. Por eso el límite se guarda por cuenta.
 *
 * 2) CONTRATOS POR CUENTA. El contrato era del BARRIO (neighborhood_id NOT
 *    NULL, un ACTIVE por barrio). Pero la muni paga por una cantidad de barrios
 *    y no le revende a cada uno: un contrato por barrio la convertiría en
 *    intermediaria de sus propios vecinos. El contrato pasa a colgar de la
 *    cuenta, uno ACTIVE por cuenta.
 *    Y `end_date` pasa a NOT NULL: el precio es POR EL PERÍODO del contrato, así
 *    que sin fecha de fin el número no significa nada.
 *
 * La validación de que un barrio caiga dentro de la jurisdicción de su cuenta
 * cruza tres tablas y NO va acá: vive en NeighborhoodsService.
 */
export class AccountJurisdictionAndAccountContracts1785700000000 implements MigrationInterface {
  name = 'AccountJurisdictionAndAccountContracts1785700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------------
    // Limpieza previa. Los CHECK de abajo son incumplibles para las filas que
    // ya existen (jurisdicción y end_date en NULL) y harían fallar la
    // migración a mitad de camino. Son TODOS datos de prueba: la base no tiene
    // producción. Si algún día la tuviera, acá va un backfill, no un DELETE.
    // ---------------------------------------------------------------------
    await queryRunner.query(`DELETE FROM service_contract`);

    await queryRunner.query(`
      CREATE TYPE jurisdiction_level AS ENUM ('LOCALITY', 'DEPARTMENT')
    `);

    // --- 1) Jurisdicción y GPS de la cuenta ---
    await queryRunner.query(`
      ALTER TABLE account
        ADD COLUMN jurisdiction_level jurisdiction_level,
        ADD COLUMN locality_id   INT REFERENCES locality(id)   ON DELETE RESTRICT,
        ADD COLUMN department_id INT REFERENCES department(id) ON DELETE RESTRICT,
        ADD COLUMN latitude      DOUBLE PRECISION,
        ADD COLUMN longitude     DOUBLE PRECISION
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN account.jurisdiction_level IS
        'Hasta dónde llega el cliente: LOCALITY (una localidad) o DEPARTMENT (todo el departamento). Es lo que se vendió.'
    `);

    // Las ORGANIZATION que ya existen no tienen jurisdicción y no hay forma de
    // adivinarla. Se les pone la de su primer barrio si lo tienen; si no, se
    // borran junto con sus membresías (datos de prueba).
    await queryRunner.query(`
      UPDATE account a
         SET jurisdiction_level = 'LOCALITY',
             locality_id = n.locality_id
        FROM (
          SELECT DISTINCT ON (organization_id) organization_id, locality_id
            FROM neighborhood
           ORDER BY organization_id, id
        ) n
       WHERE a.id = n.organization_id
         AND a.type = 'ORGANIZATION'
    `);

    await queryRunner.query(`
      DELETE FROM account_user
       WHERE account_id IN (
         SELECT id FROM account
          WHERE type = 'ORGANIZATION' AND jurisdiction_level IS NULL
       )
    `);
    await queryRunner.query(`
      DELETE FROM account
       WHERE type = 'ORGANIZATION' AND jurisdiction_level IS NULL
    `);

    // Una ORGANIZATION tiene jurisdicción y EXACTAMENTE el id de su nivel.
    // Una COMPANY no tiene ninguna: CPS presta el servicio, no tiene territorio.
    await queryRunner.query(`
      ALTER TABLE account ADD CONSTRAINT chk_account_jurisdiction CHECK (
        (type = 'COMPANY'
          AND jurisdiction_level IS NULL
          AND locality_id IS NULL
          AND department_id IS NULL)
        OR
        (type = 'ORGANIZATION' AND (
           (jurisdiction_level = 'LOCALITY'
             AND locality_id IS NOT NULL AND department_id IS NULL)
           OR
           (jurisdiction_level = 'DEPARTMENT'
             AND department_id IS NOT NULL AND locality_id IS NULL)
        ))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX idx_account_locality ON account(locality_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_account_department ON account(department_id)`,
    );

    // --- 2) El contrato pasa a ser de la CUENTA ---
    await queryRunner.query(`DROP INDEX uq_contract_active_per_neighborhood`);
    await queryRunner.query(
      `ALTER TABLE service_contract DROP COLUMN neighborhood_id`,
    );
    await queryRunner.query(
      `ALTER TABLE service_contract ALTER COLUMN end_date SET NOT NULL`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_contract_active_per_account
        ON service_contract(account_id) WHERE status = 'ACTIVE'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN service_contract.price IS
        'Lo que se cobra POR EL PERÍODO del contrato (start_date..end_date). El período no se guarda: se deriva de las fechas.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // El barrio de cada contrato se perdió al dropear la columna: no hay a qué
    // volver. Se vacía la tabla, igual que en el up.
    await queryRunner.query(`DELETE FROM service_contract`);

    await queryRunner.query(`DROP INDEX uq_contract_active_per_account`);
    await queryRunner.query(
      `ALTER TABLE service_contract ALTER COLUMN end_date DROP NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE service_contract
        ADD COLUMN neighborhood_id INT NOT NULL
          REFERENCES neighborhood(id) ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_contract_active_per_neighborhood
        ON service_contract(neighborhood_id) WHERE status = 'ACTIVE'
    `);

    await queryRunner.query(`DROP INDEX idx_account_department`);
    await queryRunner.query(`DROP INDEX idx_account_locality`);
    await queryRunner.query(
      `ALTER TABLE account DROP CONSTRAINT chk_account_jurisdiction`,
    );
    await queryRunner.query(`
      ALTER TABLE account
        DROP COLUMN longitude,
        DROP COLUMN latitude,
        DROP COLUMN department_id,
        DROP COLUMN locality_id,
        DROP COLUMN jurisdiction_level
    `);
    await queryRunner.query(`DROP TYPE jurisdiction_level`);
  }
}
