import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * La escalera de puesta en marcha pasa a cuatro peldaños (2026-08-05):
 *
 *     FABRICADO -> CONECTADO -> TESTEADO -> LISTO
 *
 * Ver `docs/superpowers/specs/2026-08-04-fabrica-alarmas-design.md` §7.
 *
 * ## Por qué `tested` deja de ser un booleano
 *
 * `tested BOOLEAN` era "probado en fábrica", un tilde que se marcaba en el alta:
 * antes de que el equipo se conectara a nada. La etapa nueva es otra cosa —la
 * prueba funcional del equipo YA CONECTADO (sirena, RF, sensores)— y va después
 * de CONECTADO en la escalera.
 *
 * Un booleano no puede sostener eso: no dice CUÁNDO se probó ni QUIÉN lo probó,
 * y sin fecha no se puede ordenar contra los otros hitos. Se reemplaza por
 * `tested_at` + `tested_by`, igual que `labeled_at` y `first_connection_at`.
 *
 * ## LISTO
 *
 * El visto bueno explícito de una persona antes de que el equipo salga de
 * fábrica. NO se deriva de los otros tres (decisión del usuario, 2026-08-05):
 * que los hitos anteriores estén cumplidos no es lo mismo que alguien se haga
 * cargo de que el equipo puede despacharse.
 *
 * ## `labeled_at` se queda
 *
 * Deja de ser una ETAPA pero sigue siendo un hito con fecha: es lo que permite
 * preguntar "¿a cuáles de esta tanda les falta la etiqueta?". Imprimir lo sigue
 * sellando. No hay nada que migrar.
 */
export class DeviceTestedAndReady1786800000000 implements MigrationInterface {
  name = 'DeviceTestedAndReady1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE device
        ADD COLUMN tested_at TIMESTAMPTZ,
        ADD COLUMN tested_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        ADD COLUMN ready_at  TIMESTAMPTZ,
        ADD COLUMN ready_by  INT REFERENCES app_user(id) ON DELETE SET NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN device.tested_at IS
        'Prueba funcional del equipo YA CONECTADO (sirena, RF, sensores). Reemplaza al booleano tested, que no decía cuándo ni quién.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN device.ready_at IS
        'Visto bueno para que el equipo salga de fábrica. No se deriva de los otros hitos: es alguien haciéndose cargo.'
    `);

    // Los hitos van con su autor o no van: un "lo probó alguien" sin nombre no
    // sirve para nada cuando hay que preguntarle qué probó.
    await queryRunner.query(`
      ALTER TABLE device ADD CONSTRAINT chk_device_tested_by CHECK (
        (tested_at IS NULL AND tested_by IS NULL)
        OR (tested_at IS NOT NULL AND tested_by IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE device ADD CONSTRAINT chk_device_ready_by CHECK (
        (ready_at IS NULL AND ready_by IS NULL)
        OR (ready_at IS NOT NULL AND ready_by IS NOT NULL)
      )
    `);

    // El booleano viejo se va. La base es de prueba y no hay dato que preservar;
    // si lo hubiera, un `tested = true` sin fecha ni autor no se podría convertir
    // en un hito honesto de todas formas.
    await queryRunner.query(`ALTER TABLE device DROP COLUMN tested`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE device ADD COLUMN tested BOOLEAN NOT NULL DEFAULT false
    `);
    await queryRunner.query(
      `ALTER TABLE device DROP CONSTRAINT chk_device_ready_by`,
    );
    await queryRunner.query(
      `ALTER TABLE device DROP CONSTRAINT chk_device_tested_by`,
    );
    await queryRunner.query(`
      ALTER TABLE device
        DROP COLUMN tested_at,
        DROP COLUMN tested_by,
        DROP COLUMN ready_at,
        DROP COLUMN ready_by
    `);
  }
}
