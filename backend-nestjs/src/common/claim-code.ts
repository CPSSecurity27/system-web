import { randomBytes } from 'node:crypto';

/**
 * El código de un solo uso con el que algo entra al stock de un cliente.
 *
 * Vive en común porque lo usan la alarma y el control remoto, y tiene que ser el
 * MISMO alfabeto en los dos: quien dicta un código por teléfono no debería tener
 * que preguntar de qué familia es antes de saber si ese redondel es un cero o
 * una o.
 *
 * Sin `0/O` ni `1/I` por eso mismo, y 6 caracteres: suficiente al lado del
 * serial —que también hay que saber— y corto para tipearlo de una etiqueta de
 * 40 × 20 mm.
 *
 * `randomBytes` y no `Math.random`: es lo que demuestra que el equipo está
 * físicamente en tus manos, así que adivinable no sirve.
 */
export function generarClaimCode(): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  return [...bytes].map((b) => alfabeto[b % alfabeto.length]).join('');
}
