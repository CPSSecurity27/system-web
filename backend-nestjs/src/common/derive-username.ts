/**
 * Palabras que no aportan a un handle y solo lo alargan.
 *
 * NO se sacan los artículos (la/los/el/las): en los nombres de acá suelen ser
 * parte del nombre real — "Consorcio Los Álamos" se llama así, y borrarle el
 * "Los" lo desfigura. Solo se van las preposiciones y la conjunción.
 */
const PALABRAS_VACIAS = new Set(['de', 'del', 'y']);

/**
 * 30 y no 20: "municipalidad_san_pedro" ya son 23 caracteres, y ese es un
 * nombre corto para un cliente de este sistema.
 */
const LARGO_MAXIMO = 30;

/**
 * El username sugerido para el OWNER institucional, derivado del nombre de la
 * cuenta. Es una SUGERENCIA: quien carga el alta puede cambiarla, y el username
 * es único en todo el sistema (el 23505 se traduce a 409).
 *
 *   "Municipalidad de San Pedro"  ->  municipalidad_san_pedro
 *   "Consorcio Los Álamos"        ->  consorcio_los_alamos
 *
 * Puede devolver cadena vacía (un nombre de puro símbolo). El que llama decide
 * qué hacer con eso — acá no se inventa un relleno, porque un username
 * autogenerado sin relación con el nombre es peor que ninguno.
 */
export function deriveUsername(name: string): string {
  const sinAcentos = name
    .normalize('NFD')
    // Marcas diacríticas: la 'á' queda 'a' + tilde suelta, y se borra la tilde.
    .replace(/[̀-ͯ]/g, '');

  const palabras = sinAcentos
    .toLowerCase()
    // Todo lo que no sea letra o número separa palabras. Así la puntuación
    // desaparece sin pegar dos palabras que estaban separadas por un guión.
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length > 0 && !PALABRAS_VACIAS.has(p));

  const completo = palabras.join('_');

  if (completo.length <= LARGO_MAXIMO) {
    return completo;
  }

  // Recortar por PALABRA y no a la bruta: 'municipalidad_san_s' es peor que
  // 'municipalidad_san', y cortar en seco puede dejar un '_' colgando.
  const recortado: string[] = [];
  let largo = 0;
  for (const palabra of palabras) {
    const suma =
      recortado.length === 0 ? palabra.length : largo + 1 + palabra.length;
    if (suma > LARGO_MAXIMO) break;
    recortado.push(palabra);
    largo = suma;
  }

  // Una sola palabra más larga que el máximo: ahí sí se corta a la bruta.
  return recortado.length > 0
    ? recortado.join('_')
    : completo.slice(0, LARGO_MAXIMO);
}
