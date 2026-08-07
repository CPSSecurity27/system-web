import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `gtd.last_ota`: el progreso del OTA deja de tirarse a la basura (2026-08-06).
 *
 * ## Qué estaba pasando
 *
 * El panel **ya venía informando** cómo le iba: `up t:ota` con `estado` y
 * `resultado` (`ota_report()` en `components/main/task_ota.c` lo publica en cada
 * paso — manifiesto bajando, descargando, verificando, listo para reiniciar).
 * El GtD lo guardaba en `gtd.uplink_raw` por el `else` de su dispatcher, y ahí
 * moría: **nadie lo leía**.
 *
 * El resultado en pantalla era que apretabas "actualizar", el comando quedaba en
 * `sent`, y no pasaba nada visible por minutos. El `fw` de `device_state` tampoco
 * ayuda en el momento: llega por el `status` retained, o sea que se refresca
 * recién cuando el panel republica su presencia, ya reiniciado.
 *
 * ## Por qué una función y no un GRANT
 *
 * `docs/roles-conexion-v2.sql` hace `REVOKE ALL ON ALL TABLES IN SCHEMA gtd`
 * para `cps_web`. Abrirle `uplink_raw` entero le daría de paso los `cfg_full`,
 * que llevan **las contraseñas WiFi en claro** — hay una decisión explícita de
 * que eso solo se lee por el endpoint auditado de reveal.
 *
 * Así que va como las otras: `SECURITY DEFINER`, `search_path` fijo, y expone
 * exactamente una cosa. Es el mismo patrón de `gtd.last_scan`, que existe por
 * la misma razón.
 *
 * ## El REVOKE a PUBLIC va primero y no es opcional
 *
 * Postgres le da EXECUTE a PUBLIC en toda función nueva. Sin revocárselo, dársela
 * a `cps_web` no significa nada: cualquier rol la tendría igual.
 */
export class OtaProgress1788300000000 implements MigrationInterface {
  name = 'OtaProgress1788300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION gtd.last_ota(p_device_id INT)
      RETURNS TABLE (estado SMALLINT, resultado SMALLINT, fw TEXT, received_at TIMESTAMPTZ)
      LANGUAGE sql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
        -- Los tres campos del payload de up t:ota (mqtt_build_up_ota):
        --   estado    → ota_state_t     (0..10)
        --   resultado → ota_reject_t    (0..8)
        --   fw        → la versión que el equipo dice tener
        -- Se devuelven como números y los traduce el backend: los nombres son
        -- del firmware y quien manda es su enum, no una tabla nuestra que se
        -- desincronizaría en el próximo release.
        SELECT (u.payload->>'estado')::SMALLINT,
               (u.payload->>'resultado')::SMALLINT,
               u.payload->>'fw',
               u.received_at
          FROM gtd.uplink_raw u
          JOIN device d ON d.mac = u.mac
         WHERE d.id = p_device_id AND u.tipo = 'ota'
         ORDER BY u.received_at DESC
         LIMIT 1;
      $fn$
    `);

    await queryRunner.query(`
      COMMENT ON FUNCTION gtd.last_ota(INT) IS
        'Último up t:ota del equipo. Sale de uplink_raw, igual que last_scan. Función y no GRANT: uplink_raw tiene también los cfg_full, con las passwords WiFi en claro.'
    `);

    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION gtd.last_ota(INT) FROM PUBLIC
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_web') THEN
          GRANT EXECUTE ON FUNCTION gtd.last_ota(INT) TO cps_web;
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS gtd.last_ota(INT)`);
  }
}
