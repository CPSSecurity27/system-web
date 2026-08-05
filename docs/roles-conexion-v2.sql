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

-- Entrada: las 8 que son 1:1 con el Protocol Repo del GtD, más el barrido de
-- pendientes (fetch_pending_macs), el camino de vuelta de una cfg que no se
-- pudo entregar (mark_config_failed) y la confirmación de una cfg aplicada
-- (confirm_config: el ack no trae cid, se correlaciona por mac + cfg_v). Firma
-- v2 de upsert_panel_state (2026-08-04): estado durmiendo, reloj declarado y fw.
GRANT EXECUTE ON FUNCTION
  gtd.upsert_panel_state(TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, JSONB, TEXT, BIGINT, BIGINT, SMALLINT, BOOLEAN),
  gtd.insert_evento(TEXT, TEXT, JSONB, TEXT, BIGINT),
  gtd.confirm_command(TEXT, TEXT, TEXT),
  gtd.confirm_config(TEXT, BIGINT, TEXT, TEXT),
  gtd.upsert_config_espejo(TEXT, BIGINT, JSONB),
  gtd.fetch_pending_commands(TEXT),
  gtd.fetch_pending_config(TEXT),
  gtd.fetch_pending_macs(),
  gtd.mark_command_sent(TEXT),
  gtd.mark_config_sent(TEXT, BIGINT),
  gtd.mark_config_failed(TEXT, BIGINT, TEXT)
TO cps_alarms;

-- Salida: las de la web. cps_alarms no tiene por qué poder encolar comandos,
-- ni cps_web insertar eventos. `last_scan` es de lectura pero va acá igual: el
-- GtD escribe los scans, no los consulta.
GRANT EXECUTE ON FUNCTION
  gtd.enqueue_command(INT, TEXT, JSONB, INT),
  gtd.publish_config(INT, JSONB, INT),
  gtd.cancel_command(TEXT, INT),
  gtd.enqueue_rf_batch(INT, JSONB, INT),
  gtd.last_scan(INT),
  gtd.enqueue_provisioning(INT, TEXT, INT)
TO cps_web;

-- La web LEE la cola de provisioning para mostrar el estado en la ficha del
-- equipo. No la escribe: para eso está enqueue_provisioning.
GRANT SELECT ON gtd.provisioning_queue TO cps_web;

-- ----------------------------------------------------------------------------
-- El PROVISIONER: alta y baja de credenciales en el broker (2026-08-04).
--
-- Es un proceso APARTE del GtD, con privilegios propios: escribe
-- /etc/mosquitto/gtd.passwd y recarga el servicio, cosas que el GtD no puede ni
-- debe hacer (está encerrado con NoNewPrivileges y ProtectSystem=strict porque
-- recibe payloads de cada panel).
--
-- Su rol solo lee la cola y confirma. NO puede encolar —eso es de la web— ni
-- ejecutar ninguna función del GtD.
--
--   CREATE ROLE cps_provisioner LOGIN PASSWORD '...';
-- ----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA gtd TO cps_provisioner;
REVOKE ALL ON ALL TABLES IN SCHEMA gtd FROM cps_provisioner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gtd FROM cps_provisioner;

GRANT EXECUTE ON FUNCTION
  gtd.fetch_pending_provisioning(),
  gtd.confirm_provisioning(BIGINT, TEXT, TEXT),
  gtd.confirm_manufacture(BIGINT, TEXT, TEXT, TEXT, TEXT)
TO cps_provisioner;

-- Para el barrido de huérfanos: comparar los usuarios de gtd.passwd contra los
-- seriales que siguen vivos. Un alta que falló a mitad de camino puede dejar una
-- credencial registrada sin equipo que la use, y una credencial viva que nadie
-- reclama es la clase de cosa que no se descubre sola. Solo estas tres columnas.
GRANT SELECT (id, serial, mac) ON device TO cps_provisioner;

-- El GtD no participa del alta de credenciales: no se le da nada de la cola.
REVOKE ALL ON gtd.provisioning_queue FROM cps_alarms;

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
