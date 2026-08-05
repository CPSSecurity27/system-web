import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GPS OBLIGATORIO al instalar una alarma (2026-08-05).
 *
 * Un poste sin punto en el mapa no se puede monitorear: el tablero ES un mapa, y
 * una alarma que no aparece en él es una alarma que nadie va a mirar cuando
 * suene. Cierra la última incoherencia del modelo — la VIVIENDA y el BARRIO ya
 * estaban obligados a tener coordenadas, y la alarma, que es la que dispara el
 * evento, no.
 *
 * ## Por qué un CHECK y no NOT NULL
 *
 * Las coordenadas solo tienen sentido cuando el equipo está INSTALADO. Uno en
 * inventario está en una caja: no tiene ubicación que declarar, y exigírsela
 * obligaría a inventar una. Es el mismo patrón de `chk_device_custody`, que
 * condiciona el barrio al estado.
 *
 * En la práctica "instalado" es lo mismo que "tiene barrio": el CHECK de
 * custodia ya impone que INVENTORY <=> sin barrio.
 */
export class DeviceGpsMandatory1787000000000 implements MigrationInterface {
  name = 'DeviceGpsMandatory1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE device ADD CONSTRAINT chk_device_gps CHECK (
        status = 'INVENTORY'
        OR (latitude IS NOT NULL AND longitude IS NOT NULL)
      )
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN device.latitude IS
        'OBLIGATORIA en un equipo instalado (chk_device_gps): el tablero es un mapa y una alarma sin punto no se monitorea. En inventario va NULL: el equipo está en una caja.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE device DROP CONSTRAINT chk_device_gps`,
    );
  }
}
