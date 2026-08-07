/**
 * Errores de Postgres que hay que traducir a algo que se entienda.
 *
 * Vive en común porque lo necesitan los dos borrados definitivos —el del equipo
 * y el del control— y son exactamente el mismo caso: algo append-only que
 * referencia a lo que se quiere borrar.
 */

/**
 * ¿La operación chocó contra una clave foránea?
 *
 * **Son DOS códigos, no uno.** `23503` (`foreign_key_violation`) es el que
 * levanta un `ON DELETE NO ACTION`; un `ON DELETE RESTRICT` explícito —que es
 * justo lo que tienen `event.device_id` y `event.remote_id`— levanta `23001`,
 * `restrict_violation`. Mirando solo el primero, borrar algo con eventos se
 * escapaba como un 500 con el nombre de una constraint adentro en vez del
 * mensaje que explica qué pasó. Verificado contra la base.
 *
 * Se mira el código y no el mensaje porque el mensaje viene en el idioma del
 * servidor y cambia entre versiones; el código es parte del contrato de SQL.
 */
export function esViolacionDeClaveForanea(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === '23503' || code === '23001';
}
