import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Numeración correlativa de códigos RF (2026-08-05).
 *
 * La fábrica genera los códigos al azar, que es lo correcto para que no se
 * puedan adivinar. Pero al cargar una tanda a mano en la mesa de trabajo, seguir
 * la numeración del último es mucho más cómodo: se graban en orden y se
 * verifican de un vistazo. Esta secuencia es la que recuerda dónde se quedó.
 *
 * ## Por qué una secuencia y no `MAX(código)`
 *
 * **Porque no se puede consultar.** `remote_code` guarda el código cifrado con
 * IV aleatorio y su HMAC: los dos son opacos. Un `MAX` habría que calcularlo
 * descifrando la tabla entera en Node en cada fabricación — miles de operaciones
 * de AES para averiguar un número que la base puede llevar sola.
 *
 * ## Arranca en 100000 y no en 10000
 *
 * El piso del panel es 10.000 (`EE_CODE_MIN`), pero los códigos bajos son
 * justamente los que más chance tienen de chocar con un control genérico de otra
 * marca que ande dando vueltas por el barrio: son los que salen de fábrica en
 * los equipos sin programar. Arrancar en seis dígitos cuesta nada y saca del
 * medio esa vecindad.
 *
 * ## La secuencia puede quedar atrás, y no importa
 *
 * `nextval` no vuelve atrás si la transacción falla —es lo correcto: un número
 * quemado es mejor que uno repetido— y tampoco la mueven los códigos cargados
 * por otros caminos. Nada de eso rompe nada: el generador **saltea** los que ya
 * están tomados y el índice único sobre el HMAC es la garantía real.
 */
export class RemoteCodeSequence1787400000000 implements MigrationInterface {
  name = 'RemoteCodeSequence1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE remote_code_seq START 100000`);
    await queryRunner.query(`
      COMMENT ON SEQUENCE remote_code_seq IS
        'Dónde se quedó la numeración correlativa de códigos RF. No se puede sacar de la tabla: los códigos están cifrados con IV aleatorio. Puede quedar atrás sin consecuencias — el generador saltea los tomados y el UNIQUE sobre code_hmac es la garantía.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE IF EXISTS remote_code_seq`);
  }
}
