-- ============================================================================
-- Roles de conexión v2 — "un solo escritor" impuesto por la BASE (§13 del esquema)
--
-- La web (backend NestJS) y el servicio de alarmas comparten SOLO esta base;
-- estos GRANTs hacen que la regla no dependa de la disciplina de nadie:
--   - cps_web     → todo, EXCEPTO escribir `device_state` y tocar lo append-only.
--   - cps_alarms  → lee configuración; escribe SOLO device_state/event/audit_log.
--
-- Uso (una vez por base, con el superusuario):
--   psql -U postgres -d cps_security_v2 -f docs/roles-conexion-v2.sql
--
-- Es idempotente: se puede correr de nuevo sin romper nada.
--
-- CLAVES DE DESARROLLO — en producción crear los roles a mano con claves reales
-- (el script no pisa la clave si el rol ya existe).
--
-- Las migraciones (DDL) NO corren con estos roles: siguen corriendo con el rol
-- admin (DB_MIGRATIONS_USER en el .env del backend; la app usa DB_USER=cps_web).
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_web') THEN
    CREATE ROLE cps_web LOGIN PASSWORD 'CpsWeb2026!';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_alarms') THEN
    CREATE ROLE cps_alarms LOGIN PASSWORD 'CpsAlarms2026!';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE cps_security_v2 TO cps_web, cps_alarms;
GRANT USAGE ON SCHEMA public TO cps_web, cps_alarms;

-- ----------------------------------------------------------------------------
-- cps_web: todo, EXCEPTO escribir estado vivo y tocar lo append-only
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cps_web;
REVOKE INSERT, UPDATE, DELETE ON device_state FROM cps_web;
REVOKE UPDATE, DELETE ON audit_log FROM cps_web;        -- append-only
REVOKE UPDATE, DELETE ON event_response FROM cps_web;   -- append-only

-- Los SERIAL/BIGSERIAL necesitan nextval() además del INSERT en la tabla.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cps_web;

-- ----------------------------------------------------------------------------
-- cps_alarms: lee configuración, escribe SOLO su territorio
-- ----------------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cps_alarms;
GRANT INSERT, UPDATE ON device_state TO cps_alarms;
GRANT INSERT ON event TO cps_alarms;                    -- crea eventos, NO los resuelve
GRANT INSERT ON audit_log TO cps_alarms;
GRANT USAGE, SELECT ON SEQUENCE event_id_seq, audit_log_id_seq TO cps_alarms;

-- ----------------------------------------------------------------------------
-- Tablas FUTURAS: las migraciones corren como `postgres`, y sin esto cada tabla
-- nueva nacería invisible para cps_web/cps_alarms. Ojo: si una tabla nueva es
-- sensible (estado vivo o append-only), la migración debe REVOCAR a mano, igual
-- que arriba. Si las migraciones corren con otro rol admin, cambiar el FOR ROLE.
-- ----------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cps_web;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cps_web;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO cps_alarms;
