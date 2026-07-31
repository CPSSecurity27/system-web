import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Identidad del equipo desde la MAC (2026-07-28).
 *
 * Alinea el modelo con el contrato del servicio de alarmas (GtD): el equipo se
 * da de alta con su MAC (`esptool read_mac`) y el número impreso en la placa
 * (`ALOY0043`), y el `serial` deja de elegirse — se DERIVA como `AV-<12 hex>`.
 * Ese string es a la vez el usuario MQTT, el client_id y el `<id>` del tópico
 * (`av/AV-A842E38FCA6C/status`); de que sean el mismo depende que la ACL del
 * broker sea una regla `pattern av/%u/…` para toda la flota en vez de cinco
 * líneas por equipo.
 *
 * Incluye el rename de `ALARM_PANEL` a `COMMUNITY_ALARM`: "panel" es la cajita
 * en la pared de una casa, justo lo que la regla 1 del dominio dice que esto no
 * es.
 */
export class DeviceMacIdentity1785400000000 implements MigrationInterface {
  name = 'DeviceMacIdentity1785400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE device_type RENAME VALUE 'ALARM_PANEL' TO 'COMMUNITY_ALARM'`,
    );

    // Catálogo de modelos de placa. El número de cada placa viene IMPRESO de
    // fábrica como <code><4 dígitos>; acá vive el prefijo y en device.board_seq
    // el número. Es catálogo y no enum para que un modelo nuevo sea un INSERT y
    // no una migración con deploy, y para poder colgarle atributos de hardware.
    //
    // El CHECK valida la FORMA y no la familia a propósito: clavar 'ALOY' solo
    // bloquearía una placa de otro proveedor sin comprar nada a cambio.
    await queryRunner.query(`
      CREATE TABLE board_model (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_board_model_code CHECK (code ~ '^[A-Z]{2,8}$')
      )
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_board_model_updated BEFORE UPDATE ON board_model
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);
    await queryRunner.query(
      `INSERT INTO board_model (code, name) VALUES ('ALOY', 'ALOY')`,
    );

    await queryRunner.query(`
      ALTER TABLE device
        ADD COLUMN board_model_id INT REFERENCES board_model(id) ON DELETE RESTRICT,
        ADD COLUMN board_seq INT,
        ADD COLUMN mqtt_provisioned_at TIMESTAMPTZ,
        ADD COLUMN mqtt_provisioned_by INT REFERENCES app_user(id) ON DELETE SET NULL
    `);

    // Un solo formato canónico de MAC (12 hex MAYÚSCULAS, sin separadores) o el
    // UNIQUE no sirve de nada: 'a8:42:…' y 'A842…' serían dos filas del mismo
    // equipo.
    await queryRunner.query(`
      ALTER TABLE device
        ADD CONSTRAINT chk_device_mac_format
          CHECK (mac IS NULL OR mac ~ '^[0-9A-F]{12}$'),
        ADD CONSTRAINT chk_device_board_seq
          CHECK (board_seq IS NULL OR (board_seq BETWEEN 1 AND 9999)),
        ADD CONSTRAINT chk_device_identity CHECK (
          type <> 'COMMUNITY_ALARM'
          OR (
            mac IS NOT NULL
            AND serial = 'AV-' || mac
            AND board_model_id IS NOT NULL
            AND board_seq IS NOT NULL
          )
        )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_device_mac ON device(mac) WHERE mac IS NOT NULL
    `);
    // El número impreso en la placa (ALOY0043) es único por modelo.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_device_board ON device(board_model_id, board_seq)
        WHERE board_model_id IS NOT NULL AND board_seq IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_device_board`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_device_mac`);
    await queryRunner.query(`
      ALTER TABLE device
        DROP CONSTRAINT IF EXISTS chk_device_identity,
        DROP CONSTRAINT IF EXISTS chk_device_board_seq,
        DROP CONSTRAINT IF EXISTS chk_device_mac_format
    `);
    await queryRunner.query(`
      ALTER TABLE device
        DROP COLUMN IF EXISTS mqtt_provisioned_by,
        DROP COLUMN IF EXISTS mqtt_provisioned_at,
        DROP COLUMN IF EXISTS board_seq,
        DROP COLUMN IF EXISTS board_model_id
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS board_model`);
    await queryRunner.query(
      `ALTER TYPE device_type RENAME VALUE 'COMMUNITY_ALARM' TO 'ALARM_PANEL'`,
    );
  }
}
