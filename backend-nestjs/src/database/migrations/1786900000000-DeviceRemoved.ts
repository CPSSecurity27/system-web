import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Papelera de equipos (2026-08-05).
 *
 * Un equipo removido sale de todas las listas pero sigue existiendo: desde la
 * pantalla de removidos se puede dar de alta de nuevo o borrar definitivamente.
 *
 * ## Por qué NO es un `status` más
 *
 * La tentación era usar `RETIRED`, que ya existe en `device_status`. No se
 * puede: el CHECK `chk_device_custody` impone que todo lo que no está en
 * INVENTORY tenga barrio, y un equipo de fábrica no tiene ninguno. Un equipo
 * recién fabricado no podría removerse.
 *
 * Y aunque se pudiera, sería mezclar dos preguntas distintas: `status` dice en
 * qué punto del ciclo de vida está el equipo (en stock, operativo, en
 * mantenimiento); `removed_at` dice si alguien lo sacó de circulación. Un equipo
 * puede estar OPERATIONAL y removido, y las dos cosas son verdad.
 *
 * ## Qué se lleva puesto el borrado definitivo
 *
 * Decisión del usuario (2026-08-05): borra todo lo que cuelgue del equipo,
 * incluida la bitácora de mantenimiento (`device_maintenance` es ON DELETE
 * CASCADE). Los EVENTOS lo siguen bloqueando igual —`event.device_id` es ON
 * DELETE RESTRICT y son append-only—, así que un equipo que llegó a reportar
 * algo no se borra: se queda en la papelera. El servicio traduce ese rechazo de
 * la base a un mensaje que se entienda.
 */
export class DeviceRemoved1786900000000 implements MigrationInterface {
  name = 'DeviceRemoved1786900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE device
        ADD COLUMN removed_at TIMESTAMPTZ,
        ADD COLUMN removed_by INT REFERENCES app_user(id) ON DELETE SET NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN device.removed_at IS
        'Sacado de circulación: no aparece en ninguna lista, pero sigue existiendo. Eje aparte de status, no un estado más del ciclo de vida.'
    `);

    await queryRunner.query(`
      ALTER TABLE device ADD CONSTRAINT chk_device_removed_by CHECK (
        (removed_at IS NULL AND removed_by IS NULL)
        OR (removed_at IS NOT NULL AND removed_by IS NOT NULL)
      )
    `);

    // Los listados normales filtran `removed_at IS NULL` en TODA consulta, así
    // que el índice parcial es el que sirve: indexa lo vivo, que es lo que se
    // consulta siempre, y no crece con la papelera.
    await queryRunner.query(`
      CREATE INDEX idx_device_vivos ON device(id) WHERE removed_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_device_vivos`);
    await queryRunner.query(
      `ALTER TABLE device DROP CONSTRAINT chk_device_removed_by`,
    );
    await queryRunner.query(`
      ALTER TABLE device
        DROP COLUMN removed_at,
        DROP COLUMN removed_by
    `);
  }
}
