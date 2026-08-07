import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El catálogo de firmwares para el OTA (2026-08-06).
 *
 * Hasta hoy el OTA existía a medias: el firmware sabe bajar e instalar, el
 * backend sabe mandar `cmd t:ota`, y en el medio no había NADA — ningún lugar
 * de donde salgan los `.bin`, ninguna forma de saber cuál es la última. La URL
 * se escribía a mano en un input y el origen automático apuntaba a un 404
 * (verificado el 2026-08-06 contra el servidor real).
 *
 * ## Dos tablas y por qué son dos
 *
 * `firmware_release` es el ARCHIVO: una fila por `.bin` subido, con lo que el
 * manifiesto necesita declarar. Es append-mostly y no se pisa.
 *
 * `firmware_channel` es el PUNTERO: qué versión está publicada en cada una de
 * las dos bases fijas que el firmware tiene hardcodeadas. Es una tabla de dos
 * filas como mucho, y por eso la ranura es la PK: publicar es un UPSERT y no
 * puede haber dos versiones peleando por la misma ranura.
 *
 * Podrían haber sido dos booleanos en `firmware_release`, pero entonces "una
 * sola publicada por ranura" sería un índice único parcial que hay que
 * acordarse de escribir, y "quién la publicó y cuándo" no tendría dónde vivir.
 *
 * ## Las dos ranuras NO son lo mismo
 *
 *   new       → `https://cpssecurity.com.ar/firmware/alarmavecinal/ota/new/`
 *               Lo que baja un `cmd t:ota` con `fuente: "auto"`. Es la última
 *               que queremos desplegar.
 *
 *   emergency → `.../ota/emergency/` con el nombre FIJO `emergency.bin`.
 *               Lo que el equipo baja SOLO, sin que nadie se lo pida, cuando
 *               decide que está roto (`emergency_mode`, bandera NVS + B1-EMG).
 *
 * La de emergencia es el ÚLTIMO BUENO CONOCIDO, no la última. Si se publica ahí
 * la misma versión de la que el equipo está tratando de escapar, el mecanismo
 * deja de existir: bajaría el firmware roto para recuperarse del firmware roto.
 * Por eso son dos acciones distintas en la pantalla y no un checkbox.
 *
 * ## Por qué el host es el apex y no `system.`
 *
 * `ota_url_is_allowed()` compara contra `OTA_ALLOWED_HOST`, que es
 * `SERVER_HOST` = `cpssecurity.com.ar` (`components/ota_engine/ota_config.h`).
 * Host EXACTO: servir los `.bin` desde `system.cpssecurity.com.ar` los haría
 * rechazar antes de bajar un solo byte. Los dos dominios viven en la misma
 * Raspberry, así que es un `location /firmware/` en el server block del apex.
 *
 * ## `version` es un identificador, no un número de orden
 *
 * El firmware NO compara versiones: baja lo que se le diga, aunque sea la misma
 * o una anterior ("el servidor decide", `docs/ota_design.md §1`). Acá `version`
 * es UNIQUE porque es el nombre del archivo y de la carpeta, no porque sirva
 * para ordenar. Un `stable_0_7_0` y un `new_0_7_0` son dos releases distintos y
 * conviven.
 *
 * ## Nada de esto es estado vivo
 *
 * Las dos tablas son de la web y las escribe la web: no hay que revocarle nada
 * a `cps_web` (la regla del un-solo-escritor aplica a `device_state`, que sigue
 * siendo del servicio de alarmas). El `.bin` en sí NO va a la base: vive en el
 * disco, servido por nginx, y acá queda su ficha.
 */
export class FirmwareCatalog1788200000000 implements MigrationInterface {
  name = 'FirmwareCatalog1788200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE firmware_release (
        id           SERIAL PRIMARY KEY,
        -- Tal cual va al manifiesto y al nombre del archivo: el equipo arma la
        -- URL como base + version + ".bin". No se tipea: se LEE del binario
        -- (esp_app_desc_t), así que un .bin no puede quedar mal etiquetado.
        version      TEXT NOT NULL UNIQUE,
        -- Del prefijo de la versión. El firmware lo trata como registro y NUNCA
        -- bloquea por canal (ota_design §1); acá sirve para que en la pantalla
        -- se vea de un vistazo qué es experimental.
        channel      TEXT NOT NULL,
        -- Tiene que coincidir con OTA_HW_MODEL del equipo o el manifiesto se
        -- rechaza (OTA_REJ_HW_MISMATCH). Hoy hay un solo modelo; es una columna
        -- y no una constante porque el día que haya placas de 8 MB conviven.
        hw_model     TEXT NOT NULL DEFAULT 'esp32-4mb',
        -- El equipo verifica que el binario sea del MISMO proyecto antes de
        -- marcarlo booteable (ota_writer_verify_same_project). Guardarlo acá
        -- permite atajar en la subida lo que si no se descubre después de bajar
        -- 1,15 MB al pedo.
        project_name TEXT NOT NULL,
        size_bytes   INT  NOT NULL,
        -- 64 hex. El equipo lo compara contra lo que escribió en flash ANTES de
        -- marcar la partición como booteable.
        sha256       TEXT NOT NULL,
        -- Qué trae esta versión, en castellano. Lo escribe quien la sube.
        notes        TEXT,
        uploaded_by  INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT chk_firmware_channel CHECK (channel IN ('new', 'stable')),
        CONSTRAINT chk_firmware_sha CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        -- El slot OTA de la partición de 4 MB es de 1,75 MB. Un binario más
        -- grande lo rechaza el equipo (OTA_REJ_SIZE_EXCEEDS_SLOT) después de
        -- bajar el manifiesto; atajarlo acá es no publicar algo inservible.
        CONSTRAINT chk_firmware_size CHECK (size_bytes > 0 AND size_bytes <= 1835008)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE firmware_channel (
        -- La ranura ES la clave: hay exactamente una versión publicada en cada
        -- una de las dos bases fijas del firmware.
        slot       TEXT PRIMARY KEY,
        -- RESTRICT y no CASCADE: borrar una versión que está publicada tiene
        -- que fallar y decirlo, no dejar la carpeta del servidor apuntando a un
        -- archivo que ya no está en el catálogo.
        release_id INT NOT NULL REFERENCES firmware_release(id) ON DELETE RESTRICT,
        updated_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT chk_firmware_slot CHECK (slot IN ('new', 'emergency'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_firmware_release_created
        ON firmware_release(created_at DESC)
    `);

    await queryRunner.query(`
      COMMENT ON TABLE firmware_release IS
        'Catálogo de firmwares subidos. El .bin vive en disco (FIRMWARE_ROOT), servido por nginx desde el apex; acá está su ficha y lo que declara el manifiesto.'
    `);
    await queryRunner.query(`
      COMMENT ON TABLE firmware_channel IS
        'Qué versión está publicada en cada base fija del firmware. new = la que baja un cmd t:ota auto; emergency = el último bueno conocido que el equipo baja SOLO al entrar en emergency_mode.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS firmware_channel`);
    await queryRunner.query(`DROP TABLE IF EXISTS firmware_release`);
  }
}
