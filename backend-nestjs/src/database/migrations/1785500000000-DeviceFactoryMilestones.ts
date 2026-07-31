import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hitos de puesta en marcha del equipo (2026-07-28).
 *
 * La fábrica necesita saber en qué punto está cada equipo entre que se da de
 * alta y que conecta por primera vez. Eso NO se modela como una columna de
 * estado más: se guardan los HITOS con su fecha y la etapa se DERIVA del
 * último alcanzado.
 *
 *   CREADO        created_at            (ya existía: el alta)
 *   PROVISIONADO  mqtt_provisioned_at   (ya existía: credencial en el broker)
 *   ETIQUETADO    labeled_at            ← nuevo
 *   1ª CONEXIÓN   first_connection_at   ← nuevo
 *
 * Un enum de etapa aparte sería un segundo lugar donde vive el mismo dato, y
 * el día que alguien lo actualice sin tocar el timestamp (o al revés) la fila
 * se contradice a sí misma. Derivándola, eso es imposible.
 *
 * `first_connection_source` existe por la regla 5 del dominio: el estado vivo
 * lo escribe el servicio de alarmas, no la web. La primera conexión es un
 * hecho OBSERVADO por el broker; mientras el GtD no exista, CPS puede marcarla
 * a mano, pero entonces queda registrado que fue a mano y por quién. Un dato
 * cargado a dedo y uno medido no valen lo mismo y la pantalla tiene que poder
 * mostrar la diferencia.
 */
export class DeviceFactoryMilestones1785500000000 implements MigrationInterface {
  name = 'DeviceFactoryMilestones1785500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE device_milestone_source AS ENUM ('OBSERVED', 'MANUAL')
    `);

    await queryRunner.query(`
      ALTER TABLE device
        ADD COLUMN labeled_at TIMESTAMPTZ,
        ADD COLUMN labeled_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        ADD COLUMN first_connection_at TIMESTAMPTZ,
        ADD COLUMN first_connection_source device_milestone_source,
        ADD COLUMN first_connection_by INT REFERENCES app_user(id) ON DELETE SET NULL
    `);

    // La fecha y su origen viajan juntos o no viajan: sin esto se podría tener
    // una primera conexión sin saber si la vio el broker o la tipeó alguien,
    // que es justo la distinción por la que existe la columna.
    await queryRunner.query(`
      ALTER TABLE device
        ADD CONSTRAINT chk_device_first_connection CHECK (
          (first_connection_at IS NULL AND first_connection_source IS NULL)
          OR
          (first_connection_at IS NOT NULL AND first_connection_source IS NOT NULL)
        ),
        -- Un hito OBSERVADO no tiene autor humano; uno MANUAL sí, siempre.
        ADD CONSTRAINT chk_device_first_connection_by CHECK (
          first_connection_source IS DISTINCT FROM 'MANUAL'
          OR first_connection_by IS NOT NULL
        )
    `);

    // Para "¿qué equipos quedaron a medio poner en marcha?", que es la pregunta
    // que la pantalla de fábrica hace todo el tiempo.
    await queryRunner.query(`
      CREATE INDEX idx_device_first_connection ON device(first_connection_at)
        WHERE first_connection_at IS NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN device.first_connection_source IS
        'OBSERVED = lo vio el broker (servicio de alarmas). MANUAL = lo marcó CPS a mano; queda en audit_log.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_device_first_connection`);
    await queryRunner.query(`
      ALTER TABLE device
        DROP CONSTRAINT IF EXISTS chk_device_first_connection_by,
        DROP CONSTRAINT IF EXISTS chk_device_first_connection
    `);
    await queryRunner.query(`
      ALTER TABLE device
        DROP COLUMN IF EXISTS first_connection_by,
        DROP COLUMN IF EXISTS first_connection_source,
        DROP COLUMN IF EXISTS first_connection_at,
        DROP COLUMN IF EXISTS labeled_by,
        DROP COLUMN IF EXISTS labeled_at
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS device_milestone_source`);
  }
}
