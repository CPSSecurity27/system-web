import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Papelera de controles remotos (2026-08-05). Espejo de `DeviceRemoved`.
 *
 * Un control removido sale de todas las listas pero sigue existiendo: desde la
 * pantalla de removidos se lo puede dar de alta de nuevo o borrar definitivamente.
 *
 * ## Por qué NO es un `status` más
 *
 * La misma razón que en el equipo. `remote_status` tiene `LOST` y `REPLACED`,
 * que suenan parecido pero contestan otra pregunta: describen qué le PASÓ al
 * control en la vida real. `removed_at` dice si alguien lo sacó de circulación
 * en el sistema. Un control puede estar `LOST` y todavía no removido —el vecino
 * avisó que lo perdió y nadie fue a la pantalla— y las dos cosas son verdad.
 *
 * Y hay un impedimento duro además del conceptual: `chk_remote_custody` exige
 * que todo lo que no está en INVENTORY tenga vivienda. Un control de fábrica no
 * tiene ninguna, así que un control recién fabricado no podría marcarse con un
 * estado que no fuera INVENTORY.
 *
 * ## Lo que este hito NO hace
 *
 * **Remover un control NO impide que abra la alarma.** Los códigos viven en la
 * EEPROM de cada panel y la web todavía no los sincroniza (`gtd.enqueue_rf_batch`
 * existe y nadie la llama). Hasta que ese flujo esté, sacar un control del
 * sistema es un acto administrativo: el llavero perdido sigue disparando.
 *
 * Es el mismo agujero que en el equipo se resolvió revocando la credencial del
 * broker al remover. Acá el equivalente es un `cmd t:rf op:del` a cada panel del
 * barrio, y por eso la pantalla lo dice con todas las letras en vez de dejar que
 * alguien suponga que removerlo alcanza.
 */
export class RemoteRemoved1787600000000 implements MigrationInterface {
  name = 'RemoteRemoved1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE remote
        ADD COLUMN removed_at TIMESTAMPTZ,
        ADD COLUMN removed_by INT REFERENCES app_user(id) ON DELETE SET NULL
    `);
    // Los dos o ninguno: una fecha sin autor no sirve para auditar nada.
    await queryRunner.query(`
      ALTER TABLE remote
        ADD CONSTRAINT chk_remote_removed CHECK (
          (removed_at IS NULL AND removed_by IS NULL) OR
          (removed_at IS NOT NULL AND removed_by IS NOT NULL)
        )
    `);
    // Parcial: las listas preguntan siempre por los NO removidos, que son la
    // enorme mayoría. Un índice sobre toda la tabla sería casi todo relleno.
    await queryRunner.query(`
      CREATE INDEX idx_remote_removed ON remote(removed_at)
        WHERE removed_at IS NOT NULL
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN remote.removed_at IS
        'Fuera de circulación. OJO: no impide que el control siga abriendo la alarma — los códigos viven en la EEPROM del panel y todavía no se sincronizan.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_remote_removed`);
    await queryRunner.query(
      `ALTER TABLE remote DROP CONSTRAINT chk_remote_removed`,
    );
    await queryRunner.query(`
      ALTER TABLE remote
        DROP COLUMN removed_by,
        DROP COLUMN removed_at
    `);
  }
}
