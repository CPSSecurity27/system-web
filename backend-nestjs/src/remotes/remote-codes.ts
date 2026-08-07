import { randomInt } from 'node:crypto';

/**
 * Los códigos RF: qué números acepta el panel y cómo se generan.
 *
 * Los límites son del FIRMWARE (`components/eeprom_ext/eeprom_store.h`), no
 * nuestros. Un código fuera de rango no vuelve como error: el panel lo rechaza
 * al guardar el lote, o peor, lo guarda y nunca coincide con lo que transmite el
 * control. Igual que con la configuración, validar acá es la única forma de que
 * el error se vea.
 */

/** `EE_CODE_MIN`: 5 dígitos. Debajo de eso no es una trama de control. */
export const CODE_MIN = 10_000;

/** `EE_CODE_MAX`: 12 dígitos. Entra en el double de cJSON sin perder precisión. */
export const CODE_MAX = 999_999_999_999;

/** Cuántos códigos registra el panel por vecino (`MQTT_RF_CODES_PER_CLI`). */
export const MAX_CODIGOS = 4;

/**
 * Qué hace cada posición. NO es el orden en que se cargan: es qué botón es.
 *
 * Sale de `POS_TO_MODE` en `components/alarma_core/alarma_core.c`, que el
 * firmware llama "tabla ÚNICA del sistema". La posición 1 es el botón A y
 * dispara emergencia; la 4 es el botón D y APAGA — quien tenga ese código puede
 * callar la alarma del barrio.
 */
export const POSICIONES = [
  { position: 1, boton: 'A', modo: 'emergency', label: 'Emergencia' },
  { position: 2, boton: 'B', modo: 'suspicious', label: 'Sospechoso' },
  { position: 3, boton: 'C', modo: 'alert', label: 'Alerta' },
  { position: 4, boton: 'D', modo: 'off', label: 'Apagar' },
] as const;

/** Un código válido es un entero adentro del rango que el panel guarda. */
export function codigoValido(valor: unknown): valor is number {
  return (
    typeof valor === 'number' &&
    Number.isInteger(valor) &&
    valor >= CODE_MIN &&
    valor <= CODE_MAX
  );
}

export function errorDeCodigo(valor: unknown, posicion: number): string | null {
  if (codigoValido(valor)) return null;
  if (typeof valor !== 'number' || !Number.isInteger(valor)) {
    return `El código de la posición ${posicion} tiene que ser un número entero`;
  }
  return (
    `El código de la posición ${posicion} está fuera de lo que el equipo ` +
    `guarda (${CODE_MIN} a ${CODE_MAX})`
  );
}

/**
 * Un código al azar dentro del rango.
 *
 * `randomInt` de node:crypto y no `Math.random`: estos números son la única
 * credencial del control remoto —el panel no valida nada más que el número— así
 * que un generador predecible sería un control clonable a partir del serial del
 * vecino de al lado.
 *
 * La unicidad NO se resuelve acá: se resuelve con el índice único sobre el HMAC,
 * porque es lo único que también atrapa un choque contra un código cargado a
 * mano hace seis meses. Acá se sortea y el que colisiona se descarta.
 */
export function generarCodigo(): number {
  return randomInt(CODE_MIN, CODE_MAX + 1);
}
