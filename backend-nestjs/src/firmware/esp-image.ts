/**
 * Lectura del descriptor que ESP-IDF embebe en toda imagen de aplicación.
 *
 * Sirve para una cosa concreta: **atajar en la subida lo que si no se descubre
 * después de que 40 postes bajaron 1,2 MB al pedo**. El equipo verifica el
 * proyecto recién cuando terminó de escribir la flash
 * (`ota_writer_verify_same_project`), y un binario de otro proyecto muere ahí,
 * en el poste, sin que nadie se entere hasta mirar la telemetría.
 *
 * ## El layout
 *
 * ```
 *   0x00  esp_image_header_t         24 bytes, arranca con el magic 0xE9
 *   0x18  esp_image_segment_header_t  8 bytes
 *   0x20  esp_app_desc_t            256 bytes, magic 0xABCD5432
 * ```
 *
 * Y adentro del descriptor (offsets relativos a 0x20):
 *
 * ```
 *   +0    magic_word      uint32
 *   +4    secure_version  uint32   (anti-rollback por eFuse; hoy 0)
 *   +16   version         char[32]
 *   +48   project_name    char[32]
 *   +80   time            char[16]
 *   +96   date            char[16]
 *   +112  idf_ver         char[32]
 * ```
 *
 * ## Ojo con `version`: HOY NO SIRVE, y no es un bug nuestro
 *
 * Verificado contra el binario real del taller
 * (`build/AlarmaESP32V6_05-03-2026.bin`, 2026-08-06):
 *
 * ```
 *   project_name = "AlarmaESP32V6_05-03-2026"   ← confiable
 *   version      = "f1a0459-dirty"              ← el git describe
 * ```
 *
 * El `CMakeLists.txt` del firmware no define `PROJECT_VER`, así que ESP-IDF cae
 * al `git describe` del repo. O sea que el binario **no sabe** que es la
 * `new_0_6_0`: eso vive en un `#define FW_VERSION` de `system_config.h`, que es
 * otra cosa y no viaja en la imagen.
 *
 * Por eso la versión del catálogo la escribe una persona. Lo que sí devolvemos
 * es el `version` crudo del binario junto con la fecha de compilación: es lo que
 * permite mirar dos `.bin` parecidos y saber si son el mismo build.
 *
 * (La propuesta para el repo del firmware —una línea de `PROJECT_VER`— está en
 * `docs/propuestas-firmware-ota.md`. El día que exista, esto se puede exigir.)
 */

/** `esp_image_header_t.magic`. Toda imagen de app arranca con esto. */
const IMAGE_MAGIC = 0xe9;

/** `ESP_APP_DESC_MAGIC_WORD`. */
const DESC_MAGIC = 0xabcd5432;

/** Dónde arranca el `esp_app_desc_t`: 24 del header + 8 del primer segmento. */
const DESC_OFFSET = 0x20;

const DESC_SIZE = 256;

export interface EspAppDesc {
  /** El nombre del proyecto. Es lo que el equipo compara antes de activar. */
  projectName: string;
  /**
   * Lo que el build embebió como versión. Hoy es el `git describe` del firmware
   * (`f1a0459-dirty`), NO la versión OTA. No usarlo para nombrar nada.
   */
  buildVersion: string;
  /** `Aug  6 2026 02:23:21`, armado con las dos mitades del descriptor. */
  builtAt: string;
  /** `v5.5.3`. */
  idfVersion: string;
  /** Anti-rollback por eFuse. Hoy siempre 0; queda por si algún día se usa. */
  secureVersion: number;
}

export class EspImageError extends Error {}

/** Un `char[n]` del descriptor: ASCII hasta el primer NUL. */
function leerTexto(buf: Buffer, offset: number, largo: number): string {
  const crudo = buf.subarray(
    DESC_OFFSET + offset,
    DESC_OFFSET + offset + largo,
  );
  const fin = crudo.indexOf(0);
  return crudo.subarray(0, fin === -1 ? largo : fin).toString('latin1');
}

/**
 * Lee el descriptor. Tira `EspImageError` con un mensaje que se le puede mostrar
 * a quien está subiendo el archivo — el caso típico no es un binario corrupto,
 * es haber arrastrado el `.elf`, el `bootloader.bin` o un `.zip`.
 */
export function leerDescriptorEsp(buf: Buffer): EspAppDesc {
  if (buf.length < DESC_OFFSET + DESC_SIZE) {
    throw new EspImageError(
      'El archivo es demasiado chico para ser un firmware del equipo',
    );
  }

  if (buf[0] !== IMAGE_MAGIC) {
    throw new EspImageError(
      'Esto no es una imagen de ESP32: no empieza con el magic 0xE9. ' +
        '¿Subiste el .elf o el .zip en vez del .bin?',
    );
  }

  if (buf.readUInt32LE(DESC_OFFSET) !== DESC_MAGIC) {
    throw new EspImageError(
      'La imagen no trae el descriptor de aplicación. El bootloader y la ' +
        'tabla de particiones no se actualizan por OTA: subí el .bin de la app.',
    );
  }

  const projectName = leerTexto(buf, 48, 32);
  if (projectName.length === 0) {
    throw new EspImageError('La imagen no declara nombre de proyecto');
  }

  const fecha = leerTexto(buf, 96, 16);
  const hora = leerTexto(buf, 80, 16);

  return {
    projectName,
    buildVersion: leerTexto(buf, 16, 32),
    builtAt: [fecha, hora].filter((p) => p.length > 0).join(' '),
    idfVersion: leerTexto(buf, 112, 32),
    secureVersion: buf.readUInt32LE(DESC_OFFSET + 4),
  };
}
