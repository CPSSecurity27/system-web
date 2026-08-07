import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El ack marca los controles cargados (2026-08-05).
 *
 * `RemoteSync` dejó dónde guardar el estado (`remote.synced_*`) y la cola
 * encadenada, pero faltaba el paso que los une: **quién escribe ese estado**.
 *
 * ## Por qué esto pasa en la base y no en Node
 *
 * Cuando el panel contesta, del lado de la web no corre nadie: el GtD llama a
 * `gtd.confirm_command` y se acabó. No hay worker, ni cron, ni nada escuchando.
 * Marcar los controles desde una pantalla —"la próxima vez que alguien mire"—
 * dejaría el estado dependiendo de que alguien mire.
 *
 * Es el mismo criterio que `confirm_provisioning`, que mueve el hito
 * `device.mqtt_provisioned_at` cuando el broker aceptó de verdad: el hecho se
 * registra donde llega la confirmación.
 *
 * ## `meta`: lo nuestro no viaja por el aire
 *
 * Para marcar hace falta saber qué controles cubre cada paso. Podría ir en el
 * `payload` —el firmware ignora las claves que no conoce— pero eso es apostar a
 * que lo siga haciendo, y el payload entrante del panel tiene 1024 bytes
 * contados (`MQTT_IN_PAYLOAD_MAX`). Va en una columna aparte que el GtD ni mira:
 * publica `payload`, nada más.
 *
 * ## Por qué es una migración aparte y no un retoque de RemoteSync
 *
 * Porque editar una migración ya aplicada deja atrás a toda base que ya la
 * corrió. Se descubrió en el acto: la base de tests siguió sin la columna
 * —tenía `RemoteSync` registrada, así que no volvió a correrla— y todo el e2e
 * de la cadena falló contra un esquema viejo. Una migración es historia: se
 * agrega, no se reescribe.
 */
export class RfSyncOnAck1787900000000 implements MigrationInterface {
  name = 'RfSyncOnAck1787900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE gtd.commands ADD COLUMN meta JSONB`);
    await queryRunner.query(`
      COMMENT ON COLUMN gtd.commands.meta IS
        'Datos NUESTROS del comando, que NO se publican (el GtD manda payload y nada más). En un paso de base RF dice qué controles cubre, para que el ack pueda marcarlos: {"remotes":[{id,dni,hash}]} en un batch, {"dnis":[...]} en un del.'
    `);

    // enqueue_rf_sync: cada paso llega con su `meta`, que se guarda aparte del
    // documento que se publica.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.enqueue_rf_sync(
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
                                    batch_id, seq, meta, requested_by)
          VALUES (v_cid, v_mac, p_device_id, 'rf',
                  -- Al panel va SOLO el comando: la meta se queda de este lado.
                  (v_paso - 'meta')
                    || jsonb_build_object('t', 'rf', 'cid', v_cid, 'gen', v_gen),
                  -- Solo el primero sale; el resto espera su turno.
                  CASE WHEN v_seq = 1 THEN 'pending' ELSE 'queued' END,
                  v_batch, v_seq, v_paso->'meta', p_user_id);
        END LOOP;

        UPDATE device SET rf_gen = v_gen WHERE id = p_device_id;

        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, new_value)
        VALUES (p_user_id, 'gtd.rf.sync', 'device', p_device_id,
                jsonb_build_object('batch_id', v_batch, 'pasos', v_seq, 'gen', v_gen));

        RETURN v_batch;
      END;
      $fn$
    `);

    // confirm_command: además de encadenar y limpiar el payload, ahora escribe
    // el hecho en el dominio.
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
        v_dev     INT;
        v_meta    JSONB;
        v_ok      BOOLEAN;
        v_detalle TEXT := p_det;
      BEGIN
        SELECT tipo, payload->>'op', batch_id, seq, device_id, meta
          INTO v_tipo, v_op, v_batch, v_seq, v_dev, v_meta
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

        -- El HECHO: qué controles quedaron cargados en el equipo. Solo con el
        -- ack en la mano — antes de eso, el panel no tiene nada.
        IF v_ok AND v_tipo = 'rf' AND v_meta IS NOT NULL THEN
          IF v_op = 'batch' THEN
            UPDATE remote r
               SET synced_device_id = v_dev,
                   synced_dni       = m.dni,
                   synced_hash      = m.hash,
                   synced_at        = now()
              FROM jsonb_to_recordset(v_meta->'remotes')
                     AS m(id INT, dni TEXT, hash BIGINT)
             WHERE r.id = m.id;
          ELSIF v_op = 'del' THEN
            -- Se limpia por (equipo, DNI) y no por id de control: el que se dio
            -- de baja puede haber perdido su portador —eso es JUSTAMENTE por lo
            -- que se lo borra— y el DNI es la única llave que comparten los dos
            -- lados.
            UPDATE remote
               SET synced_device_id = NULL, synced_dni = NULL,
                   synced_hash = NULL, synced_at = NULL
             WHERE synced_device_id = v_dev
               AND synced_dni IN (
                     SELECT jsonb_array_elements_text(v_meta->'dnis'));
          END IF;
        END IF;

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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Las dos funciones vuelven a la forma que les dejó RemoteSync.
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

        IF NOT v_ok AND v_tipo = 'rf' AND v_op = 'del'
           AND p_det LIKE '%ee_status 1%' THEN
          v_ok := true;
          v_detalle := 'ese DNI ya no estaba en el panel';
        END IF;

        UPDATE gtd.commands
           SET estado       = CASE WHEN v_ok THEN 'ok' ELSE 'error' END,
               detalle      = v_detalle,
               confirmed_at = now(),
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
            UPDATE gtd.commands SET estado = 'pending'
             WHERE cid = (SELECT cid FROM gtd.commands
                           WHERE batch_id = v_batch AND estado = 'queued'
                           ORDER BY seq LIMIT 1);
          ELSE
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

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.enqueue_rf_sync(
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

    await queryRunner.query(`ALTER TABLE gtd.commands DROP COLUMN meta`);
  }
}
