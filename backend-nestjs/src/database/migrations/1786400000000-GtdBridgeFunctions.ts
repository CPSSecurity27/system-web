import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Puente con el GtD — el contrato por funciones (2026-08-03).
 *
 * Ver `docs/contrato-gtd-postgres.md`. El GtD NO toca ninguna tabla: llama estas
 * funciones. Adentro decidimos a qué tabla va cada cosa, así un cambio de mapeo
 * es una migración nuestra y no un deploy coordinado de dos servicios.
 *
 * Las 8 de ENTRADA son 1:1 con el `Protocol Repo` de ellos
 * (`src/gtd/db/repo.py`), que ya viene normalizado: sus pipelines parsean el
 * JSON y llaman métodos con campos nombrados. `PgRepo` queda como un envoltorio
 * de una línea por método. Una función por TÓPICO MQTT los habría obligado a
 * reescribir los pipelines, que es justo lo que su README pide no tocar.
 *
 * Todas son SECURITY DEFINER: así se le puede sacar a `cps_alarms` el
 * INSERT/UPDATE directo sobre device_state y event y dejarle solo EXECUTE. El
 * contrato lo impone el motor, no la disciplina.
 *
 * `SET search_path = public, gtd, pg_temp` en cada una: sin eso, SECURITY
 * DEFINER es un agujero de escalada de privilegios.
 *
 * Devuelven texto en vez de tirar excepción: una excepción en Postgres mata la
 * transacción y con ella el pipeline del GtD.
 *
 * DECISIÓN — el desarme (`t:alarma` con `mode:"off"`) NO crea ni resuelve
 * evento. Apagar la sirena no es "el incidente terminó": el paso OPEN ->
 * RESOLVED es una decisión operativa con autor (`resolved_by_user_id` + el
 * snapshot del nombre), y un `off` desde un llavero no tiene esa autoridad.
 * Además los GRANTs ya dicen que el servicio de alarmas crea eventos y no los
 * resuelve. No se pierde nada: el desarme queda en `gtd.uplink_raw` con su ts y
 * su dni, y el estado vivo lo refleja al instante en `device_state`. Si algún
 * día se quiere una línea de tiempo por evento, los datos están.
 */
export class GtdBridgeFunctions1786400000000 implements MigrationInterface {
  name = 'GtdBridgeFunctions1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ==================================================================
    // ENTRADA — las llama el GtD (cps_alarms). 1:1 con el Protocol Repo.
    // ==================================================================

    // ── upsert_panel_state ────────────────────────────────────────────
    // NULL significa "no tocar", NO "poner en NULL": en el Repo todos los
    // parámetros son `| None = None`. Si esto se implementa mal, un `status`
    // sin voltajes borra el último vbat conocido — justo el dato que sirve para
    // saber por qué se cayó el equipo.
    //
    // v2 (2026-08-04, respuestas al doc 06 del GtD):
    //  - p_estado reemplaza a p_online: 'durmiendo' NO es 'offline' — "duerme
    //    hasta las 7" y "se cayó a las 3 AM" son la diferencia entre despertar
    //    a un técnico y no (P1-4). online se DERIVA (= estado 'online').
    //  - last_seen lo pone el SERVIDOR (now()): el reloj del panel puede estar
    //    días atrás con tsq>=2 (P1-3). Lo que el panel declara viaja aparte
    //    (p_ts_device + p_tsq), para auditar deriva.
    //  - p_seen=false es el watchdog del GtD marcando offline: el panel NO
    //    habló, así que last_seen no se toca.
    //  - p_fw entra en la firma (P2-5): antes solo llegaba por el cfg_full.
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
        -- Un estado desconocido mapea a offline (conservador: llama la atención).
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
                                     'cfg_v', p_cfg_v, 'rf_gen', p_rf_gen, 'fw', p_fw),
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
          -- El estado explícito manda: 'durmiendo' fija sleep_until, cualquier
          -- otro la limpia (despertó o se cayó), NULL no la toca.
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
          -- last_seen es el reloj del SERVIDOR: cuándo lo escuchamos, no cuándo
          -- el panel cree que habló. p_seen=false = el panel NO habló.
          last_seen      = CASE WHEN p_seen THEN now() ELSE ds.last_seen END,
          last_heartbeat = CASE WHEN p_seen THEN now() ELSE ds.last_heartbeat END,
          updated_at     = now();

        -- Hito de primera conexión: es un hecho OBSERVADO por el broker, que es
        -- exactamente para lo que existe device_milestone_source.
        UPDATE device
           SET first_connection_at     = now(),
               first_connection_source = 'OBSERVED'
         WHERE id = v_device_id
           AND first_connection_at IS NULL
           AND COALESCE(v_online, false);

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

    // ── insert_evento ─────────────────────────────────────────────────
    // Devuelve FALSE si el eid ya existía. El GtD depende de ese booleano: es
    // el dedup de la redistribución QoS 1 dentro de una sesión.
    await queryRunner.query(`
      CREATE FUNCTION gtd.insert_evento(
        p_mac     TEXT,
        p_tipo    TEXT,
        p_payload JSONB,
        p_eid     TEXT   DEFAULT NULL,
        p_ts      BIGINT DEFAULT NULL
      ) RETURNS BOOLEAN
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_device        device%ROWTYPE;
        v_ts            TIMESTAMPTZ := CASE WHEN p_ts IS NULL
                                            THEN NULL ELSE to_timestamp(p_ts) END;
        v_tsq           SMALLINT    := (p_payload->>'tsq')::SMALLINT;
        v_mode          TEXT        := p_payload->>'mode';
        v_dni           TEXT        := NULLIF(p_payload->>'dni', '0');
        v_origin        event_origin;
        v_user          app_user%ROWTYPE;
        v_home_id       INT;
        v_remote_id     INT;
        v_event_id      BIGINT;
        v_resultado     TEXT;
      BEGIN
        SELECT * INTO v_device FROM device WHERE mac = p_mac;

        -- Todo lo que no es una alarma con destino termina en el dead letter.
        -- Nada se descarta: event.neighborhood_id es NOT NULL, así que sin esto
        -- una alarma de un equipo sin barrio se perdería para siempre.
        v_resultado := CASE
          WHEN v_device.id IS NULL              THEN 'unknown_device'
          WHEN p_tipo <> 'alarma'               THEN 'sin_destino'
          WHEN v_mode = 'off'                   THEN 'desarme'
          WHEN v_device.neighborhood_id IS NULL THEN 'orphan'
          ELSE NULL
        END;

        IF v_resultado IS NOT NULL THEN
          INSERT INTO gtd.uplink_raw (mac, tipo, eid, payload, ts_device, tsq, resultado)
          VALUES (p_mac, p_tipo, p_eid, p_payload, v_ts, v_tsq, v_resultado);
          -- TRUE porque no es un duplicado: el GtD no debe reintentar.
          RETURN true;
        END IF;

        v_origin := CASE p_payload->>'origin'
          WHEN 'rf'     THEN 'REMOTE'   -- control remoto del hogar
          WHEN 'mqtt'   THEN 'APP'      -- disparo por comando del servidor
          WHEN 'auto'   THEN 'DEVICE'   -- el propio equipo
          WHEN 'portal' THEN 'PANEL'    -- portal cautivo local (rol tec/cps)
          ELSE 'DEVICE'
        END::event_origin;

        -- El dni que vuelve es el que NOSOTROS cargamos en la base RF del panel
        -- (cmd t:rf op:batch). El panel no dispara con un código que no tiene,
        -- así que un dni desconocido acá es una inconsistencia nuestra, no del
        -- equipo: se registra el evento igual, sin activador.
        IF v_dni IS NOT NULL THEN
          SELECT * INTO v_user FROM app_user WHERE dni = v_dni;
          SELECT home_id INTO v_home_id
            FROM home_member WHERE user_id = v_user.id AND status = 'ACTIVE';
          SELECT id INTO v_remote_id
            FROM remote
           WHERE assigned_to_user_id = v_user.id AND device_id = v_device.id
           LIMIT 1;
        END IF;

        INSERT INTO event (
          neighborhood_id, device_id, home_id, remote_id,
          origin, trigger_mode, external_id, ts_device, tsq,
          activator_user_id, activator_name, activator_phone
        ) VALUES (
          v_device.neighborhood_id, v_device.id, v_home_id, v_remote_id,
          v_origin, v_mode, p_eid, v_ts, v_tsq,
          v_user.id, v_user.name, v_user.telephone
        )
        ON CONFLICT (device_id, external_id) WHERE external_id IS NOT NULL
        DO NOTHING
        RETURNING id INTO v_event_id;

        RETURN v_event_id IS NOT NULL;
      END;
      $fn$
    `);

    // ── confirm_command ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE FUNCTION gtd.confirm_command(
        p_cid TEXT,
        p_res TEXT DEFAULT NULL,
        p_det TEXT DEFAULT NULL
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      BEGIN
        UPDATE gtd.commands
           SET estado       = CASE WHEN p_res = 'ok' THEN 'ok' ELSE 'error' END,
               detalle      = p_det,
               confirmed_at = now()
         WHERE cid = p_cid;

        IF NOT FOUND THEN
          RETURN 'unknown_cid';
        END IF;
        RETURN 'ok';
      END;
      $fn$
    `);

    // ── upsert_config_espejo ──────────────────────────────────────────
    // Arbitra por cfg_v: no pisa el espejo con una versión más vieja que la
    // guardada (requisito explícito del GtD).
    //
    // El espejo NO es lo que mandamos: es lo que el panel DICE que corre. Los
    // clamps del firmware RECORTAN en silencio y ackean 'ok' — si mandás
    // send_tele_s=5 el panel guarda 30 — así que esta es la única fuente
    // confiable de qué configuración está vigente, y la base del merge.
    await queryRunner.query(`
      CREATE FUNCTION gtd.upsert_config_espejo(
        p_mac     TEXT,
        p_cfg_v   BIGINT,
        p_payload JSONB
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_device_id INT;
      BEGIN
        SELECT id INTO v_device_id FROM device WHERE mac = p_mac;
        IF v_device_id IS NULL THEN
          INSERT INTO gtd.uplink_raw (mac, tipo, payload, resultado)
          VALUES (p_mac, 'cfg_full', p_payload, 'unknown_device');
          RETURN 'unknown_device';
        END IF;

        INSERT INTO gtd.config_espejo AS ce (mac, device_id, cfg_v, payload, updated_at)
        VALUES (p_mac, v_device_id, p_cfg_v, p_payload, now())
        ON CONFLICT (mac) DO UPDATE
          SET cfg_v      = EXCLUDED.cfg_v,
              payload    = EXCLUDED.payload,
              updated_at = now()
        WHERE ce.cfg_v <= EXCLUDED.cfg_v;

        -- El cfg_full es el ÚNICO lugar donde viaja la versión de firmware
        -- (id.fw) — upsert_panel_state no la recibe. Y rf.gen es la generación
        -- de la base RF, que dice si el panel tiene los códigos al día.
        UPDATE device_state
           SET fw     = COALESCE(p_payload->'id'->>'fw', fw),
               rf_gen = COALESCE((p_payload->'rf'->>'gen')::BIGINT, rf_gen),
               updated_at = now()
         WHERE device_id = v_device_id;

        RETURN 'ok';
      END;
      $fn$
    `);

    // ── fetch_pending_commands / mark_command_sent ────────────────────
    await queryRunner.query(`
      CREATE FUNCTION gtd.fetch_pending_commands(p_mac TEXT)
      RETURNS TABLE (cid TEXT, tipo TEXT, payload JSONB)
      LANGUAGE sql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
        SELECT c.cid, c.tipo, c.payload
          FROM gtd.commands c
         WHERE c.mac = p_mac AND c.estado = 'pending'
         ORDER BY c.created_at;
      $fn$
    `);

    await queryRunner.query(`
      CREATE FUNCTION gtd.mark_command_sent(p_cid TEXT) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      BEGIN
        UPDATE gtd.commands
           SET estado = 'sent', sent_at = now()
         WHERE cid = p_cid AND estado = 'pending';
        RETURN CASE WHEN FOUND THEN 'ok' ELSE 'unknown_cid' END;
      END;
      $fn$
    `);

    // ── fetch_pending_config / mark_config_sent ───────────────────────
    // Acá es donde va el descifrado de las passwords WiFi cuando se implemente
    // el cifrado en reposo (DT2): así el claro nunca sale de Postgres y el GtD
    // no necesita saber cómo están guardadas.
    await queryRunner.query(`
      CREATE FUNCTION gtd.fetch_pending_config(p_mac TEXT)
      RETURNS TABLE (cfg_v BIGINT, payload JSONB)
      LANGUAGE sql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
        SELECT pc.cfg_v, pc.payload
          FROM gtd.panel_config pc
         WHERE pc.mac = p_mac AND pc.estado IN ('pending', 'stale');
      $fn$
    `);

    await queryRunner.query(`
      CREATE FUNCTION gtd.mark_config_sent(p_mac TEXT, p_cfg_v BIGINT) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      BEGIN
        UPDATE gtd.panel_config
           SET estado = 'sent', updated_at = now()
         WHERE mac = p_mac AND cfg_v = p_cfg_v AND estado IN ('pending', 'stale');
        RETURN CASE WHEN FOUND THEN 'ok' ELSE 'noop' END;
      END;
      $fn$
    `);

    // ==================================================================
    // SALIDA — las llama la web (cps_web).
    // Acá las funciones no son aislamiento (el esquema es nuestro): son
    // ATOMICIDAD y AUDITORÍA — generar el cid, incrementar el cfg_v sin
    // carrera, dejar el audit_log.
    // ==================================================================

    await queryRunner.query(`
      CREATE FUNCTION gtd.enqueue_command(
        p_device_id INT,
        p_tipo      TEXT,
        p_params    JSONB DEFAULT '{}'::JSONB,
        p_user_id   INT   DEFAULT NULL
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_mac TEXT;
        v_cid TEXT;
      BEGIN
        SELECT mac INTO v_mac FROM device WHERE id = p_device_id;
        IF v_mac IS NULL THEN
          RAISE EXCEPTION 'El equipo % no existe o no tiene MAC', p_device_id;
        END IF;

        -- El cid viaja en el tópico y vuelve en el ack; MQTT_CID_MAXLEN es 24.
        v_cid := 'cmd-' || REPLACE(gen_random_uuid()::TEXT, '-', '');
        v_cid := LEFT(v_cid, 24);

        INSERT INTO gtd.commands (cid, mac, device_id, tipo, payload, requested_by)
        VALUES (v_cid, v_mac, p_device_id, p_tipo,
                COALESCE(p_params, '{}'::JSONB)
                  || jsonb_build_object('t', p_tipo, 'cid', v_cid),
                p_user_id);

        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, new_value)
        VALUES (p_user_id, 'gtd.command.enqueue', 'device', p_device_id,
                jsonb_build_object('cid', v_cid, 'tipo', p_tipo, 'params', p_params));

        RETURN v_cid;
      END;
      $fn$
    `);

    // ── publish_config ────────────────────────────────────────────────
    // El merge del firmware es POR SECCIÓN, no por campo: dentro de una sección
    // los subcampos ausentes toman su DEFAULT, no el valor actual. Mandar
    // {"modulos":{"rf":true}} APAGA ds3231, eeprom y supervisor — sin error y
    // con ack 'ok'. Lo mismo borra `central` y reemplaza `redes` entero.
    //
    // Por eso el merge se hace acá contra el espejo, y por eso se RECHAZA el
    // patch cuando no hay espejo: mandar `modulos` a ciegas apaga módulos.
    await queryRunner.query(`
      CREATE FUNCTION gtd.publish_config(
        p_device_id INT,
        p_patch     JSONB,
        p_user_id   INT DEFAULT NULL
      ) RETURNS BIGINT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_mac      TEXT;
        v_base     JSONB;
        v_payload  JSONB;
        v_cfg_v    BIGINT;
        v_patch    JSONB := COALESCE(p_patch, '{}'::JSONB);
      BEGIN
        SELECT mac INTO v_mac FROM device WHERE id = p_device_id;
        IF v_mac IS NULL THEN
          RAISE EXCEPTION 'El equipo % no existe o no tiene MAC', p_device_id;
        END IF;

        SELECT payload INTO v_base FROM gtd.config_espejo WHERE mac = v_mac;
        IF v_base IS NULL THEN
          RAISE EXCEPTION
            'Sin espejo de configuración para %: el equipo nunca reportó su cfg_full. Un patch parcial a ciegas apagaría módulos.', v_mac;
        END IF;

        -- Las tres secciones peligrosas se emiten SIEMPRE completas, tomando
        -- del espejo lo que el patch no traiga.
        -- El espejo es un cfg_full, y el cfg_full trae secciones de SOLO LECTURA
        -- que el cfg de bajada no acepta: id (identidad), rf (base RF, se toca
        -- con cmd t:rf) y cal (calibración, con cmd t:cal). Mandarlas de vuelta
        -- es ruido, y el panel solo acepta 1024 bytes de entrada
        -- (MQTT_IN_PAYLOAD_MAX): cada byte de más acerca el límite en el que una
        -- cfg con 5 redes deja de entrar.
        v_payload := (v_base - 'id' - 'rf' - 'cal') || v_patch;
        v_payload := v_payload || jsonb_build_object(
          'modulos', COALESCE(v_base->'modulos', '{}'::JSONB) || COALESCE(v_patch->'modulos', '{}'::JSONB),
          'central', COALESCE(v_base->'central', '{}'::JSONB) || COALESCE(v_patch->'central', '{}'::JSONB),
          'redes',   COALESCE(v_patch->'redes', v_base->'redes', '[]'::JSONB)
        );

        -- Identidad: no se tipea en ninguna pantalla, se GENERA. Si un operador
        -- la pudiera escribir, en seis meses el poste se llamaría distinto en la
        -- web y en el equipo y no habría forma de saber cuál miente.
        -- Los límites son del firmware: alias 31, ubicacion 63, grupo 15.
        SELECT v_payload || jsonb_build_object('central', jsonb_build_object(
                 'alias',     LEFT(COALESCE(d.name, d.serial), 31),
                 'ubicacion', LEFT(COALESCE(d.reference, d.pole_number, ''), 63),
                 'grupo',     LEFT(COALESCE(n.code, ''), 15)
               ))
          INTO v_payload
          FROM device d
          LEFT JOIN neighborhood n ON n.id = d.neighborhood_id
         WHERE d.id = p_device_id;

        -- cfg_v estrictamente creciente: el firmware ignora EN SILENCIO (sin
        -- ack, ni ok ni error) una versión menor o igual a la que corre.
        SELECT COALESCE(MAX(v), 0) + 1 INTO v_cfg_v FROM (
          SELECT cfg_v AS v FROM gtd.panel_config WHERE mac = v_mac
          UNION ALL
          SELECT cfg_v FROM gtd.config_espejo WHERE mac = v_mac
        ) s;

        v_payload := v_payload || jsonb_build_object('cfg_v', v_cfg_v);

        INSERT INTO gtd.panel_config (mac, device_id, cfg_v, payload, estado, updated_by, updated_at)
        VALUES (v_mac, p_device_id, v_cfg_v, v_payload, 'pending', p_user_id, now())
        ON CONFLICT (mac) DO UPDATE
          SET cfg_v = EXCLUDED.cfg_v, payload = EXCLUDED.payload,
              estado = 'pending', updated_by = EXCLUDED.updated_by, updated_at = now();

        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, new_value)
        VALUES (p_user_id, 'gtd.config.publish', 'device', p_device_id,
                jsonb_build_object('cfg_v', v_cfg_v, 'patch', v_patch));

        RETURN v_cfg_v;
      END;
      $fn$
    `);

    await queryRunner.query(`
      CREATE FUNCTION gtd.cancel_command(p_cid TEXT, p_user_id INT DEFAULT NULL)
      RETURNS BOOLEAN
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      BEGIN
        -- Un comando ya enviado no se cancela: se compensa.
        UPDATE gtd.commands SET estado = 'cancelled', detalle = 'cancelado desde el panel'
         WHERE cid = p_cid AND estado = 'pending';
        IF NOT FOUND THEN
          RETURN false;
        END IF;

        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, new_value)
        VALUES (p_user_id, 'gtd.command.cancel', 'device',
                (SELECT device_id FROM gtd.commands WHERE cid = p_cid),
                jsonb_build_object('cid', p_cid));
        RETURN true;
      END;
      $fn$
    `);

    // ── enqueue_rf_batch ──────────────────────────────────────────────
    // La base RF (qué código de 64 bits es de qué vecino) la carga EL SERVIDOR.
    // Un código que no está en el panel NO DISPARA NADA: ni evento, ni log
    // remoto. Sin este flujo, un barrio tiene alarmas instaladas que no suenan.
    //
    // No puede ser un `sync` en SQL puro: remote_code.code_encrypted es
    // AES-256-GCM y la base NUNCA ve el claro — la clave la tiene el backend
    // NestJS. Así que el descifrado pasa en Node y los lotes entran ya armados.
    await queryRunner.query(`
      CREATE FUNCTION gtd.enqueue_rf_batch(
        p_device_id INT,
        p_lotes     JSONB,
        p_user_id   INT DEFAULT NULL
      ) RETURNS INT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_lote  JSONB;
        v_count INT := 0;
      BEGIN
        IF jsonb_typeof(p_lotes) <> 'array' THEN
          RAISE EXCEPTION 'p_lotes tiene que ser un array de lotes (hasta 5 clientes cada uno)';
        END IF;

        FOR v_lote IN SELECT * FROM jsonb_array_elements(p_lotes) LOOP
          PERFORM gtd.enqueue_command(
            p_device_id, 'rf',
            jsonb_build_object('op', 'batch', 'clientes', v_lote),
            p_user_id
          );
          v_count := v_count + 1;
        END LOOP;

        RETURN v_count;
      END;
      $fn$
    `);

    // ==================================================================
    // NOTIFY — el bus de bajada y el aviso a la web
    // ==================================================================
    await queryRunner.query(`
      CREATE FUNCTION gtd.notify_gtd_commands() RETURNS TRIGGER
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.estado = 'pending' THEN
          PERFORM pg_notify('gtd_commands', NEW.mac);
        END IF;
        RETURN NEW;
      END;
      $fn$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_commands_notify AFTER INSERT OR UPDATE ON gtd.commands
        FOR EACH ROW EXECUTE FUNCTION gtd.notify_gtd_commands()
    `);

    await queryRunner.query(`
      CREATE FUNCTION gtd.notify_gtd_config() RETURNS TRIGGER
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.estado IN ('pending', 'stale') THEN
          PERFORM pg_notify('gtd_config', NEW.mac);
        END IF;
        RETURN NEW;
      END;
      $fn$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_config_notify AFTER INSERT OR UPDATE ON gtd.panel_config
        FOR EACH ROW EXECUTE FUNCTION gtd.notify_gtd_config()
    `);

    // Solo ante CAMBIO REAL. El trigger original del GtD disparaba en cada
    // INSERT OR UPDATE, y la cola de pg_notify llena hace fallar los COMMIT, no
    // solo las notificaciones. No se notifica por voltaje ni por last_seen:
    // para eso el tablero poll-ea. El NOTIFY es para lo que no puede esperar.
    //
    // La comparación va en el CUERPO y no en un WHEN: en INSERT no existe OLD.
    await queryRunner.query(`
      CREATE FUNCTION gtd.notify_app_panel_state() RETURNS TRIGGER
      LANGUAGE plpgsql AS $fn$
      DECLARE
        v_mac TEXT;
      BEGIN
        IF TG_OP = 'INSERT'
           OR NEW.online       IS DISTINCT FROM OLD.online
           OR NEW.alarm_status IS DISTINCT FROM OLD.alarm_status
           OR NEW.cfg_v        IS DISTINCT FROM OLD.cfg_v
           OR NEW.rf_gen       IS DISTINCT FROM OLD.rf_gen
           OR NEW.power_mode   IS DISTINCT FROM OLD.power_mode
        THEN
          SELECT mac INTO v_mac FROM device WHERE id = NEW.device_id;
          PERFORM pg_notify('app_panel_state', COALESCE(v_mac, NEW.device_id::TEXT));
        END IF;
        RETURN NEW;
      END;
      $fn$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_panel_state_notify AFTER INSERT OR UPDATE ON device_state
        FOR EACH ROW EXECUTE FUNCTION gtd.notify_app_panel_state()
    `);

    // ==================================================================
    // Permisos: el contrato lo impone el motor.
    // Guardado por si los roles todavía no existen (en una base nueva el
    // script roles-conexion-v2.sql corre DESPUÉS de migration:run).
    // ==================================================================
    // Postgres le da EXECUTE a PUBLIC por defecto en TODA función nueva. Sin
    // este REVOKE, revocarle a un rol en particular no sirve de nada: lo sigue
    // teniendo por PUBLIC, y el servicio de alarmas podría encolar comandos.
    // Va primero y sin guarda: PUBLIC siempre existe.
    await queryRunner.query(`
      REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA gtd FROM PUBLIC
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_alarms') THEN
          REVOKE INSERT, UPDATE ON device_state FROM cps_alarms;
          REVOKE INSERT ON event FROM cps_alarms;
          REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA gtd FROM cps_alarms;
          GRANT EXECUTE ON FUNCTION
            gtd.upsert_panel_state(TEXT, BOOLEAN, TEXT, TEXT, BIGINT, BIGINT, JSONB, BIGINT),
            gtd.insert_evento(TEXT, TEXT, JSONB, TEXT, BIGINT),
            gtd.confirm_command(TEXT, TEXT, TEXT),
            gtd.upsert_config_espejo(TEXT, BIGINT, JSONB),
            gtd.fetch_pending_commands(TEXT),
            gtd.fetch_pending_config(TEXT),
            gtd.mark_command_sent(TEXT),
            gtd.mark_config_sent(TEXT, BIGINT)
          TO cps_alarms;
        END IF;

        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_web') THEN
          REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA gtd FROM cps_web;
          GRANT EXECUTE ON FUNCTION
            gtd.enqueue_command(INT, TEXT, JSONB, INT),
            gtd.publish_config(INT, JSONB, INT),
            gtd.cancel_command(TEXT, INT),
            gtd.enqueue_rf_batch(INT, JSONB, INT)
          TO cps_web;
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_panel_state_notify ON device_state`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_config_notify ON gtd.panel_config`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_commands_notify ON gtd.commands`,
    );

    for (const fn of [
      'gtd.notify_app_panel_state()',
      'gtd.notify_gtd_config()',
      'gtd.notify_gtd_commands()',
      'gtd.enqueue_rf_batch(INT, JSONB, INT)',
      'gtd.cancel_command(TEXT, INT)',
      'gtd.publish_config(INT, JSONB, INT)',
      'gtd.enqueue_command(INT, TEXT, JSONB, INT)',
      'gtd.mark_config_sent(TEXT, BIGINT)',
      'gtd.fetch_pending_config(TEXT)',
      'gtd.mark_command_sent(TEXT)',
      'gtd.fetch_pending_commands(TEXT)',
      'gtd.upsert_config_espejo(TEXT, BIGINT, JSONB)',
      'gtd.confirm_command(TEXT, TEXT, TEXT)',
      'gtd.insert_evento(TEXT, TEXT, JSONB, TEXT, BIGINT)',
      'gtd.upsert_panel_state(TEXT, BOOLEAN, TEXT, TEXT, BIGINT, BIGINT, JSONB, BIGINT)',
    ]) {
      await queryRunner.query(`DROP FUNCTION IF EXISTS ${fn}`);
    }

    // Los GRANT directos que el contrato reemplazó
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_alarms') THEN
          GRANT INSERT, UPDATE ON device_state TO cps_alarms;
          GRANT INSERT ON event TO cps_alarms;
        END IF;
      END
      $$
    `);
  }
}
