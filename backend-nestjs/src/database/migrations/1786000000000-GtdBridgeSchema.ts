import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Puente con el GtD — el esquema (2026-08-03).
 *
 * Ver `docs/contrato-gtd-postgres.md`. Esta migración prepara el terreno; las
 * funciones que forman el contrato van en la siguiente (`GtdBridgeFunctions`).
 *
 * Cuatro cosas:
 *
 * 1. `neighborhood.code` — el panel acepta `central.grupo` de 15 CARACTERES.
 *    "Barrio Parque Los Aromos" no entra. El código corto es lo que viaja al
 *    equipo; el nombre largo se queda en la web.
 *
 * 2. `device_state` crece. Tenía 5 columnas y el panel reporta vbat/vpanel/
 *    vfuente, que es el dato de mantenimiento más importante de un poste: sin
 *    él no se sabe si una alarma se cayó por batería o por WiFi. Van en
 *    COLUMNAS y no en un JSONB (como lo tenía el GtD) por lo mismo que los
 *    datos de instalación de `device`: para poder preguntar "¿cuáles tienen la
 *    batería por debajo de 11 V?", que es lo que sirve cuando hay que salir.
 *
 * 3. `event` crece. `external_id` guarda el `eid` del panel (`<boot_id>-<seq>`)
 *    y su índice único ES el dedup: `insert_evento` devuelve false cuando choca
 *    y el GtD depende de ese booleano para no reprocesar. `tsq` es la calidad
 *    del reloj del panel (0..4, MENOR ES MEJOR) y sin él no se puede reordenar
 *    a posteriori: con tsq >= 2 el `ts` del equipo puede estar días atrasado.
 *
 * 4. El esquema `gtd` con la cola de bajada. `panel_state` y `eventos` del GtD
 *    NO se importan: duplicarían device_state y event, y quedarían dos estados
 *    vivos libres de contradecirse (regla 5 del dominio).
 *
 * NO se renombra `device_state.alarm_status` a `alarma_mode` aunque el GtD lo
 * llame así: el resto de la tabla está en inglés y el cambio arrastraría
 * entidad, DTO y frontend por un cambio de vocabulario, no de significado. Lo
 * que cambia es el CATÁLOGO (el viejo 'connected'/'trigger' de Firebase por el
 * del firmware), y eso es un COMMENT.
 */
export class GtdBridgeSchema1786000000000 implements MigrationInterface {
  name = 'GtdBridgeSchema1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ------------------------------------------------------------------
    // 1. neighborhood.code — 15 caracteres es el límite del firmware
    // ------------------------------------------------------------------
    await queryRunner.query(`ALTER TABLE neighborhood ADD COLUMN code TEXT`);

    // Backfill: slug del nombre truncado + el id como desempate. Derivarlo solo
    // del nombre produce colisiones ("Barrio Norte" en dos localidades) y
    // truncados ilegibles; el sufijo numérico garantiza unicidad sin perder
    // legibilidad. CPS los puede reescribir después desde el panel.
    await queryRunner.query(`
      UPDATE neighborhood SET code =
        LEFT(
          COALESCE(
            NULLIF(
              TRIM(BOTH '-' FROM
                REGEXP_REPLACE(UPPER(unaccent(name)), '[^A-Z0-9]+', '-', 'g')
              ), ''
            ), 'B'
          ), 11
        ) || '-' || id
      WHERE code IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE neighborhood
        ALTER COLUMN code SET NOT NULL,
        ADD CONSTRAINT uq_neighborhood_code UNIQUE (code),
        ADD CONSTRAINT chk_neighborhood_code CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,14}$')
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN neighborhood.code IS
        'Código corto (<=15) que viaja al equipo como central.grupo. El firmware trunca en 15; el nombre largo se queda en la web.'
    `);

    // ------------------------------------------------------------------
    // 2. device_state: el estado vivo que el GtD escribe
    // ------------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE device_state
        ADD COLUMN power_mode TEXT,
        ADD COLUMN cfg_v      BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN rf_gen     BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN fw         TEXT,
        ADD COLUMN vbat       NUMERIC(5,2),
        ADD COLUMN vpanel     NUMERIC(5,2),
        ADD COLUMN vfuente    NUMERIC(5,2),
        ADD COLUMN last_seen  TIMESTAMPTZ
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN device_state.alarm_status IS
        'Catálogo del firmware: off | suspicious | alert | emergency | fire | medical | silent | panic'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN device_state.last_seen IS
        'Cuándo habló por última vez. Distinto de last_heartbeat: este lo escribe cualquier mensaje del equipo, no solo el latido.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN device_state.cfg_v IS
        'Versión de configuración que el panel dice estar corriendo. 0 tras un factory: obliga a republicar.'
    `);

    // Para el tablero de mantenimiento: "¿qué postes tienen la batería baja?"
    await queryRunner.query(`
      CREATE INDEX idx_device_state_vbat ON device_state(vbat) WHERE vbat IS NOT NULL
    `);

    // ------------------------------------------------------------------
    // 3. event: dedup por eid + el reloj del panel
    // ------------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE event
        ADD COLUMN external_id TEXT,
        ADD COLUMN ts_device   TIMESTAMPTZ,
        ADD COLUMN tsq         SMALLINT,
        ADD CONSTRAINT chk_event_tsq CHECK (tsq IS NULL OR tsq BETWEEN 0 AND 4)
    `);

    // ESTE índice es el dedup. insert_evento devuelve false cuando choca.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_event_external ON event(device_id, external_id)
        WHERE external_id IS NOT NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN event.external_id IS
        'El eid del panel (<boot_id>-<seq>). Su índice único es el dedup de la redistribución QoS 1.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN event.tsq IS
        'Calidad del reloj del panel, 0..4. MENOR ES MEJOR (0=NTP, 1=DS3231, 2=NVS, 3=RTC interno, 4=sin sync +6h). Con tsq>=2 ordenar por created_at, no por ts_device.'
    `);
    // El catálogo viejo (cps001, cps002) era de Firebase y nunca se escribió.
    await queryRunner.query(`
      COMMENT ON COLUMN event.trigger_mode IS
        'Catálogo del firmware, verbatim: off | suspicious | alert | emergency | fire | medical | silent | panic'
    `);

    // ------------------------------------------------------------------
    // 4. Esquema gtd — la cola de bajada y el dead letter
    // ------------------------------------------------------------------
    await queryRunner.query(`CREATE SCHEMA gtd`);
    await queryRunner.query(`
      COMMENT ON SCHEMA gtd IS
        'Puente con el servicio de alarmas. El GtD no toca ninguna tabla: llama funciones de acá. Ver docs/contrato-gtd-postgres.md.'
    `);

    await queryRunner.query(`
      CREATE TABLE gtd.commands (
        cid          TEXT PRIMARY KEY,
        mac          TEXT NOT NULL,
        device_id    INT  NOT NULL REFERENCES device(id) ON DELETE CASCADE,
        tipo         TEXT NOT NULL,
        payload      JSONB NOT NULL,
        estado       TEXT NOT NULL DEFAULT 'pending',
        detalle      TEXT,
        requested_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        sent_at      TIMESTAMPTZ,
        confirmed_at TIMESTAMPTZ,

        CONSTRAINT chk_commands_estado CHECK (
          estado IN ('pending', 'sent', 'ok', 'error', 'cancelled')
        ),
        -- Los 13 del firmware (CmdType). Un typo acá es un comando que el panel
        -- descarta en silencio, así que se ataja en la base.
        CONSTRAINT chk_commands_tipo CHECK (
          tipo IN ('estado', 'restart', 'alarma', 'scan', 'test', 'ota',
                   'factory', 'rf', 'refresh', 'hora', 'i2c_scan', 'red', 'cal')
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX ix_commands_pending ON gtd.commands(mac) WHERE estado = 'pending'
    `);

    await queryRunner.query(`
      CREATE TABLE gtd.panel_config (
        mac        TEXT PRIMARY KEY,
        device_id  INT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
        cfg_v      BIGINT NOT NULL CHECK (cfg_v > 0),
        payload    JSONB  NOT NULL,
        estado     TEXT   NOT NULL DEFAULT 'pending',
        updated_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT chk_panel_config_estado CHECK (
          estado IN ('pending', 'sent', 'applied', 'stale')
        )
      )
    `);
    await queryRunner.query(`
      COMMENT ON TABLE gtd.panel_config IS
        'Lo que LE MANDAMOS al panel (retained en av/<id>/cfg). cfg_v es estrictamente creciente: el firmware ignora en silencio una versión menor o igual.'
    `);

    // El espejo NO es lo que mandamos: es lo que el panel DICE que corre. Es la
    // única forma de saber qué quedó después de los clamps (el firmware recorta
    // en silencio y ackea 'ok'), y es la base del merge de publish_config.
    await queryRunner.query(`
      CREATE TABLE gtd.config_espejo (
        mac        TEXT PRIMARY KEY,
        device_id  INT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
        cfg_v      BIGINT NOT NULL,
        payload    JSONB  NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      COMMENT ON TABLE gtd.config_espejo IS
        'El último cfg_full que reportó el panel. Base del merge de publish_config: sin espejo no se puede mandar un patch parcial sin apagar módulos.'
    `);

    // Dead letter. NO es opcional: event.neighborhood_id es NOT NULL, así que
    // una alarma de un equipo en INVENTORY no se puede insertar. Sin esto, se
    // pierde.
    await queryRunner.query(`
      CREATE TABLE gtd.uplink_raw (
        id          BIGSERIAL PRIMARY KEY,
        mac         TEXT NOT NULL,
        tipo        TEXT NOT NULL,
        eid         TEXT,
        payload     JSONB NOT NULL,
        ts_device   TIMESTAMPTZ,
        tsq         SMALLINT,
        resultado   TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX ix_uplink_raw_mac ON gtd.uplink_raw(mac, received_at DESC)
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN gtd.uplink_raw.resultado IS
        'Por qué cayó acá: unknown_device | orphan | sin_destino | desarme'
    `);

    // ------------------------------------------------------------------
    // Permisos. En una base nueva los roles todavía no existen (el script
    // roles-conexion-v2.sql corre DESPUÉS de migration:run), así que se guarda
    // con un chequeo; en las bases de desarrollo ya creadas, aplica al toque.
    // El script de roles repite esto y es idempotente: los dos caminos llegan
    // al mismo lugar.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_web') THEN
          GRANT USAGE ON SCHEMA gtd TO cps_web;
          REVOKE ALL ON ALL TABLES IN SCHEMA gtd FROM cps_web;
        END IF;
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_alarms') THEN
          GRANT USAGE ON SCHEMA gtd TO cps_alarms;
          REVOKE ALL ON ALL TABLES IN SCHEMA gtd FROM cps_alarms;
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS gtd CASCADE`);

    await queryRunner.query(`DROP INDEX IF EXISTS uq_event_external`);
    await queryRunner.query(`
      ALTER TABLE event
        DROP CONSTRAINT IF EXISTS chk_event_tsq,
        DROP COLUMN IF EXISTS tsq,
        DROP COLUMN IF EXISTS ts_device,
        DROP COLUMN IF EXISTS external_id
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN event.trigger_mode IS NULL
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS idx_device_state_vbat`);
    await queryRunner.query(`
      ALTER TABLE device_state
        DROP COLUMN IF EXISTS last_seen,
        DROP COLUMN IF EXISTS vfuente,
        DROP COLUMN IF EXISTS vpanel,
        DROP COLUMN IF EXISTS vbat,
        DROP COLUMN IF EXISTS fw,
        DROP COLUMN IF EXISTS rf_gen,
        DROP COLUMN IF EXISTS cfg_v,
        DROP COLUMN IF EXISTS power_mode
    `);
    await queryRunner.query(
      `COMMENT ON COLUMN device_state.alarm_status IS NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE neighborhood
        DROP CONSTRAINT IF EXISTS chk_neighborhood_code,
        DROP CONSTRAINT IF EXISTS uq_neighborhood_code,
        DROP COLUMN IF EXISTS code
    `);
  }
}
