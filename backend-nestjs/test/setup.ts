/**
 * Se corre ANTES de cargar cualquier módulo de Nest (ver jest-e2e.json).
 *
 * Apunta los tests a una base APARTE (`cps_security_test`): nunca tocan los datos
 * de desarrollo. Y apaga el SMTP, para que ningún test mande un mail de verdad.
 */
process.env.NODE_ENV = 'test';
process.env.DB_NAME = 'cps_security_test';

/**
 * Los tests corren como el usuario ADMIN, no como `cps_web`.
 *
 * `limpiar()` hace TRUNCATE entre corridas, y TRUNCATE pide ser DUEÑO de la
 * tabla: no alcanza con el DML que los GRANTs de un-solo-escritor le dan a
 * `cps_web` (§13 del SQL v2). Antes esto funcionaba de casualidad, porque la
 * base de tests la creaba `cps_web` y por eso era su dueño; desde que la crea
 * el admin (que es quien tiene DDL), las tablas son del admin.
 *
 * Lo que se pierde: los tests NO verifican los GRANTs de un-solo-escritor.
 * Eso se valida aparte, con `docs/roles-conexion-v2.sql` sobre la base real.
 */
if (process.env.DB_MIGRATIONS_USER) {
  process.env.DB_USER = process.env.DB_MIGRATIONS_USER;
  process.env.DB_PASSWORD = process.env.DB_MIGRATIONS_PASSWORD;
}

delete process.env.SMTP_HOST;
