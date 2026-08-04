import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Configuración por equipo — las dos funciones que faltaban (2026-08-04).
 *
 * Ver `docs/superpowers/specs/2026-08-04-configuracion-por-equipo-design.md`.
 *
 * 1. `confirm_config` — el ack de una `cfg` NO trae `cid` (el firmware arma
 *    `mqtt_build_up_ack_cfg` con `cfg_v`, sin correlación), así que hoy el GtD lo
 *    manda por `insert_evento` y termina en el dead letter como `sin_destino`:
 *    la confirmación existe y la estamos tirando.
 *
 *    Además encola sola el `cmd t:refresh`. Hace falta porque aplicar una `cfg`
 *    NO refresca el espejo de forma confiable: `app_roam_set`,
 *    `app_autooff_set_mode` y `app_mante_set` llaman a `cfg_full_touch()` por
 *    dentro, pero `tiempos` usa `eeprom_nvs_mqtt_set_tele_s` directo y no. El
 *    espejo se actualiza a veces, según qué secciones tocó el patch — y eso no
 *    es una base sobre la que se pueda construir una pantalla.
 *
 *    El encadenado vive acá y no en Python por lo mismo que todo el contrato: un
 *    cambio de mapeo es una migración nuestra, no un deploy de ellos. Y va
 *    DESPUÉS del ack, no junto con la cfg: son tópicos distintos y un refresh
 *    que gane la carrera refrescaría la configuración vieja.
 *
 * 2. `last_scan` — los scans YA se guardan en `gtd.uplink_raw` (todo lo que no es
 *    `alarma` cae ahí con el payload completo). La función existe para que la
 *    intención quede explícita y para poder cambiar el almacenamiento después
 *    sin tocar la web.
 */
export class GtdConfigFunctions1786500000000 implements MigrationInterface {
  name = 'GtdConfigFunctions1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION gtd.confirm_config(
        p_mac   TEXT,
        p_cfg_v BIGINT,
        p_res   TEXT DEFAULT 'ok',
        p_det   TEXT DEFAULT NULL
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_device_id INT;
        v_cid       TEXT;
      BEGIN
        SELECT id INTO v_device_id FROM device WHERE mac = p_mac;

        IF v_device_id IS NULL THEN
          INSERT INTO gtd.uplink_raw (mac, tipo, payload, resultado)
          VALUES (p_mac, 'ack_cfg',
                  jsonb_build_object('cfg_v', p_cfg_v, 'res', p_res, 'det', p_det),
                  'unknown_device');
          RETURN 'unknown_device';
        END IF;

        -- El firmware tiene el res hardcodeado en 'ok' y no existe ack de error
        -- para cfg (es una de las propuestas que les hicimos). Se respeta el
        -- parámetro igual: el día que lo agreguen, esto ya lo distingue.
        IF p_res IS DISTINCT FROM 'ok' THEN
          UPDATE gtd.panel_config
             SET estado     = 'failed',
                 detalle    = COALESCE(p_det, 'el panel rechazó la configuración'),
                 updated_at = now()
           WHERE mac = p_mac AND cfg_v = p_cfg_v;
          RETURN CASE WHEN FOUND THEN 'ok' ELSE 'noop' END;
        END IF;

        UPDATE gtd.panel_config
           SET estado = 'applied', detalle = NULL, updated_at = now()
         WHERE mac = p_mac AND cfg_v = p_cfg_v AND estado <> 'applied';

        -- Sin FOUND no hay nada que confirmar (ack repetido por la
        -- redistribución QoS 1, o de una versión que no es la que mandamos).
        -- Cortar acá es lo que evita encolar un refresh por cada reentrega.
        IF NOT FOUND THEN
          RETURN 'noop';
        END IF;

        -- El refresh que trae el espejo de vuelta. El cid es determinístico para
        -- que un ack reentregado no encole dos.
        v_cid := 'refresh-' || p_mac || '-' || p_cfg_v;
        INSERT INTO gtd.commands (cid, mac, device_id, tipo, payload, estado)
        VALUES (v_cid, p_mac, v_device_id, 'refresh',
                jsonb_build_object('t', 'refresh', 'cid', v_cid), 'pending')
        ON CONFLICT (cid) DO NOTHING;

        RETURN 'ok';
      END;
      $fn$
    `);

    await queryRunner.query(`
      COMMENT ON FUNCTION gtd.confirm_config(TEXT, BIGINT, TEXT, TEXT) IS
        'Ack de una cfg (no trae cid: se correlaciona por mac + cfg_v). Marca applied y encola el cmd t:refresh que actualiza el espejo.'
    `);

    await queryRunner.query(`
      CREATE FUNCTION gtd.last_scan(p_device_id INT)
      RETURNS TABLE (redes JSONB, received_at TIMESTAMPTZ)
      LANGUAGE sql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
        SELECT COALESCE(u.payload->'redes', '[]'::JSONB), u.received_at
          FROM gtd.uplink_raw u
          JOIN device d ON d.mac = u.mac
         WHERE d.id = p_device_id AND u.tipo = 'scan'
         ORDER BY u.received_at DESC
         LIMIT 1;
      $fn$
    `);

    await queryRunner.query(`
      COMMENT ON FUNCTION gtd.last_scan(INT) IS
        'Último up t:scan del equipo. Sale de uplink_raw: los scans ya se guardan ahí, no hace falta tabla.'
    `);

    // Postgres le da EXECUTE a PUBLIC en TODA función nueva. Sin este REVOKE,
    // revocarle a un rol en particular no sirve de nada: lo sigue teniendo por
    // PUBLIC. Va primero y sin guarda: PUBLIC siempre existe.
    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION
        gtd.confirm_config(TEXT, BIGINT, TEXT, TEXT),
        gtd.last_scan(INT)
      FROM PUBLIC
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_alarms') THEN
          GRANT EXECUTE ON FUNCTION
            gtd.confirm_config(TEXT, BIGINT, TEXT, TEXT) TO cps_alarms;
        END IF;
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_web') THEN
          GRANT EXECUTE ON FUNCTION gtd.last_scan(INT) TO cps_web;
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS gtd.last_scan(INT)`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.confirm_config(TEXT, BIGINT, TEXT, TEXT)`,
    );
  }
}
