import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Organización de cuentas: planes, cupos por rol y el rename PRIVATE →
 * COMMUNITY (2026-07-30).
 *
 * Tres cambios que van juntos porque son la misma decisión de negocio:
 *
 * 1. `PRIVATE` pasa a llamarse `COMMUNITY`. El nombre viejo describía la
 *    propiedad legal del barrio ("privado" vs "público"), que no es lo que
 *    diferencia a las dos organizaciones: lo que las diferencia es la ESCALA
 *    (una comunitaria gestiona un solo barrio, una municipal varios). Además
 *    "privado" chocaba de frente con `managed_by`, que es otra cosa.
 *
 * 2. Cupos POR ROL (`max_admin_users`, `max_technician_users`, junto al
 *    `max_monitor_users` que ya existía). El cupo 0 es el que hace el trabajo
 *    fino: significa "este rol no existe en esta cuenta". Así, que una
 *    comunitaria llave en mano no tenga técnicos propios (los pone CPS) se
 *    expresa con el MISMO mecanismo que el resto de la tarifa, en vez de con
 *    una matriz de roles-por-tipo-de-cuenta aparte. Un solo lugar donde mirar.
 *
 * 3. Tabla `plan`: el catálogo comercial. Es una PLANTILLA, no una fuente de
 *    verdad — al crear la cuenta los cupos se COPIAN a las columnas del
 *    `account`. Si mañana se reconfigura el plan "Municipal Base", los
 *    clientes que ya lo compraron no mutan solos. Es la misma lógica del
 *    `service_contract`, que congela condiciones al firmar, y es lo único
 *    compatible con el grandfathering de la regla 4 del dominio: un cupo que
 *    cambia solo, por debajo, sin pasar por `audit_log`, es exactamente lo que
 *    esa regla prohíbe. `account.plan_id` queda como referencia histórica
 *    ("¿cuántos clientes hay en cada plan?"), NUNCA como origen de lectura.
 */
export class AccountPlansAndRoleQuotas1785600000000 implements MigrationInterface {
  name = 'AccountPlansAndRoleQuotas1785600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- 1. PRIVATE -> COMMUNITY ---------------------------------------------
    // RENAME VALUE preserva las filas existentes: no hay que reescribir datos
    // ni recrear el tipo con todas sus dependencias.
    await queryRunner.query(`
      ALTER TYPE org_subtype RENAME VALUE 'PRIVATE' TO 'COMMUNITY'
    `);

    // --- 2. Cupos por rol -----------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE account
        ADD COLUMN max_admin_users      INT CHECK (max_admin_users >= 0),
        ADD COLUMN max_technician_users INT CHECK (max_technician_users >= 0)
    `);

    // Backfill antes de exigir NOT NULL en el CHECK de abajo. Los valores son
    // deliberadamente conservadores y CPS los ajusta por /quotas: 3 admins
    // para cualquiera, y técnicos propios solo para la municipal — la
    // comunitaria arranca en 0 porque el trabajo de campo lo hace CPS.
    await queryRunner.query(`
      UPDATE account
         SET max_admin_users = 3,
             max_technician_users = CASE WHEN subtype = 'MUNICIPAL' THEN 3 ELSE 0 END
       WHERE type = 'ORGANIZATION'
    `);

    // --- 3. Catálogo de planes -----------------------------------------------
    // Es catálogo y no enum para que un plan nuevo sea un INSERT y no una
    // migración: la oferta comercial cambia más seguido que el esquema.
    await queryRunner.query(`
      CREATE TABLE plan (
        id                      SERIAL PRIMARY KEY,
        code                    TEXT NOT NULL UNIQUE,
        name                    TEXT NOT NULL,
        description             TEXT,

        -- A qué clase de organización aplica. Un plan municipal ofrecido a una
        -- comunitaria (o al revés) sería un error de venta silencioso.
        applies_to              org_subtype NOT NULL,

        -- Precio de REFERENCIA (lista). El precio que se cobra es el del
        -- service_contract, que se congela al firmar; este es el de la vidriera.
        price_reference         NUMERIC(12,2),
        active                  BOOLEAN NOT NULL DEFAULT true,

        -- Cupos de ORGANIZACIÓN que el plan otorga
        max_neighborhoods       INT NOT NULL CHECK (max_neighborhoods >= 1),
        max_admin_users         INT NOT NULL CHECK (max_admin_users >= 0),
        max_technician_users    INT NOT NULL CHECK (max_technician_users >= 0),
        max_monitor_users       INT NOT NULL CHECK (max_monitor_users >= 0),

        -- Cupos de BARRIO que el plan sugiere para los barrios que se creen
        max_family_members      INT NOT NULL DEFAULT 3 CHECK (max_family_members >= 0),
        remote_controls_enabled BOOLEAN NOT NULL DEFAULT true,

        created_by              INT REFERENCES app_user(id) ON DELETE SET NULL,
        updated_by              INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT chk_plan_code CHECK (code ~ '^[A-Z0-9_]{2,32}$'),
        -- La invariante de la comunitaria, también acá: sin esto se podría
        -- armar un plan COMMUNITY de 5 barrios que el servicio va a rechazar
        -- recién al momento de venderlo.
        CONSTRAINT chk_plan_community_single_neighborhood CHECK (
          applies_to <> 'COMMUNITY' OR max_neighborhoods = 1
        )
      )
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_plan_updated BEFORE UPDATE ON plan
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    // ON DELETE SET NULL y no RESTRICT: el plan es una etiqueta histórica, no
    // una dependencia. Borrar un plan discontinuado no puede quedar bloqueado
    // por clientes viejos, y perder la etiqueta no le cambia los cupos a nadie
    // (los tiene copiados en sus propias columnas).
    await queryRunner.query(`
      ALTER TABLE account
        ADD COLUMN plan_id INT REFERENCES plan(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN account.plan_id IS
        'De qué plan salieron los cupos al crear la cuenta. REFERENCIA HISTÓRICA: los cupos vigentes son las columnas max_* de esta misma fila, nunca las del plan.'
    `);

    // --- 4. El CHECK de coherencia, ampliado ---------------------------------
    // Se refuerza en las dos direcciones: la ORGANIZATION ahora exige TENER
    // los cuatro cupos (antes "no existe sin límite" vivía solo en el
    // servicio; ahora lo garantiza la base), y la COMPANY exige no tener
    // ninguno — CPS no se cobra a sí misma ni compra planes.
    await queryRunner.query(`
      ALTER TABLE account DROP CONSTRAINT chk_subtype_by_type
    `);
    await queryRunner.query(`
      ALTER TABLE account
        ADD CONSTRAINT chk_subtype_by_type CHECK (
          (type = 'ORGANIZATION'
            AND subtype IS NOT NULL
            AND max_neighborhoods IS NOT NULL
            AND max_admin_users IS NOT NULL
            AND max_technician_users IS NOT NULL
            AND max_monitor_users IS NOT NULL)
          OR
          (type = 'COMPANY'
            AND subtype IS NULL
            AND plan_id IS NULL
            AND max_neighborhoods IS NULL
            AND max_admin_users IS NULL
            AND max_technician_users IS NULL
            AND max_monitor_users IS NULL)
        )
    `);

    // --- 5. Planes de arranque -----------------------------------------------
    // Dos, uno por línea de negocio, para que el alta de cuenta tenga algo que
    // ofrecer desde el minuto cero. Son editables como cualquier otro.
    await queryRunner.query(`
      INSERT INTO plan (
        code, name, description, applies_to, price_reference,
        max_neighborhoods, max_admin_users, max_technician_users, max_monitor_users,
        max_family_members, remote_controls_enabled
      ) VALUES
      (
        'COMUNITARIA_BASE', 'Comunitaria Base',
        'Un barrio, gestión de CPS o propia. El trabajo de campo lo hace CPS: sin técnicos propios.',
        'COMMUNITY', NULL,
        1, 2, 0, 1,
        3, true
      ),
      (
        'MUNICIPAL_BASE', 'Municipal Base',
        'Autogestión: varios barrios, personal propio de campo y de monitoreo.',
        'MUNICIPAL', NULL,
        10, 5, 5, 5,
        3, true
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE account DROP CONSTRAINT IF EXISTS chk_subtype_by_type
    `);
    await queryRunner.query(`
      ALTER TABLE account
        ADD CONSTRAINT chk_subtype_by_type CHECK (
          (type = 'ORGANIZATION' AND subtype IS NOT NULL)
          OR
          (type = 'COMPANY' AND subtype IS NULL
            AND max_neighborhoods IS NULL AND max_monitor_users IS NULL)
        )
    `);
    await queryRunner.query(`
      ALTER TABLE account DROP COLUMN IF EXISTS plan_id
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS plan`);
    await queryRunner.query(`
      ALTER TABLE account
        DROP COLUMN IF EXISTS max_technician_users,
        DROP COLUMN IF EXISTS max_admin_users
    `);
    await queryRunner.query(`
      ALTER TYPE org_subtype RENAME VALUE 'COMMUNITY' TO 'PRIVATE'
    `);
  }
}
