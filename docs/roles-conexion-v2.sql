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
-- cps_alarms: lee configuración, escribe SOLO por el contrato de funciones
-- ----------------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cps_alarms;
GRANT INSERT ON audit_log TO cps_alarms;
GRANT USAGE, SELECT ON SEQUENCE event_id_seq, audit_log_id_seq TO cps_alarms;

-- Desde el puente con el GtD (2026-08-03) el servicio de alarmas NO escribe
-- tablas directamente: todo pasa por las funciones SECURITY DEFINER del esquema
-- `gtd`. Sin estos REVOKE, el GtD podría saltearse el contrato entero y escribir
-- device_state/event a mano — que es exactamente lo que el contrato evita.
REVOKE INSERT, UPDATE ON device_state FROM cps_alarms;
REVOKE INSERT ON event FROM cps_alarms;                 -- crea eventos, NO los resuelve

-- ----------------------------------------------------------------------------
-- Esquema gtd: nadie toca las tablas, todos pasan por las funciones
-- ----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA gtd TO cps_web, cps_alarms;
REVOKE ALL ON ALL TABLES IN SCHEMA gtd FROM cps_web, cps_alarms;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gtd FROM PUBLIC, cps_web, cps_alarms;

-- Entrada: las 8 que son 1:1 con el Protocol Repo del GtD.
GRANT EXECUTE ON FUNCTION
  gtd.upsert_panel_state(TEXT, BOOLEAN, TEXT, TEXT, BIGINT, BIGINT, JSONB, BIGINT),
  gtd.insert_evento(TEXT, TEXT, JSONB, TEXT, BIGINT),
  gtd.confirm_command(TEXT, TEXT, TEXT),
  gtd.upsert_config_espejo(TEXT, BIGINT, JSONB),
  gtd.fetch_pending_commands(TEXT),
  gtd.fetch_pending_config(TEXT),
  gtd.mark_command_sent(TEXT),
  gtd.mark_config_sent(TEXT, BIGINT)
TO cps_alarms;

-- Salida: las 4 de la web. cps_alarms no tiene por qué poder encolar comandos,
-- ni cps_web insertar eventos.
GRANT EXECUTE ON FUNCTION
  gtd.enqueue_command(INT, TEXT, JSONB, INT),
  gtd.publish_config(INT, JSONB, INT),
  gtd.cancel_command(TEXT, INT),
  gtd.enqueue_rf_batch(INT, JSONB, INT)
TO cps_web;

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

-- Para el esquema `gtd` NO se ponen privilegios por defecto A PROPÓSITO: una
-- tabla nueva ahí tiene que nacer invisible para los dos roles, y el acceso
-- llegar por una función. Si alguna vez hace falta lo contrario, es una
-- decisión explícita, no un descuido heredado.
