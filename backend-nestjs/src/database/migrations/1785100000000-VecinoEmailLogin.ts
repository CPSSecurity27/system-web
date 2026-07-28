import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El vecino deja de entrar por DNI + OTP (SMS/WhatsApp es caro y no está
 * contratado). Pasa a registrarse con EMAIL y loguear con email o DNI +
 * contraseña — el mismo mecanismo que ya usa el panel.
 *
 * Cambios de esquema: `chk_user_login_identity` exigía
 * `username IS NOT NULL OR dni IS NOT NULL`. Un vecino ahora puede no tener
 * ninguno de los dos (si el titular no le cargó el DNI): agregamos
 * `OR email IS NOT NULL` para que la base siga garantizando que TODO usuario
 * tenga alguna identidad de login. De paso corregimos el COMMENT de
 * `password_hash` que quedó de InitialSchemaV2 (decía "DNI + OTP").
 *
 * No hace falta tocar `user_token_type`: la activación de cuenta reutiliza
 * PASSWORD_RESET (fijar la contraseña por primera vez es, para el modelo,
 * exactamente la misma operación que resetearla — ver auth.service.ts).
 */
export class VecinoEmailLogin1785100000000 implements MigrationInterface {
  name = 'VecinoEmailLogin1785100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE app_user DROP CONSTRAINT chk_user_login_identity
    `);
    await queryRunner.query(`
      ALTER TABLE app_user ADD CONSTRAINT chk_user_login_identity
        CHECK (username IS NOT NULL OR dni IS NOT NULL OR email IS NOT NULL)
    `);

    // El comentario original (InitialSchemaV2) decía "DNI + OTP": ese login
    // se descartó antes de implementarse, corregimos el registro en la base.
    await queryRunner.query(`
      COMMENT ON COLUMN app_user.password_hash IS
        'Hash argon2id. NULL para un vecino que todavía no activó su cuenta (se lo manda por mail al crearlo). La base nunca ve la clave en claro.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revertir puede fallar si ya existen vecinos con SOLO email: es
    // esperable (el down asume que se vuelve a un estado que esos datos ya
    // no respetan) y no distinto de cualquier otro rollback de un CHECK.
    await queryRunner.query(`
      ALTER TABLE app_user DROP CONSTRAINT chk_user_login_identity
    `);
    await queryRunner.query(`
      ALTER TABLE app_user ADD CONSTRAINT chk_user_login_identity
        CHECK (username IS NOT NULL OR dni IS NOT NULL)
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN app_user.password_hash IS
        'Hash argon2id. NULL para vecinos que entran solo con DNI + OTP. La base nunca ve la clave en claro.'
    `);
  }
}
