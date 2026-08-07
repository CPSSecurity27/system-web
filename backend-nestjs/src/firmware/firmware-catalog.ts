import { FirmwareSlot } from './entities/firmware-channel.entity';

/**
 * Las reglas del catálogo: cómo se llama una versión, dónde vive y qué dice su
 * manifiesto. Todo esto lo fija el firmware, no nosotros.
 */

/** `OTA_HW_MODEL` de `ota_engine/ota_config.h`. Distinto → `OTA_REJ_HW_MISMATCH`. */
export const HW_MODEL = 'esp32-4mb';

/** `OTA_MANIFEST_FORMAT_SUPPORTED`. Mayor a esto, el equipo rechaza. */
export const MANIFEST_FORMAT = 1;

/** El slot OTA de la partición de 4 MB: 1,75 MB. */
export const MAX_BIN_BYTES = 1_835_008;

/** `OTA_BIN_EMERGENCY`: el nombre es FIJO en la base de emergencia. */
export const BIN_EMERGENCY = 'emergency.bin';

/**
 * El host de la allowlist (`OTA_ALLOWED_HOST` = `SERVER_HOST`).
 *
 * Es el APEX, no `system.`: `ota_url_is_allowed()` compara el host EXACTO, así
 * que un `.bin` servido desde el panel se rechaza antes de bajar un solo byte.
 */
export const OTA_HOST = 'cpssecurity.com.ar';

/** La raíz pública, bajo la que nginx sirve `FIRMWARE_ROOT`. */
export const OTA_PATH_BASE = '/firmware/alarmavecinal/ota';

/**
 * `<canal>_<X>_<Y>_<Z>` con guión bajo, como manda `ota_design.md §1`.
 *
 * El prefijo distingue experimental de estable y **nunca bloquea**: es registro.
 * Los números tampoco ordenan nada — el equipo no compara versiones, baja lo que
 * se le diga. Acá el formato se exige para que la carpeta y el archivo tengan un
 * nombre previsible, no para deducir cuál es más nueva.
 */
export const VERSION_RE = /^(new|stable)_\d{1,3}_\d{1,3}_\d{1,3}$/;

/** `OTA_VERSION_MAXLEN` es 40 contando el NUL. */
export const MAX_VERSION_CHARS = 39;

export function validarVersion(version: string): string[] {
  const errores: string[] = [];
  if (!VERSION_RE.test(version)) {
    errores.push(
      'La versión tiene que ser "new_X_Y_Z" o "stable_X_Y_Z" ' +
        '(con guiones bajos, como new_0_7_0)',
    );
  }
  if (version.length > MAX_VERSION_CHARS) {
    errores.push(
      `La versión no puede pasar de ${MAX_VERSION_CHARS} caracteres`,
    );
  }
  return errores;
}

/** El canal sale del prefijo: no es un campo aparte que se pueda contradecir. */
export function canalDeVersion(version: string): 'new' | 'stable' {
  return version.startsWith('stable_') ? 'stable' : 'new';
}

/**
 * Dónde vive cada release en el disco, relativo a `FIRMWARE_ROOT`.
 *
 * Una carpeta por versión completa (`new_0_7_0/`) y no por número pelado
 * (`0_7_0/`, como sugiere la nota de convención del firmware): con el número
 * pelado, `new_0_7_0` y `stable_0_7_0` caerían en la misma carpeta y una
 * pisaría a la otra. El equipo acepta cualquier base bajo el host, así que la
 * carpeta más larga no cuesta nada.
 */
export function carpetaDeVersion(version: string): string {
  return `alarmavecinal/ota/${version}`;
}

/** Las dos bases que el firmware tiene HARDCODEADAS. No se pueden mover. */
export function carpetaDeRanura(slot: FirmwareSlot): string {
  return `alarmavecinal/ota/${slot}`;
}

/**
 * La URL que ve el equipo. Termina en `/` por convención: `ota_build_url()`
 * inserta el separador si falta, así que no es obligatorio — pero es la forma
 * en que están escritas las dos bases hardcodeadas del firmware, y una base
 * copiada de acá tiene que poder pegarse tal cual en el campo de URL manual.
 */
export function urlDeCarpeta(carpetaRelativa: string): string {
  return `https://${OTA_HOST}/firmware/${carpetaRelativa}/`;
}

/**
 * El manifiesto v1, tal cual lo parsea `ota_manifest.c`.
 *
 * Los campos son todos obligatorios y el orden de validación del equipo es:
 * JSON → formato → hw → version → size → sha.
 */
export interface ManifiestoOta {
  manifest_format: number;
  hw_model: string;
  update: {
    version: string;
    size_bytes: number;
    sha256: string;
  };
}

export function armarManifiesto(release: {
  version: string;
  hwModel: string;
  sizeBytes: number;
  sha256: string;
}): ManifiestoOta {
  return {
    manifest_format: MANIFEST_FORMAT,
    hw_model: release.hwModel,
    update: {
      version: release.version,
      size_bytes: release.sizeBytes,
      sha256: release.sha256,
    },
  };
}

/**
 * Cómo se llama el `.bin` dentro de cada carpeta.
 *
 * En la de emergencia el nombre es fijo porque el equipo NO lo arma desde el
 * manifiesto: en ese modo ya sabe que va a buscar `emergency.bin`
 * (`task_ota.c`). En el resto lo arma como `version + ".bin"`.
 */
export function nombreDelBin(version: string, slot?: FirmwareSlot): string {
  return slot === 'emergency' ? BIN_EMERGENCY : `${version}.bin`;
}
