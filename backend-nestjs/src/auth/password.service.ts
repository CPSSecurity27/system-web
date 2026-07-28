import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { Injectable, OnModuleInit } from '@nestjs/common';

/**
 * argon2id. Único lugar del sistema donde se hashea o verifica una contraseña.
 * La base nunca ve el valor en claro.
 */
@Injectable()
export class PasswordService implements OnModuleInit {
  /**
   * Hash real de una contraseña aleatoria, calculado una vez al arrancar.
   * Sirve para que el login que falla por "usuario inexistente" gaste el MISMO
   * tiempo que el que falla por "contraseña mala": si no, el tiempo de
   * respuesta permite enumerar qué usernames existen.
   *
   * Tiene que ser un hash de verdad. Uno inventado a mano haría que verify()
   * tirara excepción al instante, que es exactamente la fuga que se quiere tapar.
   */
  private dummyHash!: string;

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(randomBytes(32).toString('hex'));
  }

  hash(plain: string): Promise<string> {
    return hash(plain);
  }

  async verify(passwordHash: string, plain: string): Promise<boolean> {
    try {
      return await verify(passwordHash, plain);
    } catch {
      // Un hash corrupto o de otro algoritmo no debe reventar el login: es "no".
      return false;
    }
  }

  /** Quema el mismo tiempo que un verify real, para un usuario que no existe. */
  async verifyDummy(plain: string): Promise<void> {
    await this.verify(this.dummyHash, plain);
  }
}
