import { createHmac, timingSafeEqual } from 'node:crypto';
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

  /**
   * Huella determinística del código, para poder tener un UNIQUE.
   *
   * `encrypt` usa IV aleatorio —como corresponde— y por eso el mismo código
   * cifrado dos veces da bytes distintos: sobre esa columna no hay índice único
   * posible. Esta es la otra mitad: misma entrada, misma salida, siempre.
   *
   * Va con CLAVE (HMAC) y no un `sha256` a secas porque el espacio de entrada es
   * chico —los códigos van de 5 a 12 dígitos, `EE_CODE_MIN`/`EE_CODE_MAX` del
   * firmware— y un hash sin clave sobre eso se invierte con un diccionario. Con
   * la clave, la columna no dice nada de los códigos aunque se filtre la base.
   *
   * Reusa `REMOTE_CODES_KEY`: son el mismo secreto protegiendo el mismo dato, y
   * separarlas obligaría a rotar dos claves para lo mismo.
   */
  fingerprint(plain: string): Buffer {
    return createHmac('sha256', this.key).update(plain, 'utf8').digest();
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
