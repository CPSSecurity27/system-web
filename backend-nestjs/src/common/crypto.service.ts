import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recomendado para GCM
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256

/**
 * Cifrado de los códigos RF de los controles remotos.
 *
 * AES-256-GCM y no AES-CBC: GCM es cifrado AUTENTICADO. No solo oculta el
 * contenido, sino que detecta si alguien lo modificó — si un byte del ciphertext
 * cambia, el descifrado FALLA en vez de devolver basura silenciosamente. Para
 * códigos que abren una alarma, eso importa.
 *
 * Formato guardado: iv (12) || authTag (16) || ciphertext.
 * El IV es RANDOM por cada cifrado: reusar un IV en GCM rompe el esquema entero.
 *
 * La clave vive en REMOTE_CODES_KEY (env), no en la base: si te roban un dump de
 * Postgres, los códigos no sirven para nada.
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private key!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const raw = this.config.getOrThrow<string>('REMOTE_CODES_KEY');
    const key = Buffer.from(raw, 'base64');

    // Se falla AL ARRANCAR y no al primer código: una clave corta es un agujero
    // silencioso, y con esto es imposible que el sistema levante mal configurado.
    if (key.length !== KEY_LENGTH) {
      throw new Error(
        `REMOTE_CODES_KEY debe ser de ${KEY_LENGTH} bytes en base64 (son ${key.length}). ` +
          `Generá una con: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }

    this.key = key;
  }

  encrypt(plain: string): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);

    const ciphertext = Buffer.concat([
      cipher.update(plain, 'utf8'),
      cipher.final(),
    ]);

    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload: Buffer): string {
    const iv = payload.subarray(0, IV_LENGTH);
    const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);

    // Si el ciphertext o el authTag fueron alterados, final() TIRA. Es la
    // garantía de integridad de GCM: no devuelve datos corruptos como si nada.
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Comparación en tiempo constante, para no filtrar información por timing. */
  matches(payload: Buffer, plain: string): boolean {
    try {
      const actual = Buffer.from(this.decrypt(payload), 'utf8');
      const expected = Buffer.from(plain, 'utf8');
      if (actual.length !== expected.length) return false;
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
}
