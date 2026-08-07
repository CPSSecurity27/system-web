import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El `cid` pasa a 23 caracteres: 24 era uno de más (2026-08-06).
 *
 * ## El síntoma
 *
 * Los comandos se quedaban en `sent` para siempre. El panel los EJECUTABA —el
 * escaneo devolvía redes, el i2c_scan corría— y ackeaba `res:"ok"`, pero la web
 * nunca los daba por confirmados. Los únicos que sí confirmaban eran los
 * `refresh` automáticos que encola `confirm_config`, y ahí estaba la pista: su
 * cid es `refresh-<MAC>-<n>`, de 22 caracteres.
 *
 * ## La causa
 *
 * `MQTT_CID_MAXLEN` (24) es el TAMAÑO DEL BUFFER, no el largo máximo:
 *
 *     char cid[MQTT_CID_MAXLEN];                        // mqtt_parse.h
 *     strncpy(dst, it->valuestring, len - 1);           // mqtt_parse.c
 *     dst[len - 1] = '\0';
 *
 * O sea que entran **23 caracteres y el NUL**. Un cid de 24 se guarda truncado y
 * el panel ackea con ESE, que ya no matchea la fila:
 *
 *     mandamos  cmd-a043b34fb05446eea5a2   (24)
 *     volvió    cmd-a043b34fb05446eea5a    (23)
 *
 * `confirm_command` devolvía `unknown_cid` y el comando quedaba colgado.
 *
 * ## Por qué importaba más de lo que parecía
 *
 * No era solo un estado feo en una pantalla: **la sincronización de base RF se
 * habría colgado en el primer paso**. Su cadena avanza cuando `confirm_command`
 * destraba el siguiente `queued`, y sin confirmación no destraba nada. Una tanda
 * de 24 lotes habría publicado uno y esperado para siempre.
 *
 * ## Y de paso, los que quedaron colgados
 *
 * Se cierran comparando contra el ack que el panel ya mandó, que está guardado
 * en `gtd.uplink_raw`: si el cid del ack es el nuestro sin el último carácter,
 * es el mismo comando. Es una reparación de una sola vez — con el cid de 23 no
 * vuelve a pasar.
 */
export class CidDe231788000000000 implements MigrationInterface {
  name = 'CidDe231788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.new_cid() RETURNS TEXT
      LANGUAGE sql
      AS $fn$
        -- 23 y no 24: MQTT_CID_MAXLEN es el tamaño del BUFFER del firmware
        -- (char cid[24]), así que el último byte es el NUL. Un cid de 24 llega
        -- truncado y su ack no matchea nunca.
        SELECT LEFT('cmd-' || REPLACE(gen_random_uuid()::TEXT, '-', ''), 23);
      $fn$
    `);

    // Los que quedaron en el aire: el panel los hizo y lo dijo, pero su ack se
    // descartó por no encontrar el cid. Se cierran con lo que el propio panel
    // contestó, no inventando un estado.
    await queryRunner.query(`
      UPDATE gtd.commands c
         SET estado       = CASE WHEN a.payload->>'res' = 'ok' THEN 'ok' ELSE 'error' END,
             detalle      = COALESCE(a.payload->>'det', c.detalle),
             confirmed_at = COALESCE(c.confirmed_at, now())
        FROM gtd.uplink_raw a
       WHERE c.estado = 'sent'
         AND length(c.cid) = 24
         AND a.payload->>'t' = 'ack'
         AND a.payload->>'cid' = LEFT(c.cid, 23)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Vuelve a 24. Los comandos reconciliados NO se desconfirman: el panel los
    // ejecutó de verdad, y volver a decir "enviado" sería la mentira de antes.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.new_cid() RETURNS TEXT
      LANGUAGE sql
      AS $fn$
        SELECT LEFT('cmd-' || REPLACE(gen_random_uuid()::TEXT, '-', ''), 24);
      $fn$
    `);
  }
}
