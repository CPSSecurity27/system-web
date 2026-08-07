import { CODE_MAX, CODE_MIN, MAX_CODIGOS } from './remote-codes';

/**
 * Sincronizar la base RF: qué se puede cargar en un panel y cómo se trocea.
 *
 * Todo lo de acá sale del firmware, no de nuestras ganas
 * (`components/eeprom_ext/eeprom_store.h`, `components/mqtt_av/mqtt_parse.*`).
 * Está aparte del servicio porque son las reglas que hay que poder leer de un
 * saque —y probar sin base— cuando algo no entra en un equipo.
 */

/** `EE_SAVE_BATCH_MAX`: cada alta barre la EEPROM (~0,45 s), 5 son ~2,25 s. */
export const CLIENTES_POR_LOTE = 5;

/** `EE_MAX_CAPACITY`: el journal_idx es 1 byte y 0xFF significa "ninguno". */
export const CAPACIDAD_TOPE = 254;

/** `EE_DNI_MIN` / `EE_DNI_MAX`: 8 dígitos, que es lo que entra en el uint32. */
export const DNI_MIN = 1;
export const DNI_MAX = 99_999_999;

/** `MQTT_IN_PAYLOAD_MAX`: lo que pasa de acá el panel lo descarta EN SILENCIO. */
export const PAYLOAD_MAX_BYTES = 1024;

/**
 * Cuántos vecinos entran en el chip.
 *
 * `kb` son KILOBYTES, no kilobits, y viene en la telemetría
 * (`modulos.eeprom.kb`). El firmware lo arma como `size_bytes / 1024`
 * (`mqtt_payload.c`), así que un AT24C32 —4096 bytes— reporta **4**, no 32. El
 * ejemplo de `mqtt_design.md` dice `"kb":32` y contradice al propio código del
 * panel: manda el código.
 *
 * Leerlo como kilobits daba 512 bytes para el chip real y un techo de 14
 * vecinos: los paneles del Barrio Docente marcaban 11 controles como `NO_ENTRA`
 * con la EEPROM casi vacía.
 *
 * Cada registro ocupa una página de 32 bytes y las dos primeras son del header
 * y el scratch del journal.
 *
 * Sin telemetría se asume el chip MÁS CHICO soportado (`EEPROM_SIZE_MIN` = 4 KB,
 * el AT24C32): equivocarse para abajo hace que sobre lugar, equivocarse para
 * arriba hace que el equipo devuelva `EE_FULL` a mitad de una tanda.
 */
export function capacidadDeRegistros(kb: number | null | undefined): number {
  const bytes = (kb && kb > 0 ? kb : 4) * 1024;
  return Math.min(CAPACIDAD_TOPE, Math.floor(bytes / 32) - 2);
}

/**
 * El MISMO FNV-1a que `rf_client_hash()` en `task_mqtt.c`.
 *
 * Guardarlo al sincronizar sirve para dos cosas: saber si los códigos de un
 * control cambiaron desde que se cargaron, y —el día que usemos `op:"audit"`—
 * comparar contra lo que reporta el panel **sin descifrar nada**.
 *
 * Detalles que importan y que hay que copiar tal cual: recorre las 4 posiciones
 * en orden, saltea las ausentes, mezcla el código byte por byte desde el menos
 * significativo (el `code` es de 64 bits) y después mezcla la POSICIÓN. Todo en
 * aritmética de 32 bits sin signo — de ahí `Math.imul` y el `>>> 0`.
 */
export function hashDeCodigos(
  codigos: { position: number; codigo: number }[],
): number {
  let h = 2166136261;
  for (let p = 0; p < MAX_CODIGOS; p++) {
    // La posición del panel es 0..3; la nuestra, 1..4.
    const codigo = codigos.find((c) => c.position === p + 1);
    if (!codigo) continue;

    let valor = BigInt(codigo.codigo);
    for (let by = 0; by < 8; by++) {
      h = Math.imul(h ^ Number(valor & 0xffn), 16777619);
      valor >>= 8n;
    }
    h = Math.imul(h ^ p, 16777619);
  }
  return h >>> 0;
}

/** Por qué un control NO se puede cargar. La pantalla lo muestra tal cual. */
export type MotivoSalteo =
  | 'SIN_PORTADOR'
  | 'DNI_INVALIDO'
  | 'SIN_CODIGOS'
  | 'POSICIONES_CON_HUECO'
  | 'CODIGO_FUERA_DE_RANGO'
  | 'NO_ENTRA';

export const EXPLICACION: Record<MotivoSalteo, string> = {
  SIN_PORTADOR:
    'No tiene portador. El equipo guarda los códigos POR PERSONA, así que un ' +
    'control sin nombre no tiene dónde entrar.',
  DNI_INVALIDO:
    'El DNI del portador no entra en el equipo: tiene que ser un número de ' +
    'hasta 8 dígitos.',
  SIN_CODIGOS: 'No tiene códigos cargados: no hay nada que mandar.',
  POSICIONES_CON_HUECO:
    'Le falta una posición del medio. El equipo llena los botones en orden ' +
    'desde el primero, así que un hueco correría los demás y el botón de ' +
    'emergencia terminaría haciendo otra cosa.',
  CODIGO_FUERA_DE_RANGO: `Alguno de sus códigos no está entre ${CODE_MIN} y ${CODE_MAX}, que es lo que el equipo guarda.`,
  NO_ENTRA: 'No hay lugar en la memoria del equipo.',
};

/** El DNI como lo quiere el panel, o null si no sirve. */
export function dniParaElPanel(dni: string | null | undefined): number | null {
  if (!dni) return null;
  const limpio = dni.replace(/\D/g, '');
  if (
    limpio === '' ||
    limpio.length !== dni.trim().replace(/[.\s]/g, '').length
  ) {
    return null;
  }
  const n = Number(limpio);
  return Number.isInteger(n) && n >= DNI_MIN && n <= DNI_MAX ? n : null;
}

/**
 * Qué le impide a este control entrar al panel, si algo se lo impide.
 *
 * El hueco de posición merece una nota: la posición NO es el orden de carga, es
 * QUÉ BOTÓN es (1 emergencia, 2 sospechoso, 3 alerta, 4 apagar). El `op:batch`
 * del firmware llena `code[0], code[1]…` en el orden del array, así que un
 * control con códigos en 1 y 3 llegaría con el de "alerta" en el botón de
 * "sospechoso". No hay forma de expresarlo: se saltea y se dice por qué.
 */
export function motivoDeSalteo(control: {
  dni: string | null;
  codigos: { position: number; codigo: number }[];
}): MotivoSalteo | null {
  if (control.dni === null) return 'SIN_PORTADOR';
  if (dniParaElPanel(control.dni) === null) return 'DNI_INVALIDO';
  if (control.codigos.length === 0) return 'SIN_CODIGOS';

  const posiciones = control.codigos
    .map((c) => c.position)
    .sort((a, b) => a - b);
  const contiguas = posiciones.every((p, i) => p === i + 1);
  if (!contiguas) return 'POSICIONES_CON_HUECO';

  const fuera = control.codigos.some(
    (c) =>
      !Number.isInteger(c.codigo) || c.codigo < CODE_MIN || c.codigo > CODE_MAX,
  );
  return fuera ? 'CODIGO_FUERA_DE_RANGO' : null;
}

/** Un vecino tal como lo espera el panel, con sus códigos en orden de botón. */
export interface ClienteDelPanel {
  remoteId: number;
  dni: number;
  hash: number;
  codigos: number[];
}

/** Un paso del plan: lo que se publica, y lo que nos guardamos aparte. */
export interface PasoDeSync {
  op: 'del' | 'batch';
  dni?: number;
  clientes?: { dni: number; codigos: number[] }[];
  meta: {
    dnis?: string[];
    remotes?: { id: number; dni: string; hash: number }[];
  };
}

/**
 * El plan: primero las bajas, después las altas de a 5.
 *
 * **Las bajas van primero y no es un detalle de orden.** `op:batch` es un alta
 * PURA: si el DNI ya existe —o si alguno de los códigos ya es de otro— devuelve
 * `EE_DUP` y aborta el lote entero. Un control que cambió de portador tiene que
 * ver borrado su registro viejo antes de que entre el nuevo, o choca contra sus
 * propios códigos.
 */
export function armarPasos(
  bajas: string[],
  altas: ClienteDelPanel[],
): PasoDeSync[] {
  const pasos: PasoDeSync[] = bajas.map((dni) => ({
    op: 'del',
    dni: Number(dni.replace(/\D/g, '')),
    meta: { dnis: [dni] },
  }));

  for (let i = 0; i < altas.length; i += CLIENTES_POR_LOTE) {
    const lote = altas.slice(i, i + CLIENTES_POR_LOTE);
    pasos.push({
      op: 'batch',
      clientes: lote.map((c) => ({ dni: c.dni, codigos: c.codigos })),
      meta: {
        remotes: lote.map((c) => ({
          id: c.remoteId,
          dni: String(c.dni),
          hash: c.hash,
        })),
      },
    });
  }

  return pasos;
}

/**
 * `ee_status` → castellano. Viene en el `det` del ack como "ee_status 6".
 *
 * Sin esto, la pantalla muestra un número que solo significa algo con el header
 * del firmware al lado. El orden es el del enum `ee_status_t`.
 */
const EE_STATUS: Record<number, string> = {
  1: 'ese DNI no está en el equipo',
  2: 'la memoria del equipo está llena',
  3: 'el equipo no permite esa operación por MQTT',
  4: 'falló la escritura en la memoria del equipo',
  5: 'el equipo rechazó los datos del lote',
  6: 'ese DNI, o alguno de sus códigos, ya estaba en el equipo',
  7: 'la memoria del equipo todavía no está lista',
  8: 'la memoria del equipo no respondió a tiempo',
};

export function explicarDetalle(det: string | null): string | null {
  if (!det) return null;
  const m = /ee_status (\d+)/.exec(det);
  if (!m) return det;
  const texto = EE_STATUS[Number(m[1])];
  return texto ? `${texto} (${det})` : det;
}
