import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Código de reclamo del control remoto (2026-08-05).
 *
 * El control pasa a tener el mismo mecanismo que la alarma para entrar al stock
 * de un cliente por su cuenta: un código de un solo uso impreso en la etiqueta.
 * Con eso, la muni que recibe la bolsa carga serial + código y los controles
 * pasan a su inventario, sin depender de que CPS despache el lote.
 *
 * ## Por qué un código y no el serial solo
 *
 * El serial está impreso, a la vista, y viaja en cada listado. Si alcanzara para
 * reclamar un control, cualquiera que vea una etiqueta —o que adivine el
 * correlativo del vecino— podría pasarlo a su stock. El código es el secreto que
 * demuestra que el control está físicamente en tus manos.
 *
 * Es el mismo razonamiento que en `device.claim_code`, y el mismo alfabeto: 6
 * caracteres sin `0/O` ni `1/I`, porque esto se dicta por teléfono y se tipea de
 * una etiqueta chica.
 *
 * ## Consecuencia asumida: cambia la etiqueta
 *
 * El código tiene que estar impreso, así que entra en la etiqueta de 40 × 20 mm
 * —escrito y en el QR— que ya estaba cerrada. Se decidió sabiendo eso
 * (2026-08-05).
 *
 * ## Único parcial, no NOT NULL
 *
 * Los controles anteriores a la fábrica no tienen código y no se les puede
 * inventar uno: nadie imprimió nada. El índice parcial deja convivir a los dos
 * y garantiza que dos controles nunca compartan código.
 */
export class RemoteClaimCode1787700000000 implements MigrationInterface {
  name = 'RemoteClaimCode1787700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE remote ADD COLUMN claim_code TEXT`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_remote_claim_code ON remote(claim_code)
        WHERE claim_code IS NOT NULL
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN remote.claim_code IS
        'Código de UN SOLO USO para que un cliente sume el control a su stock. Impreso en la etiqueta. Se regenera al restaurar desde la papelera: el anterior quedó impreso en una etiqueta que puede andar dando vueltas.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_remote_claim_code`);
    await queryRunner.query(`ALTER TABLE remote DROP COLUMN claim_code`);
  }
}
