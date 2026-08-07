import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cerrar el evento cuando el equipo avisa que lo desarmaron (2026-08-07).
 *
 * ── El bug ──
 *
 * Apagar la alarma con el control remoto (botón D) no cerraba el evento: el
 * tablero seguía mostrando una emergencia en curso con la sirena ya apagada, y
 * —desde que existe la proyección— la app de los vecinos mostraba 'Activada'
 * para siempre.
 *
 * Reportado y reproducido en producción el 2026-08-07. La evidencia, de
 * `gtd.uplink_raw`, son dos filas del mismo hecho por vías distintas:
 *
 *   id  mode  origin  cid            resultado   evento
 *   363 off   mqtt    cmd-4b96…      desarme     68 -> RESOLVED
 *   364 off   rf      (vacío)        desarme     69 -> sigue OPEN
 *
 * ── La causa ──
 *
 * `LegacyAppBridge` cerraba con `IF v_resultado = 'desarme' AND v_cid IS NOT
 * NULL`, y **el firmware solo manda `cid` cuando `origin='mqtt'`** (contrato
 * MQTT §up: "`dni`/`codigos`: solo si `origin='rf'`. `cid`: solo si
 * `origin='mqtt'`"). Un desarme por RF nunca entraba en esa rama.
 *
 * ── Por qué la corrección es más ancha que el bug ──
 *
 * Aquella migración acotó el cierre a la puerta vieja a propósito, para no
 * cambiar en silencio el comportamiento de los otros orígenes. Ese recorte era
 * el equivocado: que un evento se cierre cuando el equipo reporta que se
 * desarmó **no es un asunto del legado, es una regla del dominio**, y valía
 * igual para el botón D y para el "apagar" del panel web — que hoy tampoco
 * cerraba nada (tiene `cid`, pero no fila en `legacy_activation`).
 *
 * Por eso `close_legacy_events` se reemplaza por `resolve_on_disarm`, que no
 * sabe nada del legado y sirve a los tres caminos.
 *
 * ── El origen `auto` NO cierra, y es la parte importante ──
 *
 * El panel apaga la sirena solo cuando vence `alarma.autooff`, y eso llega como
 * un desarme más, con `origin='auto'`. Cerrar el evento ahí sería decir que la
 * emergencia terminó porque se acabó el temporizador de la sirena — que es
 * justo lo contrario de lo que necesita el monitoreo. Solo cierra un desarme
 * que hizo UNA PERSONA: `rf` (apretó el botón D), `mqtt` (lo mandó apagar) o
 * `portal` (un técnico en el equipo).
 *
 * ── Quién queda como responsable del cierre ──
 *
 * Con lo que haya, en este orden:
 *   1. `dni` del payload      — el control que apretó el botón D (origin='rf')
 *   2. `gtd.legacy_activation` — el vecino, si vino por la app vieja
 *   3. `gtd.commands.requested_by` — el usuario del panel web
 * Y si no hay ninguno, un texto que dice de dónde vino. Nunca queda en blanco:
 * un evento cerrado sin decir quién lo cerró no sirve cuando hay que preguntar.
 */
export class ResolveOnDisarm1788500000000 implements MigrationInterface {
  name = 'ResolveOnDisarm1788500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION gtd.resolve_on_disarm(p_device_id INT, p_payload JSONB)
      RETURNS INT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_origin TEXT := COALESCE(p_payload->>'origin', 'auto');
        v_dni    TEXT := NULLIF(p_payload->>'dni', '0');
        v_cid    TEXT := p_payload->>'cid';
        v_user   app_user%ROWTYPE;
        v_quien  TEXT;
        v_n      INT;
      BEGIN
        -- El apagado AUTOMÁTICO no resuelve nada: que se termine el temporizador
        -- de la sirena no significa que se terminó la emergencia.
        IF v_origin NOT IN ('rf', 'mqtt', 'portal') THEN
          RETURN 0;
        END IF;

        -- 1. El control remoto manda el dni de quien apretó el botón D.
        IF v_dni IS NOT NULL THEN
          SELECT * INTO v_user FROM app_user WHERE dni = v_dni;
        END IF;

        -- 2. La app vieja: el cid ata el desarme con el vecino que lo pidió.
        IF v_user.id IS NULL AND v_cid IS NOT NULL THEN
          SELECT u.* INTO v_user
            FROM gtd.legacy_activation la
            JOIN app_user u ON u.id = la.user_id
           WHERE la.cid = v_cid;
        END IF;

        -- 3. El panel web: quién encoló el comando de apagado.
        IF v_user.id IS NULL AND v_cid IS NOT NULL THEN
          SELECT u.* INTO v_user
            FROM gtd.commands c
            JOIN app_user u ON u.id = c.requested_by
           WHERE c.cid = v_cid;
        END IF;

        v_quien := COALESCE(v_user.name, CASE v_origin
          WHEN 'rf'     THEN 'Control remoto (sin identificar)'
          WHEN 'portal' THEN 'Portal local del equipo'
          ELSE 'Apagado a distancia'
        END);

        UPDATE event
           SET status              = 'RESOLVED',
               resolved_by_user_id = v_user.id,
               resolver_name       = v_quien,
               resolved_at         = now()
         WHERE device_id = p_device_id AND status = 'OPEN';
        GET DIAGNOSTICS v_n = ROW_COUNT;

        IF v_n > 0 THEN
          INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, new_value)
          VALUES (v_user.id, 'event.resolve.disarm', 'device', p_device_id,
                  jsonb_build_object('origin', v_origin, 'cid', v_cid,
                                     'dni', v_dni, 'cerrados', v_n,
                                     'resolver', v_quien));
        END IF;

        RETURN v_n;
      END;
      $fn$
    `);

    // insert_evento: el cierre deja de depender del `cid`.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.insert_evento(
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
        v_cid           TEXT        := p_payload->>'cid';
        v_origin        event_origin;
        v_user          app_user%ROWTYPE;
        v_home_id       INT;
        v_remote_id     INT;
        v_event_id      BIGINT;
        v_resultado     TEXT;
        v_legacy        gtd.legacy_activation%ROWTYPE;
        v_gps_lat       DOUBLE PRECISION;
        v_gps_lng       DOUBLE PRECISION;
        v_loc_mode      location_mode;
      BEGIN
        SELECT * INTO v_device FROM device WHERE mac = p_mac;

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

          -- Un desarme cierra la emergencia abierta del equipo, venga de donde
          -- venga: el botón D del control, el panel web o la app vieja. Se hace
          -- al RECIBIR el reporte del equipo y no al mandar la orden: si el
          -- panel está caído y nunca la recibe, cerrar antes dejaría el tablero
          -- diciendo "resuelto" con la sirena sonando.
          IF v_resultado = 'desarme' THEN
            PERFORM gtd.resolve_on_disarm(v_device.id, p_payload);
          END IF;

          -- TRUE porque no es un duplicado: el GtD no debe reintentar.
          RETURN true;
        END IF;

        v_origin := CASE p_payload->>'origin'
          WHEN 'rf'     THEN 'REMOTE'
          WHEN 'mqtt'   THEN 'APP'
          WHEN 'auto'   THEN 'DEVICE'
          WHEN 'portal' THEN 'PANEL'
          ELSE 'DEVICE'
        END::event_origin;

        IF v_dni IS NOT NULL THEN
          SELECT * INTO v_user FROM app_user WHERE dni = v_dni;
          SELECT home_id INTO v_home_id
            FROM home_member WHERE user_id = v_user.id AND status = 'ACTIVE';
          SELECT id INTO v_remote_id
            FROM remote
           WHERE assigned_to_user_id = v_user.id AND device_id = v_device.id
           LIMIT 1;
        END IF;

        -- La puerta vieja: el firmware solo manda dni cuando origin='rf', así
        -- que una activación de la app legacy llega anónima y el cid es el
        -- único hilo que la ata con la persona.
        IF v_user.id IS NULL AND v_cid IS NOT NULL THEN
          SELECT * INTO v_legacy FROM gtd.legacy_activation la WHERE la.cid = v_cid;
          IF v_legacy.cid IS NOT NULL THEN
            SELECT * INTO v_user FROM app_user WHERE id = v_legacy.user_id;
            v_home_id := v_legacy.home_id;
            v_gps_lat := v_legacy.gps_lat;
            v_gps_lng := v_legacy.gps_lng;
            IF v_gps_lat IS NOT NULL AND v_gps_lng IS NOT NULL THEN
              v_loc_mode := 'FIXED'::location_mode;
            END IF;
          END IF;
        END IF;

        INSERT INTO event (
          neighborhood_id, device_id, home_id, remote_id,
          origin, trigger_mode, external_id, ts_device, tsq,
          gps_lat, gps_lng, location_mode,
          activator_user_id, activator_name, activator_phone
        ) VALUES (
          v_device.neighborhood_id, v_device.id, v_home_id, v_remote_id,
          v_origin, v_mode, p_eid, v_ts, v_tsq,
          v_gps_lat, v_gps_lng, v_loc_mode,
          v_user.id, v_user.name, v_user.telephone
        )
        ON CONFLICT (device_id, external_id) WHERE external_id IS NOT NULL
        DO NOTHING
        RETURNING id INTO v_event_id;

        RETURN v_event_id IS NOT NULL;
      END;
      $fn$
    `);

    // La reemplazó resolve_on_disarm. No se le concede EXECUTE a nadie: la
    // llama insert_evento, que es SECURITY DEFINER y corre como el dueño. Eso
    // es lo que mantiene en pie "el servicio de alarmas no resuelve eventos".
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.close_legacy_events(INT, TEXT)`,
    );
    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION gtd.resolve_on_disarm(INT, JSONB) FROM PUBLIC
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Vuelve close_legacy_events tal como la dejó LegacyAppBridge.
    await queryRunner.query(`
      CREATE FUNCTION gtd.close_legacy_events(p_device_id INT, p_cid TEXT)
      RETURNS INT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_legacy gtd.legacy_activation%ROWTYPE;
        v_user   app_user%ROWTYPE;
        v_n      INT;
      BEGIN
        SELECT * INTO v_legacy FROM gtd.legacy_activation la WHERE la.cid = p_cid;
        IF v_legacy.cid IS NULL THEN
          RETURN 0;
        END IF;

        SELECT * INTO v_user FROM app_user WHERE id = v_legacy.user_id;

        UPDATE event
           SET status              = 'RESOLVED',
               resolved_by_user_id = v_user.id,
               resolver_name       = v_user.name,
               resolved_at         = now()
         WHERE device_id = p_device_id AND status = 'OPEN';
        GET DIAGNOSTICS v_n = ROW_COUNT;

        IF v_n > 0 THEN
          INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, new_value)
          VALUES (v_user.id, 'legacy.event.resolve', 'device', p_device_id,
                  jsonb_build_object('cid', p_cid, 'dni', v_legacy.dni,
                                     'cerrados', v_n));
        END IF;

        RETURN v_n;
      END;
      $fn$
    `);
    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION gtd.close_legacy_events(INT, TEXT) FROM PUBLIC
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.insert_evento(
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
        v_cid           TEXT        := p_payload->>'cid';
        v_origin        event_origin;
        v_user          app_user%ROWTYPE;
        v_home_id       INT;
        v_remote_id     INT;
        v_event_id      BIGINT;
        v_resultado     TEXT;
        v_legacy        gtd.legacy_activation%ROWTYPE;
        v_gps_lat       DOUBLE PRECISION;
        v_gps_lng       DOUBLE PRECISION;
        v_loc_mode      location_mode;
      BEGIN
        SELECT * INTO v_device FROM device WHERE mac = p_mac;

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

          IF v_resultado = 'desarme' AND v_cid IS NOT NULL THEN
            PERFORM gtd.close_legacy_events(v_device.id, v_cid);
          END IF;

          RETURN true;
        END IF;

        v_origin := CASE p_payload->>'origin'
          WHEN 'rf'     THEN 'REMOTE'
          WHEN 'mqtt'   THEN 'APP'
          WHEN 'auto'   THEN 'DEVICE'
          WHEN 'portal' THEN 'PANEL'
          ELSE 'DEVICE'
        END::event_origin;

        IF v_dni IS NOT NULL THEN
          SELECT * INTO v_user FROM app_user WHERE dni = v_dni;
          SELECT home_id INTO v_home_id
            FROM home_member WHERE user_id = v_user.id AND status = 'ACTIVE';
          SELECT id INTO v_remote_id
            FROM remote
           WHERE assigned_to_user_id = v_user.id AND device_id = v_device.id
           LIMIT 1;
        END IF;

        IF v_user.id IS NULL AND v_cid IS NOT NULL THEN
          SELECT * INTO v_legacy FROM gtd.legacy_activation la WHERE la.cid = v_cid;
          IF v_legacy.cid IS NOT NULL THEN
            SELECT * INTO v_user FROM app_user WHERE id = v_legacy.user_id;
            v_home_id := v_legacy.home_id;
            v_gps_lat := v_legacy.gps_lat;
            v_gps_lng := v_legacy.gps_lng;
            IF v_gps_lat IS NOT NULL AND v_gps_lng IS NOT NULL THEN
              v_loc_mode := 'FIXED'::location_mode;
            END IF;
          END IF;
        END IF;

        INSERT INTO event (
          neighborhood_id, device_id, home_id, remote_id,
          origin, trigger_mode, external_id, ts_device, tsq,
          gps_lat, gps_lng, location_mode,
          activator_user_id, activator_name, activator_phone
        ) VALUES (
          v_device.neighborhood_id, v_device.id, v_home_id, v_remote_id,
          v_origin, v_mode, p_eid, v_ts, v_tsq,
          v_gps_lat, v_gps_lng, v_loc_mode,
          v_user.id, v_user.name, v_user.telephone
        )
        ON CONFLICT (device_id, external_id) WHERE external_id IS NOT NULL
        DO NOTHING
        RETURNING id INTO v_event_id;

        RETURN v_event_id IS NOT NULL;
      END;
      $fn$
    `);

    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.resolve_on_disarm(INT, JSONB)`,
    );
  }
}
