import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sincronización de la base RF: de la web a la EEPROM del panel (2026-08-05).
 *
 * Hasta acá, asignar un control era un acto puramente administrativo: el vecino
 * se llevaba el llavero y el panel no lo conocía, así que **no disparaba nada**.
 * Esta migración pone los cimientos del flujo que carga los códigos de verdad.
 *
 * ## Lo que impone el firmware (y por qué el modelo cambia)
 *
 * La base del panel (`components/eeprom_ext/eeprom_store.h`) está indexada por
 * **DNI**, no por control: un registro es una PERSONA con hasta 4 códigos
 * (`EE_CODES_PER_CLIENT`), y entran ~126 en el chip AT24C32. Del otro lado no
 * existe el concepto "control".
 *
 * De ahí sale la regla nueva: **una persona lleva un solo control**. No es una
 * preferencia de la web — dos controles del mismo portador serían dos registros
 * con el mismo DNI, y el panel rechaza el segundo (`EE_DUP`). Se impone con un
 * único parcial: así no hay forma de crear el conflicto, ni por la API ni a mano.
 *
 * ## Por qué cuatro columnas y no un flag "sincronizado"
 *
 * Un flag hay que acordarse de bajarlo, y el día que alguien edita un código por
 * otro camino queda mintiendo. Acá se guarda **lo que quedó cargado** y
 * "pendiente" se deduce comparándolo con lo que debería estar:
 *
 *   debería: alarma preferida del hogar + DNI del portador + hash de sus códigos
 *   está:    synced_device_id          + synced_dni       + synced_hash
 *
 * Cambiar el portador, editar un código, devolver el control al stock, removerlo
 * o cambiarle la alarma preferida al hogar lo desincronizan **solos**.
 *
 * `synced_dni` no es redundante con el portador actual: cuando un control vuelve
 * al stock pierde el portador, y sin ese dato no sabríamos qué DNI borrar del
 * panel. `synced_hash` es el MISMO FNV-1a que calcula `rf_client_hash` en
 * `task_mqtt.c`, así el día que usemos `op:"audit"` comparamos contra lo que
 * reporta el equipo sin descifrar un solo código.
 *
 * ## El encadenado: por qué los comandos nacen 'queued'
 *
 * 120 controles son 24 comandos de a 5 (`EE_SAVE_BATCH_MAX`), y cada lote le
 * lleva al panel ~2,25 s porque cada alta barre la EEPROM. Publicarlos en
 * ráfaga tiene dos problemas: le tapa la cola al equipo por un minuto entero, y
 * el panel recuerda apenas los **últimos 8 `cid`** (`MQTT_CID_RING_N`), así que
 * una redistribución QoS1 de un lote viejo se re-ejecutaría y volvería como
 * `EE_DUP` — un error que en realidad era "ya estaba".
 *
 * Entonces se encolan todos, pero **solo el primero nace `pending`**: el resto
 * queda `queued`, que el GtD no ve (`fetch_pending_commands` filtra por
 * `pending`). `gtd.confirm_command` destraba el siguiente cuando llega el ack.
 * Es el mismo mecanismo que ya usa el provisioner: sin proceso nuevo, sin
 * dependencia nueva, y atómico.
 *
 * ## `gen`: el detector de desincronización
 *
 * El panel persiste el `gen` del último comando que le salió bien y lo reporta
 * en `cfg_full` y en `tele`. Si mandáramos el mismo para toda la tanda, un fallo
 * en el lote 12 dejaría al equipo reportando el mismo número que si hubieran
 * entrado los 24. Va **uno por comando** (`device.rf_gen` + i), así el número
 * reportado dice exactamente hasta dónde llegó.
 *
 * OJO con omitirlo: `get_u32` del firmware devuelve 0 para una clave ausente sin
 * marcar error, así que un comando sin `gen` hace que el panel guarde
 * generación 0 — que es lo que reporta un equipo recién vuelto de fábrica.
 */
export class RemoteSync1787800000000 implements MigrationInterface {
  name = 'RemoteSync1787800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Una persona, un control ────────────────────────────────────
    // El índice solo alcanza a los VIVOS: un control removido conserva su
    // portador como parte del registro histórico y no le ocupa el lugar a nadie.
    //
    // El pre-chequeo existe para que el error diga QUIÉN, en vez del mensaje de
    // violación de índice único, que solo dice que alguien falló.
    await queryRunner.query(`
      DO $$
      DECLARE v_conflictos TEXT;
      BEGIN
        SELECT string_agg(format('%s (%s controles)', u.name, c.n), ', ')
          INTO v_conflictos
          FROM (SELECT assigned_to_user_id AS uid, COUNT(*) AS n
                  FROM remote
                 WHERE assigned_to_user_id IS NOT NULL AND removed_at IS NULL
                 GROUP BY assigned_to_user_id
                HAVING COUNT(*) > 1) c
          JOIN app_user u ON u.id = c.uid;

        IF v_conflictos IS NOT NULL THEN
          RAISE EXCEPTION
            'Hay portadores con más de un control y ahora eso no se puede: %. '
            'El panel guarda un registro por DNI, así que el segundo control '
            'nunca podría cargarse. Reasigná el portador y volvé a correr.',
            v_conflictos;
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_remote_one_per_carrier ON remote(assigned_to_user_id)
        WHERE assigned_to_user_id IS NOT NULL AND removed_at IS NULL
    `);

    // ── 2. Qué quedó cargado en qué panel ─────────────────────────────
    await queryRunner.query(`
      ALTER TABLE remote
        ADD COLUMN synced_device_id INT
          CONSTRAINT remote_synced_device_id_fkey REFERENCES device(id) ON DELETE SET NULL,
        ADD COLUMN synced_dni  TEXT,
        ADD COLUMN synced_hash BIGINT,
        ADD COLUMN synced_at   TIMESTAMPTZ
    `);
    // Las cuatro viajan juntas o no viaja ninguna: media sincronización
    // guardada es peor que ninguna — no se sabría ni qué borrar ni qué comparar.
    await queryRunner.query(`
      ALTER TABLE remote ADD CONSTRAINT chk_remote_sync_completa CHECK (
        (synced_device_id IS NULL AND synced_dni IS NULL
         AND synced_hash IS NULL AND synced_at IS NULL)
        OR
        (synced_device_id IS NOT NULL AND synced_dni IS NOT NULL
         AND synced_hash IS NOT NULL AND synced_at IS NOT NULL)
      )
    `);
    // Para la pregunta del plan: "qué dice estar cargado en ESTE equipo".
    await queryRunner.query(`
      CREATE INDEX idx_remote_synced_device ON remote(synced_device_id)
        WHERE synced_device_id IS NOT NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN remote.synced_device_id IS
        'En qué panel quedó cargado. NULL = en ninguno. No es lo mismo que "dónde debería estar" (la alarma preferida de su hogar): si difieren, hay una baja pendiente en el panel viejo.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN remote.synced_dni IS
        'Con qué DNI se cargó. NO es redundante con el portador actual: al volver al stock el control pierde el portador, y sin esto no sabríamos qué borrar del panel (la base del equipo está indexada por DNI).'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN remote.synced_hash IS
        'FNV-1a de los códigos cargados, con el MISMO algoritmo que rf_client_hash() en task_mqtt.c. Permite comparar contra la auditoría del panel (op:audit) sin descifrar ningún código.'
    `);

    // ── 3. La generación que le asignamos a cada equipo ───────────────
    // Es la que MANDAMOS; la que el panel dice tener vive en device_state.
    // uint32 del lado del firmware: el CHECK impide mandarle un número que
    // le entre truncado.
    await queryRunner.query(`
      ALTER TABLE device ADD COLUMN rf_gen BIGINT NOT NULL DEFAULT 0
        CONSTRAINT chk_device_rf_gen CHECK (rf_gen >= 0 AND rf_gen < 4294967296)
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN device.rf_gen IS
        'Última generación de base RF que le asignamos a este equipo. Sube de a uno POR COMANDO: el panel persiste la del último que le salió bien y la reporta, así el número dice hasta dónde llegó la tanda.'
    `);

    // ── 4. La cola encadenada ─────────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE gtd.commands DROP CONSTRAINT chk_commands_estado`,
    );
    // 'queued' es nuevo y es el que hace posible el encadenado: está en la
    // tabla pero el GtD no lo ve (fetch_pending_commands filtra 'pending').
    await queryRunner.query(`
      ALTER TABLE gtd.commands ADD CONSTRAINT chk_commands_estado CHECK (
        estado IN ('queued', 'pending', 'sent', 'ok', 'error', 'cancelled')
      )
    `);
    await queryRunner.query(`
      ALTER TABLE gtd.commands
        ADD COLUMN batch_id UUID,
        ADD COLUMN seq      INT
    `);
    await queryRunner.query(`
      CREATE INDEX ix_commands_batch ON gtd.commands(batch_id, seq)
        WHERE batch_id IS NOT NULL
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN gtd.commands.batch_id IS
        'Los pasos de una misma sincronización de base RF. NULL en los comandos sueltos. El siguiente se destraba en confirm_command cuando llega el ack del anterior.'
    `);

    // ── 5. El cid, en un solo lugar ───────────────────────────────────
    await queryRunner.query(`
      CREATE FUNCTION gtd.new_cid() RETURNS TEXT
      LANGUAGE sql
      AS $fn$
        -- Viaja en el cmd y vuelve en el ack. OJO: MQTT_CID_MAXLEN (24) es el
        -- tamaño del BUFFER del firmware, así que entran 23 + el NUL. Con 24 el
        -- panel ackea un cid truncado que no matchea — corregido en CidDe23.
        SELECT LEFT('cmd-' || REPLACE(gen_random_uuid()::TEXT, '-', ''), 24);
      $fn$
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.enqueue_command(
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

        v_cid := gtd.new_cid();

        INSERT INTO gtd.commands (cid, mac, device_id, tipo, payload, requested_by)
        VALUES (v_cid, v_mac, p_device_id, p_tipo,
                COALESCE(p_params, '{}'::JSONB)
                  || jsonb_build_object('t', p_tipo, 'cid', v_cid),
                p_user_id);

        RETURN v_cid;
      END;
      $fn$
    `);

    // ── 6. Encolar una sincronización entera ──────────────────────────
    // Reemplaza a enqueue_rf_batch, que encolaba todo 'pending' de una ráfaga
    // y no mandaba `gen`.
    //
    // Los pasos llegan YA ARMADOS y EN ORDEN desde el backend: el descifrado de
    // los códigos pasa en Node (la clave AES no está en la base, y así tiene que
    // seguir). Las bajas van primero y eso lo garantiza quien arma el plan —
    // un control reasignado a otra persona choca contra su propio código viejo
    // (EE_DUP por conflicto de código) y abortaría el lote entero.
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.enqueue_rf_batch(INT, JSONB, INT)`,
    );
    await queryRunner.query(`
      CREATE FUNCTION gtd.enqueue_rf_sync(
        p_device_id INT,
        p_pasos     JSONB,
        p_user_id   INT DEFAULT NULL
      ) RETURNS UUID
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_mac      TEXT;
        v_batch    UUID := gen_random_uuid();
        v_gen      BIGINT;
        v_paso     JSONB;
        v_seq      INT := 0;
        v_cid      TEXT;
      BEGIN
        IF jsonb_typeof(p_pasos) <> 'array' OR jsonb_array_length(p_pasos) = 0 THEN
          RAISE EXCEPTION 'p_pasos tiene que ser un array de pasos, en el orden en que se aplican';
        END IF;

        SELECT mac INTO v_mac FROM device WHERE id = p_device_id;
        IF v_mac IS NULL THEN
          RAISE EXCEPTION 'El equipo % no existe o no tiene MAC', p_device_id;
        END IF;

        -- Una tanda por equipo: dos planes en vuelo se pisarían los DNIs entre
        -- sí, y el segundo abortaría contra los registros que dejó el primero.
        IF EXISTS (SELECT 1 FROM gtd.commands
                    WHERE device_id = p_device_id AND tipo = 'rf'
                      AND estado IN ('queued', 'pending', 'sent')) THEN
          RAISE EXCEPTION 'Ese equipo ya tiene una sincronización de controles en curso';
        END IF;

        SELECT rf_gen INTO v_gen FROM device WHERE id = p_device_id FOR UPDATE;

        FOR v_paso IN SELECT * FROM jsonb_array_elements(p_pasos) LOOP
          v_seq := v_seq + 1;
          v_gen := v_gen + 1;
          v_cid := gtd.new_cid();

          INSERT INTO gtd.commands (cid, mac, device_id, tipo, payload, estado,
                                    batch_id, seq, requested_by)
          VALUES (v_cid, v_mac, p_device_id, 'rf',
                  v_paso || jsonb_build_object('t', 'rf', 'cid', v_cid, 'gen', v_gen),
                  -- Solo el primero sale; el resto espera su turno.
                  CASE WHEN v_seq = 1 THEN 'pending' ELSE 'queued' END,
                  v_batch, v_seq, p_user_id);
        END LOOP;

        UPDATE device SET rf_gen = v_gen WHERE id = p_device_id;

        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, new_value)
        VALUES (p_user_id, 'gtd.rf.sync', 'device', p_device_id,
                jsonb_build_object('batch_id', v_batch, 'pasos', v_seq, 'gen', v_gen));

        RETURN v_batch;
      END;
      $fn$
    `);

    // ── 7. El ack: limpia el payload y destraba el siguiente ──────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.confirm_command(
        p_cid TEXT,
        p_res TEXT DEFAULT NULL,
        p_det TEXT DEFAULT NULL
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_tipo    TEXT;
        v_op      TEXT;
        v_batch   UUID;
        v_seq     INT;
        v_ok      BOOLEAN;
        v_detalle TEXT := p_det;
      BEGIN
        SELECT tipo, payload->>'op', batch_id, seq
          INTO v_tipo, v_op, v_batch, v_seq
          FROM gtd.commands WHERE cid = p_cid;

        IF NOT FOUND THEN
          RETURN 'unknown_cid';
        END IF;

        v_ok := (p_res = 'ok');

        -- Borrar un DNI que el panel ya no tiene vuelve como error 'ee_status 1'
        -- (EE_NOT_FOUND), y es el caso NORMAL al reintentar una sincronización:
        -- tratarlo como fallo abortaría el plan entero por una baja que ya
        -- estaba hecha. El resto de los ee_status sí son errores de verdad
        -- (2 = base llena, 6 = duplicado, 8 = la cola EEPROM no respondió).
        IF NOT v_ok AND v_tipo = 'rf' AND v_op = 'del'
           AND p_det LIKE '%ee_status 1%' THEN
          v_ok := true;
          v_detalle := 'ese DNI ya no estaba en el panel';
        END IF;

        UPDATE gtd.commands
           SET estado       = CASE WHEN v_ok THEN 'ok' ELSE 'error' END,
               detalle      = v_detalle,
               confirmed_at = now(),
               -- Los códigos RF viajan en claro porque el panel los necesita
               -- así, pero un comando es EFÍMERO (a diferencia de la config,
               -- que se conserva para el merge): cumplido su viaje, del payload
               -- queda cuántos DNIs llevaba y nada más.
               payload      = CASE
                 WHEN tipo = 'rf' AND payload ? 'clientes'
                 THEN (payload - 'clientes')
                      || jsonb_build_object('clientes_n',
                                            jsonb_array_length(payload->'clientes'))
                 ELSE payload
               END
         WHERE cid = p_cid;

        IF v_batch IS NOT NULL THEN
          IF v_ok THEN
            -- El siguiente paso del plan pasa a 'pending' y el trigger lo
            -- publica. Sin esto la tanda se queda dormida para siempre.
            UPDATE gtd.commands SET estado = 'pending'
             WHERE cid = (SELECT cid FROM gtd.commands
                           WHERE batch_id = v_batch AND estado = 'queued'
                           ORDER BY seq LIMIT 1);
          ELSE
            -- Un paso que falla corta el plan: seguir cargando sobre una base
            -- que quedó a medias produce errores en cascada y deja al equipo
            -- reportando una generación que no se corresponde con nada.
            UPDATE gtd.commands
               SET estado  = 'cancelled',
                   detalle = format('abortado: el paso %s falló', v_seq)
             WHERE batch_id = v_batch AND estado = 'queued';
          END IF;
        END IF;

        RETURN 'ok';
      END;
      $fn$
    `);

    // ── 8. Permisos ───────────────────────────────────────────────────
    // new_cid no se otorga a nadie: es de uso interno de las otras funciones,
    // que corren SECURITY DEFINER.
    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION gtd.new_cid() FROM PUBLIC
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_web') THEN
          GRANT EXECUTE ON FUNCTION gtd.enqueue_rf_sync(INT, JSONB, INT) TO cps_web;
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Las funciones vuelven a su forma anterior (GtdBridgeFunctions).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.confirm_command(
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
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.enqueue_rf_sync(INT, JSONB, INT)`,
    );
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
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.enqueue_command(
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

        v_cid := 'cmd-' || REPLACE(gen_random_uuid()::TEXT, '-', '');
        v_cid := LEFT(v_cid, 24);

        INSERT INTO gtd.commands (cid, mac, device_id, tipo, payload, requested_by)
        VALUES (v_cid, v_mac, p_device_id, p_tipo,
                COALESCE(p_params, '{}'::JSONB)
                  || jsonb_build_object('t', p_tipo, 'cid', v_cid),
                p_user_id);

        RETURN v_cid;
      END;
      $fn$
    `);
    await queryRunner.query(`DROP FUNCTION IF EXISTS gtd.new_cid()`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_web') THEN
          GRANT EXECUTE ON FUNCTION gtd.enqueue_rf_batch(INT, JSONB, INT) TO cps_web;
        END IF;
      END
      $$
    `);

    // Los comandos encadenados que quedaron sin publicar no sobreviven a la
    // vuelta atrás: sin 'queued' en el CHECK, la fila sería inválida.
    await queryRunner.query(`
      UPDATE gtd.commands SET estado = 'cancelled',
                              detalle = 'cancelado al revertir RemoteSync'
       WHERE estado = 'queued'
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS gtd.ix_commands_batch`);
    await queryRunner.query(
      `ALTER TABLE gtd.commands
         DROP COLUMN IF EXISTS seq,
         DROP COLUMN IF EXISTS batch_id`,
    );
    await queryRunner.query(
      `ALTER TABLE gtd.commands DROP CONSTRAINT chk_commands_estado`,
    );
    await queryRunner.query(`
      ALTER TABLE gtd.commands ADD CONSTRAINT chk_commands_estado CHECK (
        estado IN ('pending', 'sent', 'ok', 'error', 'cancelled')
      )
    `);

    await queryRunner.query(`ALTER TABLE device DROP COLUMN rf_gen`);

    await queryRunner.query(`DROP INDEX IF EXISTS idx_remote_synced_device`);
    await queryRunner.query(
      `ALTER TABLE remote DROP CONSTRAINT chk_remote_sync_completa`,
    );
    await queryRunner.query(`
      ALTER TABLE remote
        DROP COLUMN synced_at,
        DROP COLUMN synced_hash,
        DROP COLUMN synced_dni,
        DROP COLUMN synced_device_id
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_remote_one_per_carrier`);
  }
}
