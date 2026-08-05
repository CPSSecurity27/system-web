/**
 * El código corto del barrio: lo que viaja al equipo como `central.grupo`.
 *
 * El firmware trunca en 15 caracteres, así que "Barrio Parque Los Aromos" no
 * entra. El nombre largo se queda en la web y esto es lo que ve el panel.
 *
 * La columna nació con la migración `GtdBridgeSchema`, que rellenó los barrios
 * existentes con este mismo formato... pero NINGÚN camino de alta lo generaba
 * después. Crear un barrio —suelto o junto con su cliente— venía fallando con
 * "el valor nulo en la columna code viola la restricción not-null" desde
 * entonces. Por eso vive acá y no adentro de un servicio: son dos caminos y
 * tienen que producir exactamente lo mismo.
 *
 * Formato impuesto por la base: `^[A-Z0-9][A-Z0-9-]{0,14}$` y UNIQUE.
 */

/** Deja lugar para el sufijo `-N` de desempate sin pasarse de los 15. */
const LARGO_BASE = 11;

/**
 * Slug del nombre: mayúsculas, sin acentos, y todo lo que no sea A-Z0-9
 * convertido en guión.
 *
 * Devuelve `'B'` si el nombre no aporta ningún carácter usable (un barrio
 * llamado "..." es raro pero no puede tumbar el alta).
 */
export function slugDeBarrio(nombre: string): string {
  const base = nombre
    // Descompone los acentuados y borra las tildes: Ñ -> N, Á -> A.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LARGO_BASE)
    // El slice puede haber dejado un guión colgando al final.
    .replace(/-+$/g, '');

  return base || 'B';
}

/**
 * Un código libre para ese nombre.
 *
 * Prueba el slug pelado y, si ya está tomado, le agrega `-2`, `-3`… El sufijo
 * numérico es lo que evita que "Barrio Norte" en dos localidades choque, sin
 * perder legibilidad — un código que el técnico va a ver en la pantalla del
 * panel tiene que poder leerse.
 *
 * `existe` se pasa como función para que esto no conozca la base: así se prueba
 * sin levantar nada, y sirve igual adentro de una transacción o fuera.
 */
export async function codigoLibreDeBarrio(
  nombre: string,
  existe: (code: string) => Promise<boolean>,
): Promise<string> {
  const base = slugDeBarrio(nombre);

  if (!(await existe(base))) return base;

  // Hasta 999: con el slug en 11 caracteres, `-999` deja el total en 15 justos.
  for (let n = 2; n < 1000; n++) {
    const candidato = `${base}-${n}`;
    if (!(await existe(candidato))) return candidato;
  }

  // Mil barrios con el mismo nombre no es un caso real, pero fallar con un
  // mensaje claro es mejor que devolver un código repetido y que reviente el
  // UNIQUE con el nombre de una constraint.
  throw new Error(
    `No se pudo generar un código único para el barrio "${nombre}"`,
  );
}
