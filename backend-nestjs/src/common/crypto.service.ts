import { timingSafeEqual } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { loadKey, open, seal } from './gcm';

/**
 * Cifrado de los códigos RF de los controles remotos.
 *
 * El algoritmo y el formato viven en `gcm.ts`, compartidos con las credenciales
 * del portal de los equipos. Lo propio de este servicio es la CLAVE: los códigos
 * RF y las passwords de los equipos son secretos de distinta naturaleza y no
 * tienen por qué caer juntos.
 *
 * La clave vive en REMOTE_CODES_KEY (env), no en la base: si te roban un dump de
 * Postgres, los códigos no sirven para nada.
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private key!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.key = loadKey(
      this.config.getOrThrow<string>('REMOTE_CODES_KEY'),
      'REMOTE_CODES_KEY',
    );
  }

  encrypt(plain: string): Buffer {
    return seal(this.key, plain);
  }

  decrypt(payload: Buffer): string {
    return open(this.key, payload);
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
