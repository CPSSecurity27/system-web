/**
 * Se corre ANTES de cargar cualquier módulo de Nest (ver jest-e2e.json).
 *
 * Apunta los tests a una base APARTE (`cps_security_test`): nunca tocan los datos
 * de desarrollo. Y apaga el SMTP, para que ningún test mande un mail de verdad.
 */
process.env.NODE_ENV = 'test';
process.env.DB_NAME = 'cps_security_test';
delete process.env.SMTP_HOST;
