import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fabricación atómica: credenciales del portal local + op `manufacture` (2026-08-04).
 *
 * Ver `docs/superpowers/specs/2026-08-04-fabrica-alarmas-design.md`.
 *
 * El equipo tiene DOS juegos de credenciales y no son lo mismo:
 *
 *   MQTT    equipo <-> broker. HMAC-SHA256(SALT_MQTT, MAC STA). No se guarda:
 *           vive en /etc/mosquitto/gtd.passwd y se recalcula cuando haga falta.
 *   PORTAL  técnico <-> portal web del equipo (AP local, 192.168.4.1). Usuarios
 *           `admin` y `cps`, djb2_xor(SALT_del_rol, MAC SoftAP), 6 hex. ACÁ SÍ se
 *           guardan, cifradas, para poder reimprimir una etiqueta sin depender
 *           de que el provisioner esté vivo.
 *
 * Las cifra el PROVISIONER antes de escribirlas (AES-256-GCM con CPS_CRED_KEY).
 * Si viajaran en claro por la cola quedarían en claro en la tabla y en el WAL
 * hasta que alguien las borrara; así nunca existen en claro fuera de memoria.
 *
 * La op `manufacture` hace las dos cosas en un solo viaje porque el alta es
 * ATÓMICA: la web espera UNA confirmación, no dos, y si falla borra el equipo.
 */
export class DevicePortalCredentials1786700000000 implements MigrationInterface {
  name = 'DevicePortalCredentials1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Las columnas ──────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE device
        ADD COLUMN portal_admin_enc  TEXT,
        ADD COLUMN portal_cps_enc    TEXT,
        ADD COLUMN portal_derived_at TIMESTAMPTZ
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN device.portal_admin_enc IS
        'Password del usuario admin del portal local, AES-256-GCM: base64(nonce||ct||tag). Se imprime en la etiqueta.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN device.portal_cps_enc IS
        'Password del usuario cps del portal local, mismo formato. JAMÁS se imprime: solo herramienta interna, con audit_log en cada lectura.'
    `);

    // Los tres van juntos o no va ninguno: media derivación guardada es una
    // etiqueta que se imprime a medias.
    await queryRunner.query(`
      ALTER TABLE device ADD CONSTRAINT chk_device_portal_creds CHECK (
        (portal_derived_at IS NULL
           AND portal_admin_enc IS NULL AND portal_cps_enc IS NULL)
        OR (portal_derived_at IS NOT NULL
           AND portal_admin_enc IS NOT NULL AND portal_cps_enc IS NOT NULL)
      )
    `);

    // ── La op nueva ───────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE gtd.provisioning_queue DROP CONSTRAINT chk_prov_op
    `);
    await queryRunner.query(`
      ALTER TABLE gtd.provisioning_queue ADD CONSTRAINT chk_prov_op
        CHECK (op IN ('provision', 'revoke', 'manufacture'))
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.enqueue_provisioning(
        p_device_id INT,
        p_op        TEXT,
        p_user_id   INT DEFAULT NULL
      ) RETURNS BIGINT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_mac TEXT;
        v_id  BIGINT;
      BEGIN
        IF p_op NOT IN ('provision', 'revoke', 'manufacture') THEN
          RAISE EXCEPTION 'Operación inválida: %', p_op;
        END IF;

        SELECT mac INTO v_mac FROM device WHERE id = p_device_id;
        IF v_mac IS NULL THEN
          RAISE EXCEPTION 'El equipo % no existe o no tiene MAC cargada', p_device_id;
        END IF;

        SELECT id INTO v_id
          FROM gtd.provisioning_queue
         WHERE device_id = p_device_id AND op = p_op AND estado = 'pending'
         LIMIT 1;
        IF v_id IS NOT NULL THEN
          RETURN v_id;
        END IF;

        INSERT INTO gtd.provisioning_queue (mac, device_id, op, requested_by)
        VALUES (v_mac, p_device_id, p_op, p_user_id)
        RETURNING id INTO v_id;

        RETURN v_id;
      END;
      $fn$
    `);

    // ── confirm_manufacture: la llama el provisioner ──────────────────
    // Aparte de confirm_provisioning y no un parámetro más de aquella: son dos
    // superficies de privilegio distintas y esta escribe columnas que la otra
    // no debería poder tocar nunca.
    await queryRunner.query(`
      CREATE FUNCTION gtd.confirm_manufacture(
        p_id        BIGINT,
        p_res       TEXT,
        p_admin_enc TEXT DEFAULT NULL,
        p_cps_enc   TEXT DEFAULT NULL,
        p_det       TEXT DEFAULT NULL
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_fila gtd.provisioning_queue%ROWTYPE;
      BEGIN
        SELECT * INTO v_fila FROM gtd.provisioning_queue
         WHERE id = p_id AND estado = 'pending' AND op = 'manufacture';
        IF NOT FOUND THEN
          RETURN 'noop';
        END IF;

        IF p_res = 'ok' THEN
          -- Sin las dos credenciales no hay fabricación: dejar pasar un 'ok' a
          -- medias sería exactamente lo que el CHECK de la tabla impide, pero
          -- con un error de base en vez de un mensaje que se entienda.
          IF p_admin_enc IS NULL OR p_cps_enc IS NULL THEN
            RAISE EXCEPTION 'confirm_manufacture(ok) sin las credenciales del portal';
          END IF;

          UPDATE gtd.provisioning_queue
             SET estado = 'done', detalle = NULL, done_at = now()
           WHERE id = p_id;

          UPDATE device
             SET mqtt_provisioned_at = now(),
                 mqtt_provisioned_by = v_fila.requested_by,
                 portal_admin_enc    = p_admin_enc,
                 portal_cps_enc      = p_cps_enc,
                 portal_derived_at   = now()
           WHERE id = v_fila.device_id;
        ELSE
          UPDATE gtd.provisioning_queue
             SET estado = 'failed', detalle = COALESCE(p_det, 'sin detalle'),
                 done_at = now()
           WHERE id = p_id;
        END IF;

        -- El equipo se borra si falló (lo hace la web al compensar), y con él la
        -- fila de la cola por CASCADE. Este audit_log es lo ÚNICO que sobrevive
        -- al intento fallido: sin él, se repite a ciegas.
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, new_value)
        VALUES (v_fila.requested_by, 'device.manufacture',
                'device', v_fila.device_id,
                jsonb_build_object('res', p_res, 'detalle', p_det, 'mac', v_fila.mac));

        RETURN 'ok';
      END;
      $fn$
    `);

    // El trigger de NOTIFY no se toca: sigue avisándole al provisioner que hay
    // trabajo. La VUELTA la resuelve la web sondeando la fila cada 250 ms
    // mientras dura el alta — un LISTEN le ahorraría esos milisegundos a cambio
    // de una conexión dedicada viva para siempre, y las altas son de a una y a
    // ritmo humano. Sondear tampoco puede perderse un evento, que es la clase de
    // bug que ya nos costó el barrido de pendientes (P0-1).

    // ── Permisos ──────────────────────────────────────────────────────
    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION
        gtd.confirm_manufacture(BIGINT, TEXT, TEXT, TEXT, TEXT)
      FROM PUBLIC
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        -- Solo el provisioner confirma. La web encola y espera; si pudiera
        -- confirmar, podría escribirse a sí misma credenciales que nunca
        -- llegaron al broker.
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_provisioner') THEN
          GRANT EXECUTE ON FUNCTION
            gtd.confirm_manufacture(BIGINT, TEXT, TEXT, TEXT, TEXT)
          TO cps_provisioner;

          -- Para el barrido de huérfanos: comparar gtd.passwd contra los
          -- seriales vivos. Solo esa columna.
          GRANT SELECT (id, serial, mac) ON device TO cps_provisioner;
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.confirm_manufacture(BIGINT, TEXT, TEXT, TEXT, TEXT)`,
    );

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_provisioner') THEN
          REVOKE SELECT (id, serial, mac) ON device FROM cps_provisioner;
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      ALTER TABLE gtd.provisioning_queue DROP CONSTRAINT chk_prov_op
    `);
    await queryRunner.query(`
      ALTER TABLE gtd.provisioning_queue ADD CONSTRAINT chk_prov_op
        CHECK (op IN ('provision', 'revoke'))
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.enqueue_provisioning(
        p_device_id INT,
        p_op        TEXT,
        p_user_id   INT DEFAULT NULL
      ) RETURNS BIGINT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_mac TEXT;
        v_id  BIGINT;
      BEGIN
        IF p_op NOT IN ('provision', 'revoke') THEN
          RAISE EXCEPTION 'Operación inválida: %', p_op;
        END IF;

        SELECT mac INTO v_mac FROM device WHERE id = p_device_id;
        IF v_mac IS NULL THEN
          RAISE EXCEPTION 'El equipo % no existe o no tiene MAC cargada', p_device_id;
        END IF;

        SELECT id INTO v_id
          FROM gtd.provisioning_queue
         WHERE device_id = p_device_id AND op = p_op AND estado = 'pending'
         LIMIT 1;
        IF v_id IS NOT NULL THEN
          RETURN v_id;
        END IF;

        INSERT INTO gtd.provisioning_queue (mac, device_id, op, requested_by)
        VALUES (v_mac, p_device_id, p_op, p_user_id)
        RETURNING id INTO v_id;

        RETURN v_id;
      END;
      $fn$
    `);

    await queryRunner.query(
      `ALTER TABLE device DROP CONSTRAINT chk_device_portal_creds`,
    );
    await queryRunner.query(`
      ALTER TABLE device
        DROP COLUMN portal_admin_enc,
        DROP COLUMN portal_cps_enc,
        DROP COLUMN portal_derived_at
    `);
  }
}
