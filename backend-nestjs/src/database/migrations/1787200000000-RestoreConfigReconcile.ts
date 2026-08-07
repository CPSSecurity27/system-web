import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restituye la reconciliación de `cfg_v` en `gtd.upsert_panel_state`.
 *
 * `GtdBridgeFunctions` la traía: cada vez que un panel reportaba su `cfg_v`,
 * la función acomodaba `gtd.panel_config`. `DeviceStateNetwork` reescribió la
 * función para sumarle `p_red` y `p_tele` y ese bloque **se perdió en el
 * camino** — no fue una decisión, fue una copia incompleta.
 *
 * Lo que se había roto, que no es poco:
 *
 * 1. **La red silenciosa de la escalera de confirmación.** El `tele` es la
 *    única de las tres señales con entrega durable (es retained: el broker lo
 *    reentrega aunque el GtD haya estado caído). Si se pierden el `ack` y el
 *    `cfg_full` encadenado —los dos viajan sin retain—, era lo único que movía
 *    la cola a `applied`. Sin el bloque, una configuración bien aplicada se
 *    queda en "Enviada, esperando confirmación…" para siempre.
 *
 * 2. **La detección del `factory`.** Un panel reseteado vuelve a `cfg_v = 0` y
 *    corre defaults de fábrica, pero `upsert_config_espejo` no se deja pisar
 *    por una versión más vieja: el espejo sigue mostrando la configuración
 *    anterior. Marcar la cola en `stale` es lo que hace que el GtD la
 *    republique (`fetch_pending_config` toma `pending` y `stale`) y lo que
 *    permite que la pantalla avise que lo que muestra no es lo que corre.
 *
 * La firma no cambia, así que va `CREATE OR REPLACE`: mismo nombre y mismos
 * tipos es un reemplazo de verdad —no una sobrecarga— y los GRANT del rol
 * `cps_alarms` se conservan.
 */
export class RestoreConfigReconcile1787200000000 implements MigrationInterface {
  name = 'RestoreConfigReconcile1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.upsert_panel_state(
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

        -- ── Lo que faltaba ──────────────────────────────────────────────
        -- Tras un factory el panel vuelve a cfg_v = 0 y queda con defaults de
        -- fábrica, pero nuestra panel_config sigue diciendo 40. Marcarla stale
        -- es lo que hace que alguien la republique completa.
        IF p_cfg_v = 0 THEN
          UPDATE gtd.panel_config
             SET estado = 'stale', updated_at = now()
           WHERE mac = p_mac AND estado <> 'stale';
        ELSIF p_cfg_v IS NOT NULL THEN
          -- 'failed' incluido: si el panel reporta esa cfg_v, aplicó — se autocura.
          UPDATE gtd.panel_config
             SET estado = 'applied', updated_at = now()
           WHERE mac = p_mac AND cfg_v <= p_cfg_v AND estado IN ('pending', 'sent', 'failed');
        END IF;

        RETURN 'ok';
      END;
      $fn$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Vuelve a la versión de `DeviceStateNetwork`, sin el bloque. Se restituye
    // tal cual estaba —con el agujero incluido— porque un `down` que deja algo
    // distinto de lo que había no es un `down`.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.upsert_panel_state(
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
  }
}
