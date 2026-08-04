import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alta y baja de equipos en el broker MQTT (2026-08-04).
 *
 * Ver `docs/superpowers/specs/2026-08-04-provisioner-broker-design.md`.
 *
 * La web encola acá y un proceso APARTE del GtD (el provisioner) drena la cola
 * invocando `deploy/provision-panel.sh`. Aparte y no adentro del GtD porque el
 * GtD está deliberadamente encerrado (`NoNewPrivileges`, `ProtectSystem=strict`)
 * y registrar en el broker necesita justo lo contrario: escribir
 * /etc/mosquitto/gtd.passwd y recargar el servicio. Meterlo adentro sería
 * desarmar ese encierro en el único proceso expuesto a cada panel por MQTT.
 *
 * La cola NO guarda ninguna password: la credencial se deriva en el momento con
 * el SALT_MQTT, que vive solo en el entorno del provisioner.
 *
 * Es un HISTÓRICO, una fila por operación y no una por equipo: saber que un
 * equipo se revocó en marzo y se volvió a registrar en julio es información
 * operativa que un UPDATE in place borraría.
 */
export class ProvisioningQueue1786600000000 implements MigrationInterface {
  name = 'ProvisioningQueue1786600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE gtd.provisioning_queue (
        id           BIGSERIAL PRIMARY KEY,
        mac          TEXT NOT NULL,
        device_id    INT  NOT NULL REFERENCES device(id) ON DELETE CASCADE,
        op           TEXT NOT NULL,
        estado       TEXT NOT NULL DEFAULT 'pending',
        detalle      TEXT,
        requested_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        done_at      TIMESTAMPTZ,

        CONSTRAINT chk_prov_op     CHECK (op IN ('provision', 'revoke')),
        CONSTRAINT chk_prov_estado CHECK (estado IN ('pending', 'done', 'failed'))
      )
    `);

    await queryRunner.query(`
      COMMENT ON TABLE gtd.provisioning_queue IS
        'Alta/baja de credenciales en el broker. La drena el provisioner (proceso aparte del GtD). No guarda passwords: se derivan del SALT_MQTT.'
    `);

    // Mismo criterio que ix_commands_pending: el barrido solo mira pendientes.
    await queryRunner.query(`
      CREATE INDEX ix_provisioning_pending
        ON gtd.provisioning_queue(created_at) WHERE estado = 'pending'
    `);
    await queryRunner.query(`
      CREATE INDEX ix_provisioning_device
        ON gtd.provisioning_queue(device_id, created_at DESC)
    `);

    // ── enqueue: la llama la web ──────────────────────────────────────
    await queryRunner.query(`
      CREATE FUNCTION gtd.enqueue_provisioning(
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

        -- Encolar dos veces la misma operación no sirve de nada: el script es
        -- idempotente y el segundo pedido haría el mismo trabajo dos veces.
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

    // ── fetch: la llama el provisioner ────────────────────────────────
    await queryRunner.query(`
      CREATE FUNCTION gtd.fetch_pending_provisioning()
      RETURNS TABLE (id BIGINT, mac TEXT, op TEXT)
      LANGUAGE sql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
        SELECT q.id, q.mac, q.op
          FROM gtd.provisioning_queue q
         WHERE q.estado = 'pending'
         ORDER BY q.created_at;
      $fn$
    `);

    // ── confirm: la llama el provisioner ──────────────────────────────
    await queryRunner.query(`
      CREATE FUNCTION gtd.confirm_provisioning(
        p_id  BIGINT,
        p_res TEXT,
        p_det TEXT DEFAULT NULL
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_fila gtd.provisioning_queue%ROWTYPE;
      BEGIN
        SELECT * INTO v_fila FROM gtd.provisioning_queue
         WHERE id = p_id AND estado = 'pending';
        IF NOT FOUND THEN
          RETURN 'noop';
        END IF;

        IF p_res = 'ok' THEN
          UPDATE gtd.provisioning_queue
             SET estado = 'done', detalle = NULL, done_at = now()
           WHERE id = p_id;

          -- El hito solo se mueve cuando el broker lo aceptó de verdad.
          UPDATE device
             SET mqtt_provisioned_at = CASE WHEN v_fila.op = 'provision'
                                            THEN now() ELSE NULL END,
                 mqtt_provisioned_by = v_fila.requested_by
           WHERE id = v_fila.device_id;
        ELSE
          -- Un fallo NO toca la tabla device: el equipo queda como estaba y la
          -- fila explica por qué. No se reintenta solo: los tres modos de falla
          -- (salt equivocado, broker roto, equipo inválido) piden una persona.
          UPDATE gtd.provisioning_queue
             SET estado = 'failed', detalle = COALESCE(p_det, 'sin detalle'),
                 done_at = now()
           WHERE id = p_id;
        END IF;

        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, new_value)
        VALUES (v_fila.requested_by,
                'device.broker.' || v_fila.op,
                'device', v_fila.device_id,
                jsonb_build_object('res', p_res, 'detalle', p_det, 'mac', v_fila.mac));

        RETURN 'ok';
      END;
      $fn$
    `);

    // ── NOTIFY ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE FUNCTION gtd.notify_gtd_provisioning() RETURNS TRIGGER
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.estado = 'pending' THEN
          PERFORM pg_notify('gtd_provisioning', NEW.mac);
        END IF;
        RETURN NEW;
      END;
      $fn$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_provisioning_notify
        AFTER INSERT OR UPDATE ON gtd.provisioning_queue
        FOR EACH ROW EXECUTE FUNCTION gtd.notify_gtd_provisioning()
    `);

    // ── Permisos ──────────────────────────────────────────────────────
    // PUBLIC tiene EXECUTE por defecto en toda función nueva: sin este REVOKE,
    // revocarle a un rol puntual no sirve de nada.
    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION
        gtd.enqueue_provisioning(INT, TEXT, INT),
        gtd.fetch_pending_provisioning(),
        gtd.confirm_provisioning(BIGINT, TEXT, TEXT)
      FROM PUBLIC
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_web') THEN
          REVOKE ALL ON gtd.provisioning_queue FROM cps_web;
          GRANT EXECUTE ON FUNCTION
            gtd.enqueue_provisioning(INT, TEXT, INT) TO cps_web;
          -- La web LEE la cola para mostrar el estado en la ficha.
          GRANT SELECT ON gtd.provisioning_queue TO cps_web;
        END IF;

        -- El rol del provisioner. No puede encolar (eso es de la web) ni tocar
        -- ninguna función del GtD.
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_provisioner') THEN
          REVOKE ALL ON gtd.provisioning_queue FROM cps_provisioner;
          GRANT USAGE ON SCHEMA gtd TO cps_provisioner;
          GRANT EXECUTE ON FUNCTION
            gtd.fetch_pending_provisioning(),
            gtd.confirm_provisioning(BIGINT, TEXT, TEXT)
          TO cps_provisioner;
        END IF;

        -- El GtD no participa del alta: no se le da nada.
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_alarms') THEN
          REVOKE ALL ON gtd.provisioning_queue FROM cps_alarms;
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_provisioning_notify ON gtd.provisioning_queue`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.notify_gtd_provisioning()`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.confirm_provisioning(BIGINT, TEXT, TEXT)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.fetch_pending_provisioning()`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.enqueue_provisioning(INT, TEXT, INT)`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS gtd.provisioning_queue`);
  }
}
