import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Viviendas y vecinos (2026-08-02). Ver
 * `docs/superpowers/specs/2026-08-02-viviendas-y-vecinos-design.md`.
 *
 * 1) LA DIRECCIÓN IDENTIFICA LA VIVIENDA. Se va `home.name` y `address` pasa a
 *    obligatoria. Con los dos campos el gestor terminaba escribiendo la
 *    dirección en el nombre y quedaban desincronizados; la base Firebase real
 *    nunca tuvo nombre de vivienda y no le hizo falta.
 *
 * 2) GPS OBLIGATORIO. Es dato operativo, no adorno: sale en el mapa del
 *    monitoreo y en el `gps` del evento. En Firebase lo tenían 16 de 16
 *    viviendas, así que exigirlo no le cuesta nada a nadie.
 *
 * 3) UNA PERSONA, UNA VIVIENDA. El único parcial `uq_user_single_titular`
 *    (solo TITULAR) se reemplaza por uno TOTAL sobre `user_id`. Sin esto un
 *    vecino podía ser familiar en dos casas de dos barrios: el evento no sabría
 *    qué barrio despertar y el cupo de familiares se esquivaba repartiendo
 *    gente entre hogares. Es el `user.home_id` de Firebase, pero garantizado
 *    por la base en vez de por el código.
 *
 *    De paso caen dos índices que el nuevo subsume: `uq_home_member`
 *    (home_id, user_id) y `idx_home_member_user`.
 *
 * 4) `birth_date` EN app_user. Estaba en Firebase, no estaba acá. Opcional.
 *
 * 5) `community_scope_enabled`: el permiso de disparar TODAS las alarmas del
 *    barrio desde la app. Era `plan.community_mode_enabled` en Firebase y se
 *    había perdido en el rediseño. Es una decisión comercial, así que es un
 *    CUPO: solo CPS lo escribe, con `audit_log` (regla 4). Va en `neighborhood`
 *    (donde se aplica) y en `plan` (la plantilla que se copia al vender).
 */
export class HomeAddressAndNeighborResident1785900000000 implements MigrationInterface {
  name = 'HomeAddressAndNeighborResident1785900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- 1) La dirección identifica la vivienda ---
    // El nombre viejo se rescata como dirección donde no haya: perder el dato
    // sería peor que quedarse con un "Casa de Pérez" en el campo dirección.
    await queryRunner.query(
      `UPDATE home SET address = name WHERE address IS NULL OR address = ''`,
    );
    await queryRunner.query(`ALTER TABLE home DROP COLUMN name`);
    await queryRunner.query(
      `ALTER TABLE home ALTER COLUMN address SET NOT NULL`,
    );
    await queryRunner.query(`
      COMMENT ON COLUMN home.address IS
        'Identifica la vivienda: no hay nombre aparte. "Mza A Casa 5".'
    `);

    // --- 2) GPS obligatorio ---
    // Las filas viejas sin coordenadas heredan las del barrio: es falso como
    // ubicación exacta pero cierto como zona, y deja la columna NOT NULL sin
    // inventar un (0,0) que caería en el Golfo de Guinea.
    await queryRunner.query(`
      UPDATE home h SET
        latitude  = COALESCE(h.latitude,  n.latitude),
        longitude = COALESCE(h.longitude, n.longitude)
      FROM neighborhood n
      WHERE n.id = h.neighborhood_id
        AND (h.latitude IS NULL OR h.longitude IS NULL)
    `);
    await queryRunner.query(
      `ALTER TABLE home ALTER COLUMN latitude SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE home ALTER COLUMN longitude SET NOT NULL`,
    );

    // --- 3) Una persona, una vivienda ---
    await queryRunner.query(`DROP INDEX uq_user_single_titular`);
    await queryRunner.query(
      `ALTER TABLE home_member DROP CONSTRAINT uq_home_member`,
    );
    await queryRunner.query(`DROP INDEX idx_home_member_user`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_home_member_one_home ON home_member(user_id)`,
    );

    // --- 4) Fecha de nacimiento del vecino ---
    await queryRunner.query(`ALTER TABLE app_user ADD COLUMN birth_date DATE`);
    await queryRunner.query(`
      COMMENT ON COLUMN app_user.birth_date IS
        'Dato opcional del vecino. Los usuarios de panel no lo usan.'
    `);

    // --- 5) Permiso de alarma comunitaria (CUPO: solo CPS) ---
    await queryRunner.query(`
      ALTER TABLE neighborhood
        ADD COLUMN community_scope_enabled BOOLEAN NOT NULL DEFAULT true
    `);
    await queryRunner.query(`
      ALTER TABLE plan
        ADD COLUMN community_scope_enabled BOOLEAN NOT NULL DEFAULT true
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN neighborhood.community_scope_enabled IS
        'CUPO (solo CPS): habilita eventos scope=COMMUNITY, o sea disparar todas
         las alarmas del barrio desde la app del vecino.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE plan DROP COLUMN community_scope_enabled`,
    );
    await queryRunner.query(
      `ALTER TABLE neighborhood DROP COLUMN community_scope_enabled`,
    );

    await queryRunner.query(`ALTER TABLE app_user DROP COLUMN birth_date`);

    await queryRunner.query(`DROP INDEX uq_home_member_one_home`);
    await queryRunner.query(`
      ALTER TABLE home_member
        ADD CONSTRAINT uq_home_member UNIQUE (home_id, user_id)
    `);
    await queryRunner.query(
      `CREATE INDEX idx_home_member_user ON home_member(user_id)`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_user_single_titular ON home_member(user_id)
        WHERE role = 'TITULAR'
    `);

    await queryRunner.query(
      `ALTER TABLE home ALTER COLUMN longitude DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE home ALTER COLUMN latitude DROP NOT NULL`,
    );

    // `name` no se puede recuperar: se fue con el DROP COLUMN. Se repuebla
    // desde la dirección, que es lo más honesto que se puede hacer al bajar.
    await queryRunner.query(`ALTER TABLE home ADD COLUMN name TEXT`);
    await queryRunner.query(`UPDATE home SET name = address`);
    await queryRunner.query(`ALTER TABLE home ALTER COLUMN name SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE home ALTER COLUMN address DROP NOT NULL`,
    );
  }
}
