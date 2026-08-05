import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El estado vivo guarda TODO lo que el equipo reporta (2026-08-05).
 *
 * La telemetría del panel (`tele`, ver `AlarmaESP32V6/docs/mqtt_design.md` §5.2)
 * trae mucho más de lo que guardábamos: además de `energia` manda `red` (ssid,
 * ip, rssi, reconexiones, fallos de ping, watchdogs), `rtc`, `modulos`, `ota`,
 * contadores `rf`, `sueno` y `colas`. El puente lo recibía y lo tiraba: solo se
 * quedaba con los voltajes.
 *
 * ## Dos destinos, según para qué sirve el dato
 *
 * COLUMNAS para lo que se PREGUNTA sobre la flota: "¿cuáles tienen la señal por
 * debajo de -80?", "¿cuál está en esta IP?", "¿cuáles se reconectan todo el
 * tiempo?". Es el mismo criterio con el que los voltajes son columnas y no un
 * JSONB — sin eso, esas preguntas necesitan leer todas las filas.
 *
 * JSONB (`tele`) para el RESTO del snapshot. Son datos que se miran de a un
 * equipo, en su ficha, y crecen cada vez que el firmware agrega un contador.
 * Una columna por métrica significaría una migración por versión de firmware, y
 * la web quedaría siempre un paso atrás de lo que el panel ya está mandando.
 */
export class DeviceStateNetwork1787100000000 implements MigrationInterface {
  name = 'DeviceStateNetwork1787100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE device_state
        ADD COLUMN ssid      TEXT,
        ADD COLUMN ip        TEXT,
        ADD COLUMN rssi      SMALLINT,
        ADD COLUMN recon     INT,
        ADD COLUMN ping_fail INT,
        ADD COLUMN tele      JSONB
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN device_state.rssi IS
        'Señal WiFi en dBm (negativo; -60 es buena, -80 es mala). Columna y no JSONB porque "cuáles tienen mala señal" es una pregunta de flota.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN device_state.tele IS
        'El último snapshot de telemetría COMPLETO (rtc, modulos, ota, rf, sueno, colas). JSONB para no migrar la base cada vez que el firmware agrega un contador.'
    `);

    // Índice parcial para el barrido de mantenimiento: los que están mal de
    // señal son pocos y son los que se buscan. Uno completo indexaría 200 filas
    // sanas para encontrar 3.
    await queryRunner.query(`
      CREATE INDEX idx_device_state_senal_mala
        ON device_state(rssi) WHERE rssi IS NOT NULL AND rssi < -80
    `);

    // ── upsert_panel_state: dos parámetros más ────────────────────────
    // Mismo contrato de siempre: NULL = "no tocar", nunca "poner en NULL". Un
    // `status` sin telemetría no puede borrar la última red conocida — que es
    // justo el dato que sirve para saber por qué se cayó el equipo.
    //
    // La versión vieja se BORRA primero. `CREATE OR REPLACE` con una firma
    // distinta crea una SOBRECARGA, no reemplaza: quedaban las dos, cualquier
    // llamada con parámetros nombrados se volvía ambigua, y —peor— una llamada
    // de 12 argumentos seguiría entrando por la vieja y tirando la telemetría
    // en silencio.
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS gtd.upsert_panel_state(
        TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, JSONB, TEXT, BIGINT,
        BIGINT, SMALLINT, BOOLEAN
      )
    `);

    await queryRunner.query(`
      CREATE FUNCTION gtd.upsert_panel_state(
        p_mac          TEXT,
        p_estado       TEXT     DEFAULT NULL,
        p_modo_energia TEXT     DEFAULT NULL,
        p_alarma_mode  TEXT     DEFAULT NULL,
        p_cfg_v        BIGINT   DEFAULT NULL,
        p_rf_gen       BIGINT   DEFAULT NULL,
        p_energia      JSONB    DEFAULT NULL,
        p_fw           TEXT     DEFAULT NULL,
        p_despierta    BIGINT   DEFAULT NULL,
        p_ts_device    BIGINT   DEFAULT NULL,
        p_tsq          SMALLINT DEFAULT NULL,
        p_seen         BOOLEAN  DEFAULT TRUE,
        p_red          JSONB    DEFAULT NULL,
        p_tele         JSONB    DEFAULT NULL
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_device_id INT;
        v_online    BOOLEAN     := CASE WHEN p_estado IS NULL THEN NULL
                                        ELSE (p_estado = 'online') END;
        v_sleep     TIMESTAMPTZ := CASE WHEN p_estado = 'durmiendo' AND p_despierta IS NOT NULL
                                        THEN to_timestamp(p_despierta) ELSE NULL END;
        v_ts_dev    TIMESTAMPTZ := CASE WHEN p_ts_device IS NULL THEN NULL
                                        ELSE to_timestamp(p_ts_device) END;
      BEGIN
        SELECT id INTO v_device_id FROM device WHERE mac = p_mac;

        IF v_device_id IS NULL THEN
          INSERT INTO gtd.uplink_raw (mac, tipo, payload, resultado)
          VALUES (p_mac, 'panel_state',
                  jsonb_build_object('estado', p_estado, 'energia', p_energia,
                                     'red', p_red,
                                     'cfg_v', p_cfg_v, 'rf_gen', p_rf_gen, 'fw', p_fw),
                  'unknown_device');
          RETURN 'unknown_device';
        END IF;

        INSERT INTO device_state AS ds (
          device_id, online, sleep_until, alarm_status, power_mode, cfg_v, rf_gen, fw,
          vbat, vpanel, vfuente, ts_device, tsq, last_seen, last_heartbeat, updated_at,
          ssid, ip, rssi, recon, ping_fail, tele
        ) VALUES (
          v_device_id, COALESCE(v_online, false), v_sleep, p_alarma_mode, p_modo_energia,
          COALESCE(p_cfg_v, 0), COALESCE(p_rf_gen, 0), p_fw,
          (p_energia->>'vbat')::NUMERIC, (p_energia->>'vpanel')::NUMERIC,
          (p_energia->>'vfuente')::NUMERIC, v_ts_dev, p_tsq,
          CASE WHEN p_seen THEN now() END, CASE WHEN p_seen THEN now() END, now(),
          p_red->>'ssid', p_red->>'ip', (p_red->>'rssi')::SMALLINT,
          (p_red->>'recon')::INT, (p_red->>'ping_fail')::INT, p_tele
        )
        ON CONFLICT (device_id) DO UPDATE SET
          online         = COALESCE(v_online, ds.online),
          sleep_until    = CASE WHEN p_estado = 'durmiendo' THEN v_sleep
                                WHEN p_estado IS NOT NULL   THEN NULL
                                ELSE ds.sleep_until END,
          alarm_status   = COALESCE(p_alarma_mode, ds.alarm_status),
          power_mode     = COALESCE(p_modo_energia, ds.power_mode),
          cfg_v          = COALESCE(p_cfg_v, ds.cfg_v),
          rf_gen         = COALESCE(p_rf_gen, ds.rf_gen),
          fw             = COALESCE(p_fw, ds.fw),
          vbat           = COALESCE((p_energia->>'vbat')::NUMERIC, ds.vbat),
          vpanel         = COALESCE((p_energia->>'vpanel')::NUMERIC, ds.vpanel),
          vfuente        = COALESCE((p_energia->>'vfuente')::NUMERIC, ds.vfuente),
          ssid           = COALESCE(p_red->>'ssid', ds.ssid),
          ip             = COALESCE(p_red->>'ip', ds.ip),
          rssi           = COALESCE((p_red->>'rssi')::SMALLINT, ds.rssi),
          recon          = COALESCE((p_red->>'recon')::INT, ds.recon),
          ping_fail      = COALESCE((p_red->>'ping_fail')::INT, ds.ping_fail),
          tele           = COALESCE(p_tele, ds.tele),
          ts_device      = COALESCE(v_ts_dev, ds.ts_device),
          tsq            = COALESCE(p_tsq, ds.tsq),
          last_seen      = CASE WHEN p_seen THEN now() ELSE ds.last_seen END,
          last_heartbeat = CASE WHEN p_seen THEN now() ELSE ds.last_heartbeat END,
          updated_at     = now();

        UPDATE device
           SET first_connection_at     = now(),
               first_connection_source = 'OBSERVED'
         WHERE id = v_device_id
           AND first_connection_at IS NULL
           AND COALESCE(v_online, false);

        RETURN 'ok';
      END;
      $fn$
    `);

    // La firma cambió, así que el GRANT hay que rehacerlo: para Postgres es
    // otra función. Sin esto el GtD pierde el permiso y deja de escribir.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_alarms') THEN
          GRANT EXECUTE ON FUNCTION gtd.upsert_panel_state(
            TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, JSONB, TEXT, BIGINT,
            BIGINT, SMALLINT, BOOLEAN, JSONB, JSONB
          ) TO cps_alarms;
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Hay que RESTITUIR la de 12: el `up` la borró, y sin esto revertir dejaría
    // al GtD sin ninguna función que llamar.
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS gtd.upsert_panel_state(
        TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, JSONB, TEXT, BIGINT,
        BIGINT, SMALLINT, BOOLEAN, JSONB, JSONB
      )
    `);
    await queryRunner.query(`
      CREATE FUNCTION gtd.upsert_panel_state(
        p_mac          TEXT,
        p_estado       TEXT     DEFAULT NULL,
        p_modo_energia TEXT     DEFAULT NULL,
        p_alarma_mode  TEXT     DEFAULT NULL,
        p_cfg_v        BIGINT   DEFAULT NULL,
        p_rf_gen       BIGINT   DEFAULT NULL,
        p_energia      JSONB    DEFAULT NULL,
        p_fw           TEXT     DEFAULT NULL,
        p_despierta    BIGINT   DEFAULT NULL,
        p_ts_device    BIGINT   DEFAULT NULL,
        p_tsq          SMALLINT DEFAULT NULL,
        p_seen         BOOLEAN  DEFAULT TRUE
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_device_id INT;
        v_online    BOOLEAN     := CASE WHEN p_estado IS NULL THEN NULL
                                        ELSE (p_estado = 'online') END;
        v_sleep     TIMESTAMPTZ := CASE WHEN p_estado = 'durmiendo' AND p_despierta IS NOT NULL
                                        THEN to_timestamp(p_despierta) ELSE NULL END;
        v_ts_dev    TIMESTAMPTZ := CASE WHEN p_ts_device IS NULL THEN NULL
                                        ELSE to_timestamp(p_ts_device) END;
      BEGIN
        SELECT id INTO v_device_id FROM device WHERE mac = p_mac;
        IF v_device_id IS NULL THEN
          INSERT INTO gtd.uplink_raw (mac, tipo, payload, resultado)
          VALUES (p_mac, 'panel_state',
                  jsonb_build_object('estado', p_estado, 'energia', p_energia),
                  'unknown_device');
          RETURN 'unknown_device';
        END IF;

        INSERT INTO device_state AS ds (
          device_id, online, sleep_until, alarm_status, power_mode, cfg_v, rf_gen, fw,
          vbat, vpanel, vfuente, ts_device, tsq, last_seen, last_heartbeat, updated_at
        ) VALUES (
          v_device_id, COALESCE(v_online, false), v_sleep, p_alarma_mode, p_modo_energia,
          COALESCE(p_cfg_v, 0), COALESCE(p_rf_gen, 0), p_fw,
          (p_energia->>'vbat')::NUMERIC, (p_energia->>'vpanel')::NUMERIC,
          (p_energia->>'vfuente')::NUMERIC, v_ts_dev, p_tsq,
          CASE WHEN p_seen THEN now() END, CASE WHEN p_seen THEN now() END, now()
        )
        ON CONFLICT (device_id) DO UPDATE SET
          online         = COALESCE(v_online, ds.online),
          sleep_until    = CASE WHEN p_estado = 'durmiendo' THEN v_sleep
                                WHEN p_estado IS NOT NULL   THEN NULL
                                ELSE ds.sleep_until END,
          alarm_status   = COALESCE(p_alarma_mode, ds.alarm_status),
          power_mode     = COALESCE(p_modo_energia, ds.power_mode),
          cfg_v          = COALESCE(p_cfg_v, ds.cfg_v),
          rf_gen         = COALESCE(p_rf_gen, ds.rf_gen),
          fw             = COALESCE(p_fw, ds.fw),
          vbat           = COALESCE((p_energia->>'vbat')::NUMERIC, ds.vbat),
          vpanel         = COALESCE((p_energia->>'vpanel')::NUMERIC, ds.vpanel),
          vfuente        = COALESCE((p_energia->>'vfuente')::NUMERIC, ds.vfuente),
          ts_device      = COALESCE(v_ts_dev, ds.ts_device),
          tsq            = COALESCE(p_tsq, ds.tsq),
          last_seen      = CASE WHEN p_seen THEN now() ELSE ds.last_seen END,
          last_heartbeat = CASE WHEN p_seen THEN now() ELSE ds.last_heartbeat END,
          updated_at     = now();

        UPDATE device
           SET first_connection_at     = now(),
               first_connection_source = 'OBSERVED'
         WHERE id = v_device_id
           AND first_connection_at IS NULL
           AND COALESCE(v_online, false);

        RETURN 'ok';
      END;
      $fn$
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_alarms') THEN
          GRANT EXECUTE ON FUNCTION gtd.upsert_panel_state(
            TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, JSONB, TEXT, BIGINT,
            BIGINT, SMALLINT, BOOLEAN
          ) TO cps_alarms;
        END IF;
      END
      $$
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_device_state_senal_mala`);
    await queryRunner.query(`
      ALTER TABLE device_state
        DROP COLUMN ssid,
        DROP COLUMN ip,
        DROP COLUMN rssi,
        DROP COLUMN recon,
        DROP COLUMN ping_fail,
        DROP COLUMN tele
    `);
  }
}
