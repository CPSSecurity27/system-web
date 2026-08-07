import { ACTUALIZAN_FIRMWARE } from '../devices/device-permissions';

/**
 * Quién maneja el catálogo de firmwares. **Solo CPS.**
 *
 * Un `.bin` publicado se instala en postes de todos los clientes: no es una
 * configuración que afecte a un barrio, es el software que corre la
 * infraestructura entera. Una organización recibe equipos, no los programa —
 * mismo criterio que la fábrica.
 *
 * Es literalmente la misma lista que la de mandar el OTA, y por eso es un alias
 * y no una copia: el día que una de las dos cambie, tiene que quedar claro que
 * la otra también. Vive allá porque `DeviceCommandsService` la necesita y
 * `firmware` ya importa a `devices`.
 */
export const GESTIONAN_FIRMWARE = ACTUALIZAN_FIRMWARE;
