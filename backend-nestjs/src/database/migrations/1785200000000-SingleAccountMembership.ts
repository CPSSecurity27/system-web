import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Decisión de negocio (2026-07-24): una persona pertenece a UNA sola cuenta
 * (CPS o una organización), nunca a varias a la vez. El caso "operador
 * compartido entre dos clientes" que el diseño original dejaba abierto no
 * se va a dar en la práctica y complicaba el padrón sin necesidad.
 *
 * `uq_account_user` (account_id, user_id) solo evitaba una membresía
 * DUPLICADA en la misma cuenta; no impedía pertenecer a varias. Se reemplaza
 * por UNIQUE(user_id): a lo sumo una fila de account_user por persona. El
 * índice idx_account_user_user queda redundante (el UNIQUE ya lo cubre) y se
 * borra. uq_account_user_id_account NO se toca: sigue habilitando la FK
 * compuesta de staff_assignment.
 */
export class SingleAccountMembership1785200000000 implements MigrationInterface {
  name = 'SingleAccountMembership1785200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE account_user DROP CONSTRAINT uq_account_user
    `);
    await queryRunner.query(`DROP INDEX idx_account_user_user`);
    await queryRunner.query(`
      ALTER TABLE account_user
        ADD CONSTRAINT uq_account_user_single_account UNIQUE (user_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revertir puede fallar si para entonces ya hay memberships múltiples
    // que dependan de la restricción nueva; es el mismo criterio que
    // VecinoEmailLogin: un down que asume datos compatibles con el estado viejo.
    await queryRunner.query(`
      ALTER TABLE account_user DROP CONSTRAINT uq_account_user_single_account
    `);
    await queryRunner.query(`
      CREATE INDEX idx_account_user_user ON account_user(user_id)
    `);
    await queryRunner.query(`
      ALTER TABLE account_user
        ADD CONSTRAINT uq_account_user UNIQUE (account_id, user_id)
    `);
  }
}
