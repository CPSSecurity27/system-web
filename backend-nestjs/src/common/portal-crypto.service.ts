import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { loadKey, open } from './gcm';

/**
 * Descifra las credenciales del portal local de los equipos (usuarios `admin` y
 * `cps` de `http://192.168.4.1`).
 *
 * Es un servicio SOLO DE LECTURA a propósito: la web no cifra nada acá. Las
 * deriva y las cifra el PROVISIONER —el único proceso que tiene los salts de la
 * flota— y las escribe en `device.portal_*_enc` desde
 * `gtd.confirm_manufacture`. Si esta clase pudiera cifrar, existiría un camino
 * por el cual la web escribe una credencial que nunca llegó a ningún equipo.
 *
 * La clave `CPS_CRED_KEY` la comparte con el provisioner. Es lo ÚNICO de ese
 * lado que la web también tiene: los salts, jamás — con un salt se derivan las
 * credenciales de equipos que todavía no existen; con la clave, solo se leen las
 * de los equipos que ya están en esta base.
 *
 * Formato: base64 de `iv || authTag || ciphertext` (ver `gcm.ts`). Del lado
 * Python lo produce `gtd/provisioner/cifrado.py`.
 */
@Injectable()
export class PortalCryptoService implements OnModuleInit {
  private key!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.key = loadKey(
      this.config.getOrThrow<string>('CPS_CRED_KEY'),
      'CPS_CRED_KEY',
    );
  }

  /**
   * Devuelve `null` en vez de tirar cuando el blob no se puede leer.
   *
   * Un equipo con la credencial ilegible —clave rotada, fila alterada— sigue
   * siendo un equipo válido: se puede ver, editar e instalar. Lo único que no se
   * puede es imprimir su etiqueta, y eso lo resuelve re-fabricar. Tirar acá
   * rompería la ficha entera por un campo.
   */
  decrypt(blob: string | null): string | null {
    if (!blob) return null;
    try {
      return open(this.key, Buffer.from(blob, 'base64'));
    } catch {
      return null;
    }
  }
}
