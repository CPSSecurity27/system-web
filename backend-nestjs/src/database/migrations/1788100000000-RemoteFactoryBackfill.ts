import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Los controles anteriores a la fábrica entran a la fábrica (2026-08-06).
 *
 * ## Qué problema resuelve
 *
 * Los 46 controles que se migraron de Firebase al Barrio Docente nacieron sin
 * `serial`, sin `model_id` y sin visto bueno: la base vieja no tenía ninguno de
 * los tres. Eso los dejaba invisibles en `/inventario/fabrica/controles` —que
 * lista `serial IS NOT NULL`— y sin etiqueta imprimible, porque `etiqueta()`
 * exige serial y modelo. En el stock no aparecían ni tenían por qué: están
 * entregados en su vivienda, y ahí manda `chk_remote_custody`.
 *
 * No es un arreglo de la migración de Firebase: es la decisión de que un control
 * que está en la calle sin serial no se puede administrar. Se lo trata como lo
 * que es —fabricado antes de que existiera la fábrica— y se lo REGULARIZA.
 *
 * ## Qué toca, y qué no
 *
 * Solo filas con `serial IS NULL`. Un control fabricado acá nunca entra en el
 * `WHERE`, así que correr esto dos veces no reasigna nada ni quema seriales de
 * más.
 *
 * - **serial**: de `remote_serial_seq`, la MISMA secuencia que usa
 *   `manufacture()`. Salen correlativos con los de fábrica y no hay forma de
 *   colisionar con uno futuro.
 * - **model_id**: se DEDUCE de cuántos códigos tiene cada control, contra
 *   `remote_model.buttons`. Los 46 tienen 4 códigos y el modelo activo de 4
 *   botones es CR4. Si alguno no matchea ningún modelo activo se lo deja como
 *   está: inventarle un modelo sería peor que dejarlo afuera, porque el modelo
 *   dice cuántos botones tiene el llavero que la familia tiene en la mano.
 * - **claim_code**: el alfabeto de `generarClaimCode()` (sin 0/O ni 1/I), 6
 *   caracteres. Es inerte en estos controles —`adopt()` rechaza cualquiera que
 *   ya tenga vivienda—, pero la etiqueta lo lleva impreso y una etiqueta a
 *   medias no sirve. La subconsulta se correlaciona con `r.id` a propósito: sin
 *   eso Postgres la evalúa UNA vez y las 46 filas salen con el mismo código,
 *   contra `uq_remote_claim_code`.
 * - **manufactured_at/by** y **ready_at/by**: `created_at`/`created_by` de la
 *   fila, que es lo único cierto que sabemos —cuándo entraron al sistema y quién
 *   los cargó—. Es el mismo criterio con el que `RemoteReady` rellenó los
 *   controles que ya existían. Van en par por `chk_remote_ready`, así que si la
 *   fila no tiene `created_by` el visto bueno queda sin poner.
 *
 * ## El rastro
 *
 * Cada fila regularizada deja un `audit_log`. No es ceremonia: es un cambio de
 * datos en producción sobre controles que están en la calle, y además es lo que
 * hace que el `down()` sepa exactamente qué filas tocó.
 */
export class RemoteFactoryBackfill1788100000000 implements MigrationInterface {
  name = 'RemoteFactoryBackfill1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH candidato AS (
        SELECT r.id, count(c.id) AS botones
          FROM remote r
          LEFT JOIN remote_code c ON c.remote_id = r.id
         WHERE r.serial IS NULL
           AND r.removed_at IS NULL
         GROUP BY r.id
      ),
      con_modelo AS (
        SELECT k.id,
               (SELECT m.id
                  FROM remote_model m
                 WHERE m.buttons = k.botones
                   AND m.active
                 ORDER BY m.id
                 LIMIT 1) AS model_id
          FROM candidato k
         WHERE k.botones > 0
      ),
      regularizado AS (
        UPDATE remote r
           SET serial   = 'CR-' || lpad(nextval('remote_serial_seq')::text, 6, '0'),
               model_id = cm.model_id,
               claim_code = (
                 SELECT string_agg(
                          substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                                 floor(random() * 32)::int + 1, 1), '')
                   FROM generate_series(1, 6)
                  -- Correlación deliberada: fuerza una evaluación POR FILA.
                  WHERE r.id IS NOT NULL
               ),
               manufactured_at = r.created_at,
               manufactured_by = r.created_by,
               ready_at = CASE WHEN r.created_by IS NOT NULL
                               THEN r.created_at ELSE NULL END,
               ready_by = r.created_by
          FROM con_modelo cm
         WHERE cm.id = r.id
           AND cm.model_id IS NOT NULL
           AND r.serial IS NULL
        RETURNING r.id, r.serial, r.model_id, r.ready_at, r.created_by
      )
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id,
                             new_value, metadata)
      SELECT created_by,
             'remote.factory_backfill',
             'remote',
             id,
             jsonb_build_object('serial', serial,
                                'modelId', model_id,
                                'readyAt', ready_at),
             jsonb_build_object(
               'motivo', 'Control anterior a la fábrica: se regulariza para que '
                      || 'entre al registro de fábrica y pueda etiquetarse',
               'migracion', 'RemoteFactoryBackfill1788100000000')
        FROM regularizado
    `);
  }

  /**
   * Deshace SOLO lo que esta migración escribió, fila por fila, según el rastro
   * del `audit_log`. Los seriales quemados de la secuencia no vuelven, y está
   * bien que no vuelvan: un serial reutilizado es un serial que miente.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE remote r
         SET serial = NULL,
             model_id = NULL,
             claim_code = NULL,
             manufactured_at = NULL,
             manufactured_by = NULL,
             ready_at = NULL,
             ready_by = NULL
        FROM audit_log a
       WHERE a.entity_type = 'remote'
         AND a.entity_id = r.id
         AND a.action = 'remote.factory_backfill'
    `);

    await queryRunner.query(
      `DELETE FROM audit_log WHERE action = 'remote.factory_backfill'`,
    );
  }
}
