import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El visto bueno de fábrica del control remoto (2026-08-05).
 *
 * Mismo peldaño que el `ready_at` del equipo, y por la misma razón: **fabricar
 * no es estar listo**. Entre las dos cosas hay un rato en la mesa —grabar los
 * códigos en el control, pegarle la etiqueta, probar que transmita— y durante
 * ese rato el control existe en el sistema pero no puede salir.
 *
 * Sin este hito, un control aparecía en el stock apenas se le asignaba un
 * serial, o sea antes de tener los códigos grabados: alguien podía entregarle a
 * un vecino un llavero que todavía no era nada.
 *
 * `remote.status` no alcanzaba para esto. Un control recién fabricado ya está en
 * `INVENTORY` —el CHECK de custodia lo exige mientras no tenga vivienda— así que
 * el estado no puede distinguir "en la mesa" de "listo para entregar". Son dos
 * preguntas distintas: `status` dice dónde está en su ciclo de vida, `ready_at`
 * dice si pasó por el visto bueno.
 *
 * Es REVERSIBLE a propósito (se puede desmarcar), igual que en el equipo: el
 * error más común es marcar de más, y obligar a borrar el control para
 * corregirlo sería peor que el error.
 */
export class RemoteReady1787500000000 implements MigrationInterface {
  name = 'RemoteReady1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE remote
        ADD COLUMN ready_at TIMESTAMPTZ,
        ADD COLUMN ready_by INT REFERENCES app_user(id) ON DELETE SET NULL
    `);
    // Los dos o ninguno: una fecha sin autor no sirve para auditar nada.
    await queryRunner.query(`
      ALTER TABLE remote
        ADD CONSTRAINT chk_remote_ready CHECK (
          (ready_at IS NULL AND ready_by IS NULL) OR
          (ready_at IS NOT NULL AND ready_by IS NOT NULL)
        )
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN remote.ready_at IS
        'Visto bueno de fábrica: hasta que no está, el control no entra al stock. Fabricar no es estar listo — falta grabarle los códigos y etiquetarlo.'
    `);

    // Los que ya existen se dan por listos: son anteriores a la fábrica y
    // algunos ya están entregados. Dejarlos sin hito los sacaría del stock de
    // golpe, que es justo lo que una migración no tiene que hacer.
    await queryRunner.query(`
      UPDATE remote
         SET ready_at = COALESCE(manufactured_at, created_at),
             ready_by = COALESCE(manufactured_by, created_by)
       WHERE COALESCE(manufactured_by, created_by) IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE remote DROP CONSTRAINT chk_remote_ready`,
    );
    await queryRunner.query(`
      ALTER TABLE remote
        DROP COLUMN ready_by,
        DROP COLUMN ready_at
    `);
  }
}
