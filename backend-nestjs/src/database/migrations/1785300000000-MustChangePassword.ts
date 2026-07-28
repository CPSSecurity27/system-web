import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alta institucional con clave temporal (2026-07-24, scope inicial: solo
 * INSTITUTIONAL). El admin de CPS que da de alta un OWNER institucional ya no
 * elige su contraseña: el sistema genera una clave temporal, la persona
 * la cambia en su primer login y desde ahí `must_change_password` vuelve a
 * false. Ver UsersService#create y AuthService#changePassword.
 */
export class MustChangePassword1785300000000 implements MigrationInterface {
  name = 'MustChangePassword1785300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE app_user
        ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE app_user DROP COLUMN must_change_password
    `);
  }
}
