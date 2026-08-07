import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fábrica de controles remotos (2026-08-05): modelo, serial y códigos únicos.
 *
 * Hasta ahora un control se creaba con un `name` a mano ("llavero cocina") y los
 * códigos se cargaban después, de a uno. Eso alcanzaba mientras los controles
 * eran un dato administrativo; no alcanza cuando hay que FABRICARLOS: sin serial
 * no se los puede distinguir en una caja de cincuenta, y sin modelo no se sabe
 * cuántos botones tiene el que se está cargando.
 *
 * ## `remote_model` — el catálogo
 *
 * Mismo patrón que `board_model`. Nace con una sola fila, la de 4 botones, que
 * es la única que el panel puede aprovechar entera: el firmware guarda 4 códigos
 * por vecino (`MQTT_RF_CODES_PER_CLI`) y la POSICIÓN decide qué hace cada uno
 * —1 emergencia, 2 sospechoso, 3 alerta, 4 apagar (`alarma_core.c::POS_TO_MODE`)—.
 * Los modelos de 2 y de 6 botones se agregan como filas cuando se decida qué
 * posiciones lleva cada uno; el de 6 además tiene dos botones que el panel no
 * puede registrar.
 *
 * ## El serial
 *
 * `CR-000137`, correlativo por secuencia. A diferencia del equipo —cuyo serial
 * se DERIVA de la MAC y por eso no se elige— el control no tiene identidad
 * propia que copiar, así que hay que dársela. El correlativo va sin el modelo
 * adentro a propósito: el serial identifica, no describe. Qué modelo es se
 * pregunta, y así un serial nunca puede mentir.
 *
 * ## `code_hmac` — el duplicado que hoy es invisible
 *
 * `code_encrypted` es AES-256-GCM con IV aleatorio: el MISMO código cifrado dos
 * veces da bytes distintos. Eso es correcto para el cifrado y hace imposible un
 * índice único sobre el ciphertext, así que hasta hoy nada impedía cargar dos
 * veces el mismo código.
 *
 * No es un detalle cosmético: el panel resuelve el `dni` buscando el código en
 * su base local, y ese `dni` es el que nosotros cargamos. Dos controles con el
 * mismo código = una alarma atribuida a la casa equivocada, con el monitoreo
 * llamando a un vecino que no apretó nada.
 *
 * Se agrega un HMAC-SHA256 determinístico (clave `REMOTE_CODES_KEY`, la misma
 * que cifra) con UNIQUE. **Con clave y no un hash pelado**: el espacio útil es
 * de 5 a 12 dígitos —`EE_CODE_MIN`/`EE_CODE_MAX` de `eeprom_store.h`— y un
 * SHA-256 sin clave sobre eso se invierte por fuerza bruta en minutos, lo que
 * convertiría la columna de índice en una filtración de los códigos.
 */
export class RemoteFactory1787300000000 implements MigrationInterface {
  name = 'RemoteFactory1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── El catálogo de modelos ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE remote_model (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        buttons SMALLINT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_remote_model_code CHECK (code ~ '^[A-Z0-9]{2,8}$'),
        -- El panel guarda 4 códigos por vecino y no hay lugar para más. Un
        -- modelo de 6 botones puede existir, pero solo 4 de sus botones van a
        -- estar registrados: el CHECK deja pasar el modelo y el tope de
        -- remote_code (position 1..4) impide grabar el quinto.
        CONSTRAINT chk_remote_model_buttons CHECK (buttons BETWEEN 1 AND 8)
      )
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_remote_model_updated BEFORE UPDATE ON remote_model
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);
    await queryRunner.query(`
      COMMENT ON TABLE remote_model IS
        'Catálogo de modelos de control remoto. La cantidad de botones es lo que decide cuántos códigos se cargan; el panel registra hasta 4.'
    `);

    // La única que hoy se puede aprovechar entera.
    await queryRunner.query(`
      INSERT INTO remote_model (code, name, buttons, notes)
      VALUES ('CR4', 'Control de 4 botones', 4,
              'Los 4 botones mapean 1:1 con los modos del panel: A emergencia, B sospechoso, C alerta, D apagar.')
    `);

    // ── El serial ─────────────────────────────────────────────────────
    await queryRunner.query(`CREATE SEQUENCE remote_serial_seq START 1`);

    await queryRunner.query(`
      ALTER TABLE remote
        ADD COLUMN serial   TEXT,
        ADD COLUMN model_id INT REFERENCES remote_model(id) ON DELETE RESTRICT,
        ADD COLUMN manufactured_at TIMESTAMPTZ,
        ADD COLUMN manufactured_by INT REFERENCES app_user(id) ON DELETE SET NULL
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_remote_serial ON remote(serial) WHERE serial IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_remote_model ON remote(model_id)`,
    );
    // Parcial y no NOT NULL: los controles que ya existen no tienen serial ni
    // modelo, y no se los puede inventar. Los nuevos SIEMPRE los traen porque
    // el alta pasa por `manufacture`, que los pone en la misma transacción.
    await queryRunner.query(`
      ALTER TABLE remote
        ADD CONSTRAINT chk_remote_serial CHECK (serial IS NULL OR serial ~ '^CR-[0-9]{6,}$')
    `);
    await queryRunner.query(`
      ALTER TABLE remote
        ADD CONSTRAINT chk_remote_fabricado CHECK (
          (serial IS NULL AND model_id IS NULL) OR
          (serial IS NOT NULL AND model_id IS NOT NULL)
        )
    `);

    // El nombre deja de ser obligatorio: lo que identifica al control es el
    // serial. Seguía siendo NOT NULL desde cuando no había otra cosa, y en la
    // fábrica obligaba a inventar un "Control (stock)" para cada uno.
    await queryRunner.query(
      `ALTER TABLE remote ALTER COLUMN name DROP NOT NULL`,
    );

    // ── El duplicado invisible ────────────────────────────────────────
    // NULL en los que ya existen (no se puede calcular sin el claro, que solo
    // sabe descifrar NestJS). Los nuevos lo traen siempre.
    await queryRunner.query(
      `ALTER TABLE remote_code ADD COLUMN code_hmac BYTEA`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_remote_code_hmac ON remote_code(code_hmac)
        WHERE code_hmac IS NOT NULL
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN remote_code.code_hmac IS
        'HMAC-SHA256 del código con REMOTE_CODES_KEY. Determinístico A PROPÓSITO: es lo único que permite un UNIQUE, porque el cifrado usa IV aleatorio. Con clave, para que no se pueda invertir por fuerza bruta sobre los 12 dígitos.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_remote_code_hmac`);
    await queryRunner.query(`ALTER TABLE remote_code DROP COLUMN code_hmac`);

    // El nombre vuelve a ser obligatorio: hay que darle uno a los que no tienen
    // o el ALTER falla. El serial es la mejor etiqueta disponible.
    await queryRunner.query(
      `UPDATE remote SET name = COALESCE(name, serial, 'Control ' || id) WHERE name IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE remote ALTER COLUMN name SET NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE remote DROP CONSTRAINT chk_remote_fabricado`,
    );
    await queryRunner.query(
      `ALTER TABLE remote DROP CONSTRAINT chk_remote_serial`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS idx_remote_model`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_remote_serial`);
    await queryRunner.query(`
      ALTER TABLE remote
        DROP COLUMN manufactured_by,
        DROP COLUMN manufactured_at,
        DROP COLUMN model_id,
        DROP COLUMN serial
    `);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS remote_serial_seq`);
    await queryRunner.query(`DROP TABLE remote_model`);
  }
}
