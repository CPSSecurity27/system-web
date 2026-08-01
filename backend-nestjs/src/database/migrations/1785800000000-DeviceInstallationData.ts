import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Datos de INSTALACIÓN del equipo y limpieza del enum de estados (2026-07-31).
 *
 * 1) LOS CINCO CAMPOS. Lo que un técnico necesita saber ANTES de subirse a la
 *    escalera: en qué poste está, a qué altura, en qué esquina y de qué
 *    luminaria cuelga. Son OPCIONALES —nadie mide la altura exacta colgado de
 *    una escalera— pero recomendados, y se pueden completar después.
 *
 *    Columnas dedicadas y no un JSONB: con columnas se puede preguntar "¿qué
 *    alarma está en el poste 42?" o "¿cuáles cuelgan del tablero de la plaza?",
 *    que es justo lo que sirve cuando hay que ir a arreglar algo. El texto
 *    libre (`install_notes`) queda solo para lo que no entra en los otros.
 *
 * 2) SE VA `INSTALLED`. Era lo mismo que OPERATIONAL y estaba MUERTO: el
 *    backend nunca lo escribió (al fabricar con barrio y al reclamar va directo
 *    a OPERATIONAL). Postgres no tiene DROP VALUE, así que el tipo se recrea.
 */
export class DeviceInstallationData1785800000000 implements MigrationInterface {
  name = 'DeviceInstallationData1785800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- 1) Datos de instalación ---
    await queryRunner.query(`
      ALTER TABLE device
        ADD COLUMN pole_number   TEXT,
        ADD COLUMN height_m      NUMERIC(4,1),
        ADD COLUMN reference     TEXT,
        ADD COLUMN power_point   TEXT,
        ADD COLUMN install_notes TEXT
    `);

    await queryRunner.query(`
      ALTER TABLE device ADD CONSTRAINT chk_device_height CHECK (
        height_m IS NULL OR (height_m > 0 AND height_m <= 30)
      )
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN device.pole_number IS
        'Número de poste o columna donde está montada. Opcional, recomendado.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN device.power_point IS
        'De qué luminaria o tablero toma energía. Opcional, recomendado.'
    `);

    // --- 2) Fuera INSTALLED ---
    // Por las dudas: si alguna fila lo tuviera, pasa a OPERATIONAL antes del
    // cast (si no, el USING falla y la migración muere a mitad de camino).
    await queryRunner.query(
      `UPDATE device SET status = 'OPERATIONAL' WHERE status = 'INSTALLED'`,
    );

    // LOS DOS CHECK que mencionan `status` hay que soltarlos para poder cambiar
    // el tipo de la columna, y se recrean igual apenas termina. Olvidarse de
    // uno da un "el operador no existe: device_status = device_status_old"
    // bastante críptico.
    await queryRunner.query(
      `ALTER TABLE device DROP CONSTRAINT chk_device_custody`,
    );
    await queryRunner.query(
      `ALTER TABLE device DROP CONSTRAINT chk_device_stock_owner`,
    );

    await queryRunner.query(
      `ALTER TYPE device_status RENAME TO device_status_old`,
    );
    await queryRunner.query(`
      CREATE TYPE device_status AS ENUM (
        'INVENTORY', 'OPERATIONAL', 'MAINTENANCE', 'OUT_OF_SERVICE', 'RETIRED'
      )
    `);
    await queryRunner.query(
      `ALTER TABLE device ALTER COLUMN status DROP DEFAULT`,
    );
    await queryRunner.query(`
      ALTER TABLE device
        ALTER COLUMN status TYPE device_status USING status::text::device_status
    `);
    await queryRunner.query(
      `ALTER TABLE device ALTER COLUMN status SET DEFAULT 'INVENTORY'`,
    );
    await queryRunner.query(`DROP TYPE device_status_old`);

    await queryRunner.query(`
      ALTER TABLE device ADD CONSTRAINT chk_device_custody CHECK (
        (status = 'INVENTORY' AND neighborhood_id IS NULL)
        OR
        (status <> 'INVENTORY' AND neighborhood_id IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE device ADD CONSTRAINT chk_device_stock_owner CHECK (
        status = 'INVENTORY' OR organization_id IS NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE device DROP CONSTRAINT chk_device_custody`,
    );
    await queryRunner.query(
      `ALTER TABLE device DROP CONSTRAINT chk_device_stock_owner`,
    );
    await queryRunner.query(
      `ALTER TYPE device_status RENAME TO device_status_new`,
    );
    await queryRunner.query(`
      CREATE TYPE device_status AS ENUM (
        'INVENTORY', 'INSTALLED', 'OPERATIONAL', 'MAINTENANCE',
        'OUT_OF_SERVICE', 'RETIRED'
      )
    `);
    await queryRunner.query(
      `ALTER TABLE device ALTER COLUMN status DROP DEFAULT`,
    );
    await queryRunner.query(`
      ALTER TABLE device
        ALTER COLUMN status TYPE device_status USING status::text::device_status
    `);
    await queryRunner.query(
      `ALTER TABLE device ALTER COLUMN status SET DEFAULT 'INVENTORY'`,
    );
    await queryRunner.query(`DROP TYPE device_status_new`);
    await queryRunner.query(`
      ALTER TABLE device ADD CONSTRAINT chk_device_custody CHECK (
        (status = 'INVENTORY' AND neighborhood_id IS NULL)
        OR
        (status <> 'INVENTORY' AND neighborhood_id IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE device ADD CONSTRAINT chk_device_stock_owner CHECK (
        status = 'INVENTORY' OR organization_id IS NULL
      )
    `);

    await queryRunner.query(
      `ALTER TABLE device DROP CONSTRAINT chk_device_height`,
    );
    await queryRunner.query(`
      ALTER TABLE device
        DROP COLUMN install_notes,
        DROP COLUMN power_point,
        DROP COLUMN reference,
        DROP COLUMN height_m,
        DROP COLUMN pole_number
    `);
  }
}
