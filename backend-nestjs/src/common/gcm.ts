import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM: el formato de cifrado del proyecto, en un solo lugar.
 *
 * Hay dos cosas cifradas en el sistema y no tienen nada que ver entre sí —los
 * códigos RF de los controles y las passwords del portal local de los equipos—,
 * pero comparten el formato a propósito. El de los equipos lo escribe el
 * PROVISIONER, que está en otro repo y en otro lenguaje
 * (`gateway-to-device/src/gtd/provisioner/cifrado.py`): si el layout de los
 * campos vive escrito en tres lados, se desincroniza, y la divergencia se
 * manifiesta como "el descifrado falla" sin decir por qué.
 *
 * Formato: `iv (12) || authTag (16) || ciphertext`.
 *
 * GCM y no CBC porque es cifrado AUTENTICADO: si alguien altera un byte en la
 * base, el descifrado TIRA en vez de devolver basura silenciosamente. Para una
 * password que se va a imprimir en una etiqueta, eso es la diferencia entre un
 * error y una etiqueta con seis caracteres al azar.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recomendado para GCM
const AUTH_TAG_LENGTH = 16;
export const KEY_LENGTH = 32; // AES-256

/**
 * Valida una clave de entorno en base64. Se llama al ARRANCAR y no al primer
 * uso: una clave corta es un agujero silencioso, y así es imposible que el
 * sistema levante mal configurado.
 */
export function loadKey(raw: string, envVar: string): Buffer {
  const key = Buffer.from(raw, 'base64');

  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `${envVar} debe ser de ${KEY_LENGTH} bytes en base64 (son ${key.length}). ` +
        `Generá una con: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  return key;
}

/** El IV es RANDOM por cada cifrado: reusarlo en GCM rompe el esquema entero. */
export function seal(key: Buffer, plain: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);

  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Tira si el ciphertext o el authTag fueron alterados. Es el punto de GCM. */
export function open(key: Buffer, payload: Buffer): string {
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}
