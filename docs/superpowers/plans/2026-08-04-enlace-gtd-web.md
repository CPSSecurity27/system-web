# Enlace GtD ↔ Sistema Web — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar el puente GtD ↔ Postgres funcionando de punta a punta: contrato SQL final (con las 8 respuestas del doc 06 del GtD resueltas como decisiones), `PgRepo`/`PgListener` reales en Python, resiliencia (spool, reintentos, guarda de 1024), y prueba de integración contra la base local con el rol `cps_alarms` real.

**Architecture:** Los dos repos viven en esta máquina y se editan juntos: `c:\Programas_drive\sistema_cps` (web, NestJS+Postgres) y `c:\Programas_drive\gateway-to-device` (GtD, Python/asyncpg/aiomqtt). El contrato es por FUNCIONES en el esquema `gtd` (SECURITY DEFINER; `cps_alarms` sin DML directo). Como **nada está desplegado**, las dos migraciones del puente se editan EN EL LUGAR (no se apilan correctivas) y `PgRepo` se escribe contra la firma final. El firmware (`c:\Programas_drive\AlarmaESP32V6_05-03-2026`) es SOLO LECTURA: cambios ahí van como propuesta escrita.

**Tech Stack:** TypeORM (migraciones a mano), PL/pgSQL, Angular; Python ≥3.11, asyncpg ≥0.29, aiomqtt ≥2.0, pydantic v2, pytest (asyncio_mode=auto).

## Global Constraints

- **El SQL manda**: migraciones a mano, NO existe `migration:generate`. Las entidades TypeORM solo describen.
- **Un solo escritor**: `device_state` y `event` los escribe únicamente el servicio de alarmas vía funciones `gtd.*`. La web no tiene INSERT/UPDATE ahí.
- **MAC pelada (12 hex MAYÚSCULAS) es la clave en TODA la base**, en los dos repos. `AV-` existe solo en MQTT (usuario, client_id, tópico).
- **NULL = no tocar** en `upsert_panel_state`: un parámetro NULL conserva el valor guardado, jamás lo borra.
- **Idioma**: español rioplatense (voseo) en comentarios, docs y mensajes.
- **Commits**: mensajes en español, estilo del repo (`git log`), **SIN Co-Authored-By ni firma de IA**. Cada repo committea en su propio árbol.
- **Firmware**: prohibido editar `AlarmaESP32V6_05-03-2026`. Solo lectura.
- **La base local `cps_security_v2` es descartable** (datos de prueba): se puede borrar y rehacer sin pedir permiso.
- Credenciales locales: rol app `cps_web`/`CpsWeb2026!`, rol alarmas `cps_alarms`/`CpsAlarms2026!`, admin `postgres`/`root`. psql: `C:\Program Files\PostgreSQL\18\bin\psql.exe` con `$env:PGPASSWORD` seteado.
- Payloads del firmware verificados en `components/main/task_mqtt.c` (líneas citadas por task). No inventar campos.

## Decisiones que este plan implementa (respuesta al doc 06 del GtD)

| # | Decisión |
|---|---|
| P0-1 | SÍ: `gtd.fetch_pending_macs()` → `(mac, canal)`, mismos predicados que los `fetch_pending_*`, + índice parcial en `panel_config` |
| P0-2 | SÍ: estado `failed` + `gtd.mark_config_failed(mac, cfg_v, det)` + columna `detalle`. Republicar vuelve a `pending` y limpia `detalle` |
| P1-3 | SÍ: `last_seen = now()` del servidor. El reloj del panel viaja aparte (`ts_device`+`tsq`). `p_seen=false` para el watchdog (marca offline SIN tocar last_seen) |
| P1-4 | SÍ: `p_estado` ('online'/'durmiendo'/'offline') + `p_despierta` → `device_state.sleep_until`. `online` se deriva; cualquier estado explícito ≠ durmiendo limpia `sleep_until` |
| P2-5 | `fw` entra en la firma nueva. NO hay convivencia de firmas: DROP+CREATE (una sobrecarga con DEFAULT daría `function is not unique`). Nada corre aún |
| P2-6 | Postgres directo, sin pooler. Documentado: si algún día hay pgbouncer, el listener lleva DSN directo |
| P2-7 | SÍ: `cfg_full` también por `insert_evento`, con `redes[].psw` REDACTADO (el claro ya vive en el espejo; no se duplica en una tabla append-only) |
| P2-8 | DSN local: los dos repos están en esta máquina. Test de integración gated por `GTD_TEST_PG_DSN` |

---

# FASE 0 — Orden en casa (web)

### Task 1: Renumerar las migraciones del puente

Hoy `GtdBridgeSchema` (1786000000000) y `GtdBridgeFunctions` (1786100000000) **chocan timestamp** con `MandatoryCoordinates` y `AccountNeighborhoodQuotas` de main (ya aplicadas en la base local). Deben correr DESPUÉS de `DropRemoteControlsQuota` (1786200000000).

**Files:**
- Rename: `backend-nestjs/src/database/migrations/1786000000000-GtdBridgeSchema.ts` → `1786300000000-GtdBridgeSchema.ts`
- Rename: `backend-nestjs/src/database/migrations/1786100000000-GtdBridgeFunctions.ts` → `1786400000000-GtdBridgeFunctions.ts`
- Modify: `backend-nestjs/docs/migraciones.md`

**Interfaces:**
- Produces: clases `GtdBridgeSchema1786300000000` y `GtdBridgeFunctions1786400000000` (las tasks 2–4 editan ESTOS archivos ya renombrados).

- [ ] **Step 1: Renombrar con git mv**

```powershell
cd c:\Programas_drive\sistema_cps
git mv backend-nestjs/src/database/migrations/1786000000000-GtdBridgeSchema.ts backend-nestjs/src/database/migrations/1786300000000-GtdBridgeSchema.ts
git mv backend-nestjs/src/database/migrations/1786100000000-GtdBridgeFunctions.ts backend-nestjs/src/database/migrations/1786400000000-GtdBridgeFunctions.ts
```

- [ ] **Step 2: Renombrar las clases adentro (Edit)**

En `1786300000000-GtdBridgeSchema.ts`:
- `export class GtdBridgeSchema1786000000000` → `export class GtdBridgeSchema1786300000000`
- `name = 'GtdBridgeSchema1786000000000'` → `name = 'GtdBridgeSchema1786300000000'`

En `1786400000000-GtdBridgeFunctions.ts`:
- `export class GtdBridgeFunctions1786100000000` → `export class GtdBridgeFunctions1786400000000`
- `name = 'GtdBridgeFunctions1786100000000'` → `name = 'GtdBridgeFunctions1786400000000'`

- [ ] **Step 3: Corregir `backend-nestjs/docs/migraciones.md`**

En la tabla de migraciones: mover las dos filas GtD al final con los números nuevos `1786300000000` / `1786400000000`, y verificar que las filas de main (`MandatoryCoordinates` 1786000000000, `AccountNeighborhoodQuotas` 1786100000000, `DropRemoteControlsQuota` 1786200000000) estén listadas antes. Son **15 migraciones** en total.

- [ ] **Step 4: Verificar que compila**

```powershell
cd backend-nestjs; npx tsc --noEmit
```
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Migraciones GtD: renumerar detrás de las de main (timestamps chocaban)"
```

---

# FASE 1 — El contrato SQL final (web)

### Task 2: GtdBridgeSchema — columnas nuevas del contrato

**Files:**
- Modify: `backend-nestjs/src/database/migrations/1786300000000-GtdBridgeSchema.ts`

**Interfaces:**
- Produces: `device_state.sleep_until TIMESTAMPTZ`, `device_state.ts_device TIMESTAMPTZ`, `device_state.tsq SMALLINT`; `gtd.panel_config.detalle TEXT`; estado `'failed'` válido en `chk_panel_config_estado`; índice `ix_panel_config_pending`.

- [ ] **Step 1: En el bloque `ALTER TABLE device_state` del `up()` (hoy agrega power_mode…last_seen), sumar tres columnas**

```sql
ALTER TABLE device_state
  ADD COLUMN power_mode TEXT,
  ADD COLUMN cfg_v      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN rf_gen     BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN fw         TEXT,
  ADD COLUMN vbat       NUMERIC(5,2),
  ADD COLUMN vpanel     NUMERIC(5,2),
  ADD COLUMN vfuente    NUMERIC(5,2),
  ADD COLUMN last_seen  TIMESTAMPTZ,
  ADD COLUMN sleep_until TIMESTAMPTZ,
  ADD COLUMN ts_device   TIMESTAMPTZ,
  ADD COLUMN tsq         SMALLINT,
  ADD CONSTRAINT chk_device_state_tsq CHECK (tsq IS NULL OR tsq BETWEEN 0 AND 4)
```

Y después de los COMMENT existentes, agregar:

```sql
COMMENT ON COLUMN device_state.sleep_until IS
  'Hasta cuándo avisó que duerme (status durmiendo). NULL = no duerme. Un panel dormido figura online=false: esta columna distingue "duerme hasta las 7" de "se cayó a las 3 AM".';
COMMENT ON COLUMN device_state.ts_device IS
  'El reloj que el panel DECLARA. Con tsq>=2 puede estar días atrás: NUNCA usarlo como last_seen — last_seen lo pone el servidor.';
COMMENT ON COLUMN device_state.tsq IS
  'Calidad del reloj del panel, 0..4, MENOR ES MEJOR (0=NTP, 4=sin sync).';
```

- [ ] **Step 2: En `CREATE TABLE gtd.panel_config`, sumar `detalle` y el estado `failed`**

Columna nueva después de `estado`:
```sql
detalle    TEXT,
```
Y el CHECK pasa a:
```sql
CONSTRAINT chk_panel_config_estado CHECK (
  estado IN ('pending', 'sent', 'applied', 'stale', 'failed')
)
```
Comentario junto a la columna (en el template string):
```sql
COMMENT ON COLUMN gtd.panel_config.detalle IS
  'Por qué está en failed (lo escribe gtd.mark_config_failed, ej: "payload 1180 B > 1024"). Se limpia al republicar.';
```

- [ ] **Step 3: Índice parcial para el barrido (P0-1), después de `ix_commands_pending`**

```sql
CREATE INDEX ix_panel_config_pending ON gtd.panel_config(mac)
  WHERE estado IN ('pending', 'stale')
```

- [ ] **Step 4: `down()` — sumar los drops**

En el bloque `ALTER TABLE device_state` del down(), agregar (antes de los DROP COLUMN existentes):
```sql
DROP CONSTRAINT IF EXISTS chk_device_state_tsq,
DROP COLUMN IF EXISTS tsq,
DROP COLUMN IF EXISTS ts_device,
DROP COLUMN IF EXISTS sleep_until,
```
(`gtd.panel_config` cae con el `DROP SCHEMA gtd CASCADE`, no necesita nada.)

- [ ] **Step 5: Compilar y commit**

```powershell
npx tsc --noEmit
git add -A; git commit -m "Puente GtD: sleep_until, reloj declarado del panel y estado failed de la cfg"
```

### Task 3: GtdBridgeFunctions — `upsert_panel_state` v2 (P1-3, P1-4, P2-5)

**Files:**
- Modify: `backend-nestjs/src/database/migrations/1786400000000-GtdBridgeFunctions.ts`

**Interfaces:**
- Produces (firma que consume PgRepo en Task 13):
```sql
gtd.upsert_panel_state(
  p_mac TEXT, p_estado TEXT, p_modo_energia TEXT, p_alarma_mode TEXT,
  p_cfg_v BIGINT, p_rf_gen BIGINT, p_energia JSONB, p_fw TEXT,
  p_despierta BIGINT, p_ts_device BIGINT, p_tsq SMALLINT, p_seen BOOLEAN
) RETURNS TEXT   -- 'ok' | 'unknown_device'
```

- [ ] **Step 1: Reemplazar la función completa (el `CREATE FUNCTION gtd.upsert_panel_state` del up())**

```sql
CREATE FUNCTION gtd.upsert_panel_state(
  p_mac          TEXT,
  p_estado       TEXT     DEFAULT NULL,  -- 'online' | 'durmiendo' | 'offline'. NULL = no tocar.
  p_modo_energia TEXT     DEFAULT NULL,
  p_alarma_mode  TEXT     DEFAULT NULL,
  p_cfg_v        BIGINT   DEFAULT NULL,
  p_rf_gen       BIGINT   DEFAULT NULL,
  p_energia      JSONB    DEFAULT NULL,
  p_fw           TEXT     DEFAULT NULL,
  p_despierta    BIGINT   DEFAULT NULL,  -- unix s: hasta cuándo duerme (solo con estado durmiendo)
  p_ts_device    BIGINT   DEFAULT NULL,  -- el reloj que el panel DECLARA (unix s)
  p_tsq          SMALLINT DEFAULT NULL,  -- calidad de ese reloj (0..4, menor es mejor)
  p_seen         BOOLEAN  DEFAULT TRUE   -- false = esta llamada NO es el panel hablando (watchdog)
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, gtd, pg_temp
AS $fn$
DECLARE
  v_device_id INT;
  -- Un estado desconocido mapea a offline (conservador: llama la atención).
  v_online    BOOLEAN     := CASE WHEN p_estado IS NULL THEN NULL
                                  ELSE (p_estado = 'online') END;
  v_sleep     TIMESTAMPTZ := CASE WHEN p_estado = 'durmiendo' AND p_despierta IS NOT NULL
                                  THEN to_timestamp(p_despierta) ELSE NULL END;
  v_ts_dev    TIMESTAMPTZ := CASE WHEN p_ts_device IS NULL THEN NULL
                                  ELSE to_timestamp(p_ts_device) END;
BEGIN
  SELECT id INTO v_device_id FROM device WHERE mac = p_mac;

  IF v_device_id IS NULL THEN
    INSERT INTO gtd.uplink_raw (mac, tipo, payload, resultado)
    VALUES (p_mac, 'panel_state',
            jsonb_build_object('estado', p_estado, 'energia', p_energia,
                               'cfg_v', p_cfg_v, 'rf_gen', p_rf_gen, 'fw', p_fw),
            'unknown_device');
    RETURN 'unknown_device';
  END IF;

  INSERT INTO device_state AS ds (
    device_id, online, sleep_until, alarm_status, power_mode, cfg_v, rf_gen, fw,
    vbat, vpanel, vfuente, ts_device, tsq, last_seen, last_heartbeat, updated_at
  ) VALUES (
    v_device_id, COALESCE(v_online, false), v_sleep, p_alarma_mode, p_modo_energia,
    COALESCE(p_cfg_v, 0), COALESCE(p_rf_gen, 0), p_fw,
    (p_energia->>'vbat')::NUMERIC, (p_energia->>'vpanel')::NUMERIC,
    (p_energia->>'vfuente')::NUMERIC, v_ts_dev, p_tsq,
    CASE WHEN p_seen THEN now() END, CASE WHEN p_seen THEN now() END, now()
  )
  ON CONFLICT (device_id) DO UPDATE SET
    online         = COALESCE(v_online, ds.online),
    -- El estado explícito manda: 'durmiendo' fija sleep_until, cualquier otro
    -- la limpia (despertó o se cayó), NULL no la toca.
    sleep_until    = CASE WHEN p_estado = 'durmiendo' THEN v_sleep
                          WHEN p_estado IS NOT NULL   THEN NULL
                          ELSE ds.sleep_until END,
    alarm_status   = COALESCE(p_alarma_mode, ds.alarm_status),
    power_mode     = COALESCE(p_modo_energia, ds.power_mode),
    cfg_v          = COALESCE(p_cfg_v, ds.cfg_v),
    rf_gen         = COALESCE(p_rf_gen, ds.rf_gen),
    fw             = COALESCE(p_fw, ds.fw),
    vbat           = COALESCE((p_energia->>'vbat')::NUMERIC, ds.vbat),
    vpanel         = COALESCE((p_energia->>'vpanel')::NUMERIC, ds.vpanel),
    vfuente        = COALESCE((p_energia->>'vfuente')::NUMERIC, ds.vfuente),
    ts_device      = COALESCE(v_ts_dev, ds.ts_device),
    tsq            = COALESCE(p_tsq, ds.tsq),
    -- last_seen es el reloj del SERVIDOR: cuándo lo escuchamos, no cuándo el
    -- panel cree que habló (con tsq>=2 su ts puede estar días atrás — P1-3).
    -- p_seen=false es el watchdog marcando offline: el panel NO habló.
    last_seen      = CASE WHEN p_seen THEN now() ELSE ds.last_seen END,
    last_heartbeat = CASE WHEN p_seen THEN now() ELSE ds.last_heartbeat END,
    updated_at     = now();

  -- Hito de primera conexión: hecho OBSERVADO por el broker.
  UPDATE device
     SET first_connection_at     = now(),
         first_connection_source = 'OBSERVED'
   WHERE id = v_device_id
     AND first_connection_at IS NULL
     AND COALESCE(v_online, false);

  -- Tras un factory el panel vuelve a cfg_v = 0: marcar stale obliga a republicar.
  IF p_cfg_v = 0 THEN
    UPDATE gtd.panel_config
       SET estado = 'stale', updated_at = now()
     WHERE mac = p_mac AND estado <> 'stale';
  ELSIF p_cfg_v IS NOT NULL THEN
    -- 'failed' incluido: si el panel reporta esa cfg_v, aplicó — se autocura.
    UPDATE gtd.panel_config
       SET estado = 'applied', updated_at = now()
     WHERE mac = p_mac AND cfg_v <= p_cfg_v AND estado IN ('pending', 'sent', 'failed');
  END IF;

  RETURN 'ok';
END;
$fn$
```

Actualizar también el comentario del bloque (`// ── upsert_panel_state ──`) explicando p_estado/p_seen/p_ts_device.

- [ ] **Step 2: Compilar**

```powershell
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "upsert_panel_state v2: durmiendo con sleep_until, last_seen del servidor, fw en la firma"
```

### Task 4: GtdBridgeFunctions — `fetch_pending_macs`, `mark_config_failed` y grants (P0-1, P0-2)

**Files:**
- Modify: `backend-nestjs/src/database/migrations/1786400000000-GtdBridgeFunctions.ts`

**Interfaces:**
- Produces: `gtd.fetch_pending_macs() RETURNS TABLE (mac TEXT, canal TEXT)`; `gtd.mark_config_failed(p_mac TEXT, p_cfg_v BIGINT, p_det TEXT) RETURNS TEXT` (`'ok'|'noop'`). Las consume PgListener (Task 15) y downlink (Task 12).

- [ ] **Step 1: Agregar `fetch_pending_macs` después de `mark_config_sent`**

```sql
-- El barrido del GtD al (re)conectar: LISTEN/NOTIFY no tiene memoria, y un
-- NOTIFY emitido mientras el listener reconectaba no vuelve nunca. Sin esto,
-- una fila queda 'pending' para siempre (P0-1 del GtD).
-- Los predicados COINCIDEN EXACTO con fetch_pending_commands y
-- fetch_pending_config: si divergen, algo pendiente se vuelve invisible
-- para el barrido pero visible para el fetch — el peor bug posible acá.
CREATE FUNCTION gtd.fetch_pending_macs()
RETURNS TABLE (mac TEXT, canal TEXT)
LANGUAGE sql SECURITY DEFINER
SET search_path = public, gtd, pg_temp
AS $fn$
  SELECT c.mac, 'gtd_commands'::TEXT
    FROM gtd.commands c
   WHERE c.estado = 'pending'
   GROUP BY c.mac
  UNION ALL
  SELECT pc.mac, 'gtd_config'::TEXT
    FROM gtd.panel_config pc
   WHERE pc.estado IN ('pending', 'stale');
$fn$
```

- [ ] **Step 2: Agregar `mark_config_failed` a continuación**

```sql
-- La cfg que NO se pudo entregar (ej: payload > MQTT_IN_PAYLOAD_MAX del panel).
-- Sin esto el GtD tiene dos opciones malas: mentir con mark_config_sent o dejar
-- la fila 'pending' en un loop de NOTIFY inútil (P0-2). El trigger de NOTIFY
-- solo dispara con pending/stale, así que 'failed' corta el loop; republicar
-- desde la web (publish_config) la devuelve a 'pending' y limpia el detalle.
CREATE FUNCTION gtd.mark_config_failed(p_mac TEXT, p_cfg_v BIGINT, p_det TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, gtd, pg_temp
AS $fn$
BEGIN
  UPDATE gtd.panel_config
     SET estado = 'failed', detalle = p_det, updated_at = now()
   WHERE mac = p_mac AND cfg_v = p_cfg_v AND estado IN ('pending', 'sent', 'stale');
  RETURN CASE WHEN FOUND THEN 'ok' ELSE 'noop' END;
END;
$fn$
```

- [ ] **Step 3: `publish_config` limpia el detalle al republicar**

En el `ON CONFLICT (mac) DO UPDATE` de `publish_config`, sumar `detalle = NULL`:

```sql
ON CONFLICT (mac) DO UPDATE
  SET cfg_v = EXCLUDED.cfg_v, payload = EXCLUDED.payload,
      estado = 'pending', detalle = NULL,
      updated_by = EXCLUDED.updated_by, updated_at = now();
```

- [ ] **Step 4: Actualizar el bloque de GRANTs del up()**

En el `DO $$ ... $$` de permisos, la lista de `cps_alarms` queda:

```sql
GRANT EXECUTE ON FUNCTION
  gtd.upsert_panel_state(TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, JSONB, TEXT, BIGINT, BIGINT, SMALLINT, BOOLEAN),
  gtd.insert_evento(TEXT, TEXT, JSONB, TEXT, BIGINT),
  gtd.confirm_command(TEXT, TEXT, TEXT),
  gtd.upsert_config_espejo(TEXT, BIGINT, JSONB),
  gtd.fetch_pending_commands(TEXT),
  gtd.fetch_pending_config(TEXT),
  gtd.fetch_pending_macs(),
  gtd.mark_command_sent(TEXT),
  gtd.mark_config_sent(TEXT, BIGINT),
  gtd.mark_config_failed(TEXT, BIGINT, TEXT)
TO cps_alarms;
```

- [ ] **Step 5: `down()` — verificar que las funciones nuevas caigan**

El down() ya hace `DROP SCHEMA`-equivalente por función; sumar los DROP de las dos nuevas junto a los existentes:
```sql
DROP FUNCTION IF EXISTS gtd.fetch_pending_macs();
DROP FUNCTION IF EXISTS gtd.mark_config_failed(TEXT, BIGINT, TEXT);
```

- [ ] **Step 6: Compilar y commit**

```powershell
npx tsc --noEmit
git add -A; git commit -m "Contrato GtD: barrido de pendientes y cfg que no se pudo entregar (P0-1, P0-2)"
```

### Task 5: Roles, DDL de referencia y docs de migraciones

**Files:**
- Modify: `docs/roles-conexion-v2.sql` (líneas ~65–86: bloque de EXECUTE)
- Modify: `docs/esquema-postgres-v2.sql` (§13: esquema gtd)
- Modify: `backend-nestjs/docs/migraciones.md` (filas de las dos migraciones GtD)

- [ ] **Step 1: `roles-conexion-v2.sql` — reemplazar el bloque de GRANT a `cps_alarms`** con la misma lista de la Task 4 Step 4 (firma nueva de `upsert_panel_state`, + `fetch_pending_macs()`, + `mark_config_failed(TEXT, BIGINT, TEXT)`).

- [ ] **Step 2: `esquema-postgres-v2.sql` §13 — transcribir los cambios**: columnas nuevas de `device_state` (sleep_until, ts_device, tsq — copiar de Task 2), `panel_config.detalle` + estado `failed` + `ix_panel_config_pending`, firma nueva de `upsert_panel_state` (Task 3), y las dos funciones nuevas (Task 4). Es transcripción literal de lo que quedó en las migraciones: el .sql es la fuente legible, no puede divergir.

- [ ] **Step 3: `migraciones.md`** — en las filas de `GtdBridgeSchema`/`GtdBridgeFunctions`, sumar una línea: "v2 (2026-08-04): durmiendo/sleep_until, last_seen del servidor, fw en la firma, fetch_pending_macs, mark_config_failed + estado failed — respuestas al doc 06 del GtD".

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Contrato GtD: roles y DDL de referencia al día con la firma v2"
```

### Task 6: Aplicar a la base local y probar el contrato a mano

La base local tiene las 13 migraciones de main aplicadas y **0 funciones gtd**. Acá se aplica el puente por primera vez en esta máquina.

- [ ] **Step 1: Correr migraciones (aplica las 2 del puente)**

```powershell
cd c:\Programas_drive\sistema_cps\backend-nestjs
npm run migration:run
```
Expected: `GtdBridgeSchema1786300000000` y `GtdBridgeFunctions1786400000000` aplicadas, sin errores.

- [ ] **Step 2: Probar el down/up (la reversibilidad es parte del contrato)**

```powershell
npm run migration:revert   # GtdBridgeFunctions
npm run migration:revert   # GtdBridgeSchema
npm run migration:run      # las dos de vuelta
```
Expected: los tres comandos limpios.

- [ ] **Step 3: Aplicar roles**

```powershell
$env:PGPASSWORD="root"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost -d cps_security_v2 -f ..\docs\roles-conexion-v2.sql
```
Expected: GRANTs sin error (los "permiso denegado" que imprime son las probes esperadas del script).

- [ ] **Step 4: Humo del contrato con el rol real**

```powershell
$env:PGPASSWORD="CpsAlarms2026!"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U cps_alarms -h localhost -d cps_security_v2 -c "SELECT gtd.upsert_panel_state('FFFFFFFFFFFF', 'online')"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U cps_alarms -h localhost -d cps_security_v2 -c "SELECT * FROM gtd.fetch_pending_macs()"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U cps_alarms -h localhost -d cps_security_v2 -c "INSERT INTO device_state (device_id, online) VALUES (1, true)"
```
Expected: `unknown_device`; 0 filas; **ERROR de permiso denegado** en el INSERT directo (el contrato lo impone el motor).

- [ ] **Step 5: Commit** — nada que commitear si todo pasó (fue ejecución); si hubo correcciones a las migraciones, commitearlas acá.

### Task 7: Entidad, modelo del front y badge "Durmiendo"

**Files:**
- Modify: `backend-nestjs/src/devices/entities/device-state.entity.ts`
- Modify: `frontend-angular/src/app/core/models/api.models.ts` (interfaz `DeviceState`, línea ~298)
- Modify: `frontend-angular/src/app/features/devices/device-detail.ts`
- Modify: `frontend-angular/src/app/features/devices/device-detail.html`

- [ ] **Step 1: Entidad — tres columnas nuevas** (después de `lastSeen`/`lastHeartbeat`):

```typescript
/**
 * Hasta cuándo avisó que duerme. NULL = no está durmiendo. Un panel dormido
 * figura online=false: esta columna distingue "duerme hasta las 7" de
 * "se cayó a las 3 AM" — la diferencia entre despertar a un técnico y no.
 */
@Column({ name: 'sleep_until', type: 'timestamptz', nullable: true })
sleepUntil!: Date | null;

/** El reloj que el panel DECLARA. Con tsq>=2 puede estar días atrás. */
@Column({ name: 'ts_device', type: 'timestamptz', nullable: true })
tsDevice!: Date | null;

/** Calidad de ese reloj, 0..4, MENOR ES MEJOR (0=NTP, 4=sin sync). */
@Column({ type: 'smallint', nullable: true })
tsq!: number | null;
```

- [ ] **Step 2: `api.models.ts` — interfaz `DeviceState`** (después de `lastHeartbeat`):

```typescript
/** Hasta cuándo avisó que duerme. NULL = no duerme. */
sleepUntil: string | null;
/** El reloj que el panel declara (puede estar atrasado con tsq alto). */
tsDevice: string | null;
/** Calidad de ese reloj, 0..4, MENOR ES MEJOR. */
tsq: number | null;
```

- [ ] **Step 3: `device-detail.ts` — computed nuevo** (junto a `datoDudoso`, línea ~148):

```typescript
/**
 * El panel avisó que duerme y hasta cuándo: silencio ESPERADO, no una caída.
 * Vencida la hora de despertar deja de mostrarse (si sigue mudo, el badge
 * offline y el silencio ya cuentan la verdad).
 */
protected readonly durmiendoHasta = computed<Date | null>(() => {
  const crudo = this.state()?.sleepUntil;
  if (!crudo) return null;
  const hasta = new Date(crudo);
  return hasta.getTime() > Date.now() ? hasta : null;
});
```

- [ ] **Step 4: `device-detail.html` — badge junto al indicador online/offline de la pestaña de estado** (buscar donde se renderiza el badge de conexión; el patrón del template usa `@if`):

```html
@if (durmiendoHasta(); as hasta) {
  <span class="badge text-bg-info">Durmiendo hasta las {{ hasta | date:'HH:mm' }}</span>
}
```
Si el badge offline se muestra con texto "Sin conexión", este va al lado, solo cuando `durmiendoHasta()` no es null.

- [ ] **Step 5: Verificar**

```powershell
cd backend-nestjs; npx tsc --noEmit; npx eslint "src/**/*.ts"; npm test
cd ..\frontend-angular; npm test
```
Expected: todo verde.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Estado en vivo: distinguir durmiendo de caído (sleep_until y reloj declarado)"
```

### Task 8: Actualizar los docs del contrato (web)

**Files:**
- Modify: `docs/contrato-gtd-postgres.md`
- Modify: `docs/gtd-guia-implementacion.md`

- [ ] **Step 1: `contrato-gtd-postgres.md`** — sección nueva "Respuestas al doc 06 (2026-08-04)" con la tabla de decisiones del encabezado de este plan (P0-1…P2-8, decisión y porqué en una línea cada una). Actualizar la firma de `upsert_panel_state` donde aparezca, sumar `fetch_pending_macs` y `mark_config_failed` a la lista de funciones, y el estado `failed` al ciclo de vida de `panel_config` (pending → sent → applied | failed | stale).

- [ ] **Step 2: `gtd-guia-implementacion.md`** — actualizar §3.1 (firma nueva con ejemplo de llamada nombrada), §3.5 (mark_config_failed y fetch_pending_macs con ejemplos SQL), §6 (los casos de humo nuevos: durmiendo, seen=false, failed), y en §2 dejar explícito: "Postgres directo, sin pooler. Si algún día aparece pgbouncer, el `PgListener` lleva un DSN directo aparte: LISTEN sobre un pooler en modo transaction falla de forma intermitente."

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "Docs del contrato GtD: decisiones del doc 06 incorporadas"
```

---

# FASE 2 — El lado Python (GtD). Repo: `c:\Programas_drive\gateway-to-device`

### Task 9: La MAC deja de significar dos cosas (bug §1 del doc 06)

**Files:**
- Modify: `src/gtd/domain/contract.py`
- Modify: `src/gtd/mqtt/topics.py`
- Test: `tests/test_topics_mac.py` (nuevo)

**Interfaces:**
- Produces: `contract.mac_from_device_id(device_id: str) -> str | None`, `contract.device_id_from_mac(mac: str) -> str`; `topics.parse()` devuelve **MAC pelada validada** (12 hex mayúsculas); `topics.cmd_topic(mac)`/`cfg_topic(mac)` reciben MAC pelada y reponen `AV-`.

- [ ] **Step 1: Test que falla**

```python
"""La MAC pelada (12 hex mayúsculas) es la clave en toda la base; AV- existe
solo en MQTT. La traducción vive en el borde (topics/contract) y en ningún
otro lado — doc 06 §1: el bug era falla silenciosa en las DOS direcciones."""

from gtd.domain import contract
from gtd.domain.contract import Channel
from gtd.mqtt import topics


def test_parse_devuelve_mac_pelada():
    assert topics.parse("av/AV-A842E38FCA6C/status") == ("A842E38FCA6C", Channel.STATUS)


def test_parse_rechaza_id_sin_prefijo():
    assert topics.parse("av/A842E38FCA6C/status") is None


def test_parse_rechaza_hex_invalido():
    assert topics.parse("av/AV-a842e38fca6c/status") is None   # minúsculas: no es del firmware
    assert topics.parse("av/AV-ZZ42E38FCA6C/status") is None
    assert topics.parse("av/AV-A842E38FCA/status") is None      # corta


def test_topicos_de_bajada_reponen_el_prefijo():
    assert topics.cmd_topic("A842E38FCA6C") == "av/AV-A842E38FCA6C/cmd"
    assert topics.cfg_topic("A842E38FCA6C") == "av/AV-A842E38FCA6C/cfg"


def test_helpers_de_contract():
    assert contract.mac_from_device_id("AV-A842E38FCA6C") == "A842E38FCA6C"
    assert contract.mac_from_device_id("A842E38FCA6C") is None
    assert contract.device_id_from_mac("A842E38FCA6C") == "AV-A842E38FCA6C"
```

- [ ] **Step 2: Correr y ver el fallo**

```powershell
cd c:\Programas_drive\gateway-to-device
.venv\Scripts\python -m pytest tests/test_topics_mac.py -v
```
Expected: FAIL (`mac_from_device_id` no existe; parse devuelve el id crudo).

- [ ] **Step 3: Implementar en `contract.py`** (debajo de `DEVICE_ID_PREFIX`):

```python
import re

# 12 hex MAYÚSCULAS, sin separadores — el formato canónico de device.mac en la
# base. La misma regla que chk_device_mac_format del esquema web.
_MAC_RE = re.compile(r"^[0-9A-F]{12}$")


def mac_from_device_id(device_id: str) -> str | None:
    """'AV-A842E38FCA6C' → 'A842E38FCA6C'. None si no es un id válido del firmware.

    Estricto a propósito: el firmware SIEMPRE emite AV- + 12 hex mayúsculas
    (usuario = client_id = <id> del tópico). Cualquier otra cosa en el tópico
    es un publicador ajeno, no un panel."""
    if not device_id.startswith(DEVICE_ID_PREFIX):
        return None
    mac = device_id[len(DEVICE_ID_PREFIX):]
    return mac if _MAC_RE.match(mac) else None


def device_id_from_mac(mac: str) -> str:
    """'A842E38FCA6C' → 'AV-A842E38FCA6C'. La ÚNICA forma de armar la identidad
    MQTT desde la MAC: si esto se hace a mano en otro lado, el bug del doc 06 §1
    (publicar en av/<mac-sin-prefijo>/cmd, que el broker acepta y tira) vuelve."""
    return f"{DEVICE_ID_PREFIX}{mac}"
```

Y en `topics.py`:

```python
from ..domain.contract import TOPIC_ROOT, Channel, device_id_from_mac, mac_from_device_id


def parse(topic: str) -> tuple[str, Channel] | None:
    """av/<id>/<canal> → (MAC PELADA, Channel). None si no matchea/no es subida.

    Devuelve la MAC sin prefijo: de este borde para adentro (presencia, repo,
    logs) todo habla MAC pelada. Un id que no valida (sin AV-, hex corrupto) se
    descarta acá: antes entraba crudo y rompía silenciosamente aguas abajo."""
    parts = topic.split("/")
    if len(parts) != 3 or parts[0] != TOPIC_ROOT:
        return None
    mac = mac_from_device_id(parts[1])
    if mac is None:
        return None
    try:
        channel = Channel(parts[2])
    except ValueError:
        return None
    if channel not in UPLINK_CHANNELS:
        return None
    return mac, channel


def cmd_topic(mac: str) -> str:
    return f"{TOPIC_ROOT}/{device_id_from_mac(mac)}/{Channel.CMD.value}"


def cfg_topic(mac: str) -> str:
    return f"{TOPIC_ROOT}/{device_id_from_mac(mac)}/{Channel.CFG.value}"
```

- [ ] **Step 4: Correr TODA la suite y arreglar los tests fosilizados**

```powershell
.venv\Scripts\python -m pytest -v
```
Los tests existentes usan `MAC = "AV-240AC4000110"` como clave esperada (3 archivos: `test_contrato_completo.py`, `test_uplink_log.py`, `test_presencia.py` — verificar con grep). Patrón de corrección en cada uno:

```python
DEVICE_ID = "AV-240AC4000110"   # lo que viaja en el tópico
MAC = "240AC4000110"            # la clave en base y presencia
```
Los tópicos se arman con `DEVICE_ID`; los asserts sobre `repo.panel_state[...]`, `evento["mac"]` y presencia esperan `MAC`.

Expected: suite completa en verde.

- [ ] **Step 5: Commit (en el repo GtD)**

```bash
git add -A && git commit -m "MAC: normalizar en el borde MQTT — pelada hacia adentro, AV- solo en tópicos"
```

### Task 10: Los cuatro tipos de `up` que hoy se descartan

Formas EXACTAS verificadas contra el firmware (`components/main/task_mqtt.c`): `rf_rx` (l.992–1006), `rf_rx_end` (l.324–327), `audit` (l.363–374), `audit_detalle` (l.390–411).

**Files:**
- Modify: `src/gtd/domain/contract.py` (enum `UpType`)
- Modify: `src/gtd/domain/models.py`
- Modify: `src/gtd/domain/payloads.py` (`_UP_MODELS`)
- Test: `tests/test_payloads.py` (agregar casos)

**Interfaces:**
- Produces: `UpType.RF_RX/RF_RX_END/AUDIT/AUDIT_DETALLE`; modelos `UpRfRx`, `UpRfRxEnd`, `UpAudit`, `UpAuditDetalle`. El ruteo de uplink (Task 11) los manda por `insert_evento` como cualquier otro.

- [ ] **Step 1: Tests que fallan** (en `test_payloads.py`, siguiendo el estilo `_up()` del archivo):

```python
def test_rf_rx_conocido_y_desconocido():
    m, _ = payloads.parse(Channel.UP, _up(t="rf_rx", code=12345678901234, known=True,
                                          dni=30111222, pos=1))
    assert m.code == 12345678901234 and m.known and m.dni == 30111222 and m.pos == 1
    m, _ = payloads.parse(Channel.UP, _up(t="rf_rx", code=99, known=False))
    assert not m.known and m.dni is None


def test_rf_rx_end():
    m, _ = payloads.parse(Channel.UP, _up(t="rf_rx_end", motivo="timeout"))
    assert m.motivo == "timeout"


def test_audit_lote():
    m, _ = payloads.parse(Channel.UP, _up(t="audit", start=0, next=0xFFFF,
                                          lote=[{"dni": 30111222, "n": 2, "hash": 123456}]))
    assert m.next == 0xFFFF and m.lote[0]["dni"] == 30111222


def test_audit_detalle():
    m, _ = payloads.parse(Channel.UP, _up(t="audit_detalle",
        clientes=[{"dni": 30111222, "codigos": [{"pos": 0, "code": 111}]}]))
    assert m.clientes[0]["codigos"][0]["code"] == 111
```

- [ ] **Step 2: Correr y ver fallar** — `pytest tests/test_payloads.py -v` → FAIL (`up con t desconocido`).

- [ ] **Step 3: Implementar.** En `contract.py`, dentro de `UpType`:

```python
RF_RX = "rf_rx"                 # RF2: código recibido en modo monitor (alta de controles)
RF_RX_END = "rf_rx_end"         # RF2: fin del modo monitor (cmd / timeout / ventana)
AUDIT = "audit"                 # RF6-2: checksums FNV-1a por cliente, en lotes
AUDIT_DETALLE = "audit_detalle" # RF6-3: códigos exactos de DNIs consultados
```

En `models.py` (después de `UpOta`):

```python
class UpRfRx(_Envelope):
    """RF2: un código de 64 bits captado en modo monitor. Alimenta la pantalla
    de alta de controles RF. known=True trae el dni/pos que el panel ya tiene."""
    t: str = UpType.RF_RX.value
    code: int
    known: bool = False
    dni: int | None = None
    pos: int | None = None


class UpRfRxEnd(_Envelope):
    t: str = UpType.RF_RX_END.value
    motivo: str | None = None    # "cmd" | "timeout" | "ventana"


class UpAudit(_Envelope):
    """RF6-2: lote de {dni,n,hash} para comparar la base RF del panel contra
    la nuestra. next=0xFFFF (65535) = último lote."""
    t: str = UpType.AUDIT.value
    start: int
    next: int
    lote: list[dict[str, Any]] = Field(default_factory=list)


class UpAuditDetalle(_Envelope):
    """RF6-3: códigos EXACTOS de los DNIs consultados. OJO: los códigos RF son
    secretos (en la web viven cifrados AES-256-GCM) — no loguear entero."""
    t: str = UpType.AUDIT_DETALLE.value
    clientes: list[dict[str, Any]] = Field(default_factory=list)
```

En `payloads.py`, sumar los cuatro al `_UP_MODELS` y al import.

- [ ] **Step 4: Correr toda la suite** — verde (el barrido de `test_contrato_completo.py` parametriza sobre `UpType`: si algo del catálogo quedó sin modelo, falla — es el diseño).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "up: rf_rx, rf_rx_end, audit y audit_detalle dejan de descartarse"
```

### Task 11: `Repo` v2 + uplink v2 (estado, dedup, cfg_full redactado)

**Files:**
- Modify: `src/gtd/db/repo.py` (Protocol + StubRepo)
- Modify: `src/gtd/pipeline/uplink.py`
- Modify: `src/gtd/__main__.py` (watchdog y "volvió")
- Test: `tests/test_uplink_v2.py` (nuevo)

**Interfaces:**
- Produces (la firma que PgRepo implementa en Task 13):

```python
async def upsert_panel_state(
    self, mac: str, *, estado: str | None = None,       # 'online'|'durmiendo'|'offline'
    modo_energia: str | None = None, alarma_mode: str | None = None,
    cfg_v: int | None = None, rf_gen: int | None = None,
    energia: dict[str, Any] | None = None, fw: str | None = None,
    despierta: int | None = None,                        # unix s (estado durmiendo)
    ts: int | None = None, tsq: int | None = None,       # reloj DECLARADO del panel
    seen: bool = True,                                   # False = watchdog, no habló el panel
) -> None: ...

async def mark_config_failed(self, mac: str, cfg_v: int, det: str) -> None: ...
```
(El parámetro `online: bool` y `last_seen: int` SE VAN del Protocol: los reemplazan `estado` y el reloj del servidor.)

- [ ] **Step 1: Tests que fallan** (`tests/test_uplink_v2.py`):

```python
"""Uplink v2: el estado viaja completo (durmiendo ≠ offline), el bool del
dedup se usa, y el cfg_full va al histórico SIN passwords."""

import json

import pytest

from gtd.db.repo import StubRepo
from gtd.pipeline import presencia, uplink

DEVICE_ID = "AV-240AC4000110"
MAC = "240AC4000110"


class RepoEspia(StubRepo):
    def __init__(self):
        super().__init__()
        self.llamadas: list[tuple] = []

    async def upsert_panel_state(self, mac, **kw):
        self.llamadas.append(("state", mac, kw))
        await super().upsert_panel_state(mac, **kw)

    async def confirm_command(self, cid, *, res=None, det=None):
        self.llamadas.append(("confirm", cid, res))

    async def insert_evento(self, mac, tipo, payload, *, eid=None, ts=None):
        self.llamadas.append(("evento", mac, tipo, payload))
        return await super().insert_evento(mac, tipo, payload, eid=eid, ts=ts)


def _msg(**campos) -> bytes:
    return json.dumps({"v": 1, "ts": 1700000000, "tsq": 2, **campos}).encode()


@pytest.fixture(autouse=True)
def _presencia_limpia():
    presencia.reiniciar()


async def test_status_durmiendo_pasa_estado_y_despierta():
    repo = RepoEspia()
    await uplink.handle(f"av/{DEVICE_ID}/status", _msg(estado="durmiendo", despierta=1700003600), repo)
    kw = [c for c in repo.llamadas if c[0] == "state"][-1][2]
    assert kw["estado"] == "durmiendo" and kw["despierta"] == 1700003600
    assert kw["ts"] == 1700000000 and kw["tsq"] == 2
    assert "online" not in kw and "last_seen" not in kw


async def test_alarma_duplicada_no_confirma_dos_veces():
    repo = RepoEspia()
    alarma = _msg(t="alarma", eid="b1-7", mode="emergency", prev="off",
                  origin="mqtt", cid="c-42")
    await uplink.handle(f"av/{DEVICE_ID}/up", alarma, repo)
    await uplink.handle(f"av/{DEVICE_ID}/up", alarma, repo)   # QoS1 redistribuye
    confirmaciones = [c for c in repo.llamadas if c[0] == "confirm"]
    assert len(confirmaciones) == 1


async def test_cfg_full_va_al_historico_sin_passwords():
    repo = RepoEspia()
    cfg = _msg(t="cfg_full", cfg_v=7,
               redes=[{"ssid": "Casa", "psw": "SECRETA", "prio": 1}])
    await uplink.handle(f"av/{DEVICE_ID}/up", cfg, repo)
    eventos = [c for c in repo.llamadas if c[0] == "evento" and c[2] == "cfg_full"]
    assert len(eventos) == 1
    assert eventos[0][3]["redes"][0]["psw"] == "***"      # redactado
    assert eventos[0][3]["redes"][0]["ssid"] == "Casa"    # el resto intacto
```

- [ ] **Step 2: Correr y ver fallar** — `pytest tests/test_uplink_v2.py -v`.

- [ ] **Step 3: Implementar.**

`repo.py` — Protocol con la firma de Interfaces (arriba); `StubRepo.upsert_panel_state` ya acepta `**fields`, no cambia; sumar al Protocol y a StubRepo:

```python
async def mark_config_failed(self, mac, cfg_v, det) -> None:
    log.warning("cfg failed mac=%s cfg_v=%s: %s", mac, cfg_v, det)
```

`uplink.py`:

```python
from ..obs.logging import redact
```
El handler de STATUS pasa a:
```python
if channel is Channel.STATUS:
    _log_status(mac, model, silencio=act.silencio, gap=gap_reconexion)
    await repo.upsert_panel_state(
        mac, estado=model.estado, modo_energia=model.modo, fw=model.fw,
        despierta=model.despierta, ts=model.ts, tsq=model.tsq,
    )
```
El de TELE:
```python
elif channel is Channel.TELE:
    await repo.upsert_panel_state(
        mac, modo_energia=model.modo_energia, alarma_mode=model.alarma_mode,
        cfg_v=model.cfg_v, rf_gen=model.rf_gen, energia=model.energia,
        ts=model.ts, tsq=model.tsq,
    )
```
El "volvió" (l.82): `await repo.upsert_panel_state(mac, estado="online")`.

En `_handle_up`, la rama alarma usa el bool (P0 de ellos, punto c):
```python
if t == UpType.ALARMA.value:
    nuevo = await repo.insert_evento(mac, t, doc, eid=model.eid, ts=model.ts)
    if not nuevo:
        log.info("alarma duplicada (QoS1) mac=%s eid=%s — no se reconfirma", mac, model.eid)
    elif model.origin is AlarmaOrigin.MQTT and model.cid:
        await repo.confirm_command(model.cid, res="ok", det=f"alarma {model.mode.value}")
```
La rama cfg_full suma el histórico redactado (P2-7):
```python
elif t == UpType.CFG_FULL.value:
    await repo.upsert_config_espejo(mac, model.cfg_v, doc)
    # Histórico de cómo cambió la config, SIN passwords: el claro ya vive en
    # el espejo; no se duplica en una tabla append-only (P2-7).
    await repo.insert_evento(mac, t, redact(doc), ts=model.ts)
```

`__main__.py`, watchdog (l.74): `await repo.upsert_panel_state(mac, estado="offline", seen=False)` — con el comentario: `# seen=False: el panel NO habló; last_seen no se toca (P1-3).`

Renombrar `device_id` → `mac` en las variables de `uplink.handle` (desde Task 9 lo que circula es la MAC pelada).

- [ ] **Step 4: Correr toda la suite** — verde.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "uplink v2: estado completo al repo, dedup usado, cfg_full al histórico sin passwords"
```

### Task 12: Downlink — guarda de 1024 y JSON compacto

**Files:**
- Modify: `src/gtd/domain/contract.py` (constante)
- Modify: `src/gtd/pipeline/downlink.py`
- Test: `tests/test_downlink_guard.py` (nuevo)

- [ ] **Step 1: Tests que fallan**

```python
"""La cfg que no entra en el buffer del panel NO se publica: se marca failed
con el porqué. Publicarla sería un no-op silencioso del firmware; mark_sent
sería mentira (P0-2). Y todo JSON de bajada va compacto: cada byte acerca el
límite de MQTT_IN_PAYLOAD_MAX."""

import json

from gtd.db.listener import CH_COMMANDS, CH_CONFIG
from gtd.db.repo import StubRepo
from gtd.domain.contract import MQTT_IN_PAYLOAD_MAX
from gtd.pipeline import downlink

MAC = "240AC4000110"


class RepoFalso(StubRepo):
    def __init__(self, cfg=None, cmds=()):
        super().__init__()
        self._cfg, self._cmds = cfg, list(cmds)
        self.failed = []
        self.sent = []

    async def fetch_pending_config(self, mac):
        return self._cfg

    async def fetch_pending_commands(self, mac):
        return self._cmds

    async def mark_config_failed(self, mac, cfg_v, det):
        self.failed.append((mac, cfg_v, det))

    async def mark_config_sent(self, mac, cfg_v):
        self.sent.append((mac, cfg_v))


class PubEspia:
    def __init__(self):
        self.publicados = []

    async def publish(self, topic, payload, qos=0, retain=False):
        self.publicados.append((topic, payload, retain))


async def test_cfg_gigante_se_marca_failed_y_no_se_publica():
    gorda = {"cfg_v": 9, "redes": [{"ssid": f"red{i}", "psw": "x" * 60} for i in range(12)]}
    repo, pub = RepoFalso(cfg={"cfg_v": 9, "payload": gorda}), PubEspia()
    await downlink.handle(CH_CONFIG, MAC, repo, pub)
    assert pub.publicados == []
    assert repo.sent == []
    assert len(repo.failed) == 1
    mac, cfg_v, det = repo.failed[0]
    assert (mac, cfg_v) == (MAC, 9) and str(MQTT_IN_PAYLOAD_MAX) in det


async def test_cfg_normal_sale_compacta_y_retenida():
    repo = RepoFalso(cfg={"cfg_v": 3, "payload": {"cfg_v": 3, "modulos": {"rf": True}}})
    pub = PubEspia()
    await downlink.handle(CH_CONFIG, MAC, repo, pub)
    topic, payload, retain = pub.publicados[0]
    assert topic == "av/AV-240AC4000110/cfg" and retain
    assert " " not in payload            # separadores compactos
    assert repo.sent == [(MAC, 3)]
```

- [ ] **Step 2: Ver fallar** — `MQTT_IN_PAYLOAD_MAX` no existe.

- [ ] **Step 3: Implementar.** En `contract.py` (junto a `SCHEMA_V`):

```python
# Buffer de ENTRADA del panel — MQTT_IN_PAYLOAD_MAX en mqtt_config.h. Un payload
# más grande es un no-op SILENCIOSO del firmware (ni ack de error): la guarda
# vive acá del lado servidor porque del otro lado no hay nadie que avise.
MQTT_IN_PAYLOAD_MAX = 1024
```

En `downlink.py`:

```python
from ..domain.contract import MQTT_IN_PAYLOAD_MAX


def _compacto(doc) -> str:
    """JSON sin espacios: cada byte cuenta contra MQTT_IN_PAYLOAD_MAX."""
    return json.dumps(doc, separators=(",", ":"))
```
La rama `CH_COMMANDS` publica `_compacto(cmd["payload"])`. La rama `CH_CONFIG` pasa a:

```python
elif channel == CH_CONFIG:
    cfg = await repo.fetch_pending_config(mac)
    if cfg is not None:
        raw = _compacto(cfg["payload"])
        crudo = raw.encode()
        if len(crudo) > MQTT_IN_PAYLOAD_MAX:
            # Publicarla sería un no-op silencioso del panel; mark_sent sería
            # mentira. failed + detalle es el único camino honesto (P0-2).
            det = f"payload {len(crudo)} B > {MQTT_IN_PAYLOAD_MAX}"
            log.error("cfg NO publicada mac=%s cfg_v=%s: %s", mac, cfg["cfg_v"], det)
            await repo.mark_config_failed(mac, cfg["cfg_v"], det)
            return
        # cfg va RETAINED: es estado deseado, el panel lo toma al conectar.
        await pub.publish(topics.cfg_topic(mac), raw, qos=1, retain=True)
        await repo.mark_config_sent(mac, cfg["cfg_v"])
        log.info("cfg publicada mac=%s cfg_v=%s (%d B)", mac, cfg["cfg_v"], len(crudo))
```

- [ ] **Step 4: Suite completa en verde. Commit**

```bash
git add -A && git commit -m "downlink: guarda de 1024 bytes con mark_config_failed, JSON compacto"
```

### Task 13: `PgRepo` real

**Files:**
- Modify: `src/gtd/db/repo.py` (reemplazar el `PgRepo` stub)
- Test: `tests/test_pgrepo_unit.py` (nuevo — solo lo testeable sin Postgres; lo real va en Task 17)

**Interfaces:**
- Consumes: funciones `gtd.*` de las Tasks 3–4.
- Produces: `PgRepo(dsn)` que cumple el Protocol `Repo`; excepción `RepoUnavailable(RuntimeError)` que SOLO levanta `insert_evento`/`confirm_command` tras agotar reintentos (el resto reintenta para siempre). La consume el spool (Task 14).

- [ ] **Step 1: Test unitario que falla**

```python
"""Lo de PgRepo que se puede afirmar sin un Postgres: la forma del SQL
(notación nombrada — desacopla del orden de la firma) y la política de
reintentos con RepoUnavailable."""

import pytest

from gtd.db.repo import PgRepo, RepoUnavailable


def test_el_sql_usa_notacion_nombrada():
    assert "p_mac =>" in PgRepo._SQL_UPSERT_STATE
    assert "p_seen =>" in PgRepo._SQL_UPSERT_STATE
    assert "p_eid =>" in PgRepo._SQL_INSERT_EVENTO


async def test_insert_evento_agota_reintentos_y_avisa():
    repo = PgRepo("postgresql://nadie@127.0.0.1:1/no_existe")
    repo.RETRY_BASE_S = 0.01           # que el test no espere de verdad
    with pytest.raises(RepoUnavailable):
        await repo.start_o_falla_rapido_para_test()
```
(El segundo test se ajusta a la API real del Step 3: la intención es que un DSN inválido con `intentos` acotados termine en `RepoUnavailable`, no en un cuelgue.)

- [ ] **Step 2: Ver fallar.**

- [ ] **Step 3: Implementar `PgRepo`** (reemplaza el placeholder de `repo.py`):

```python
import asyncio
import json

import asyncpg


class RepoUnavailable(RuntimeError):
    """Postgres no responde y los reintentos acotados se agotaron. El caller
    decide (el canal `up` va al spool; ver pipeline/uplink)."""


class PgRepo:
    """Repo real contra las funciones del esquema `gtd` (SECURITY DEFINER).

    - Notación NOMBRADA en todas las llamadas: desacopla del orden de la firma.
    - NULL = no tocar: se mandan TODOS los parámetros, None donde no hay dato.
    - Estado (panel_state/config): reintenta PARA SIEMPRE con backoff — es
      idempotente y bloquea el uplink, que es el backpressure correcto (la
      sesión persistente del broker encola mientras tanto).
    - Eventos (insert_evento/confirm_command): reintentos ACOTADOS y después
      RepoUnavailable — una alarma no puede esperar para siempre en memoria,
      para eso está el spool en disco.
    """

    RETRY_BASE_S = 1.0
    RETRY_MAX_S = 30.0
    EVENT_RETRIES = 3

    _ERRORES_CONEXION = (asyncpg.PostgresConnectionError, asyncpg.InterfaceError,
                         ConnectionError, OSError, TimeoutError)

    _SQL_UPSERT_STATE = """
        SELECT gtd.upsert_panel_state(
            p_mac => $1, p_estado => $2, p_modo_energia => $3, p_alarma_mode => $4,
            p_cfg_v => $5, p_rf_gen => $6, p_energia => $7, p_fw => $8,
            p_despierta => $9, p_ts_device => $10, p_tsq => $11, p_seen => $12)
    """
    _SQL_INSERT_EVENTO = """
        SELECT gtd.insert_evento(p_mac => $1, p_tipo => $2, p_payload => $3,
                                 p_eid => $4, p_ts => $5)
    """
    _SQL_CONFIRM = "SELECT gtd.confirm_command(p_cid => $1, p_res => $2, p_det => $3)"
    _SQL_ESPEJO = "SELECT gtd.upsert_config_espejo(p_mac => $1, p_cfg_v => $2, p_payload => $3)"
    _SQL_FETCH_CMDS = "SELECT cid, tipo, payload FROM gtd.fetch_pending_commands($1)"
    _SQL_FETCH_CFG = "SELECT cfg_v, payload FROM gtd.fetch_pending_config($1)"
    _SQL_MARK_CMD = "SELECT gtd.mark_command_sent(p_cid => $1)"
    _SQL_MARK_CFG = "SELECT gtd.mark_config_sent(p_mac => $1, p_cfg_v => $2)"
    _SQL_MARK_CFG_FAILED = "SELECT gtd.mark_config_failed(p_mac => $1, p_cfg_v => $2, p_det => $3)"

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: asyncpg.Pool | None = None

    @staticmethod
    async def _init_conn(conn: asyncpg.Connection) -> None:
        # SIN el códec, los dict llegan como texto — el error número uno
        # anticipado en la guía del equipo web.
        await conn.set_type_codec("jsonb", encoder=json.dumps,
                                  decoder=json.loads, schema="pg_catalog")

    async def start(self) -> None:
        self._pool = await asyncpg.create_pool(
            self._dsn, min_size=1, max_size=4, init=self._init_conn)
        log.info("PgRepo conectado")

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()

    async def _fetchval(self, sql: str, *args, intentos: int | None = None):
        """intentos=None ⇒ reintenta para siempre. intentos=N ⇒ RepoUnavailable."""
        delay, fallos = self.RETRY_BASE_S, 0
        while True:
            try:
                async with self._pool.acquire() as conn:
                    return await conn.fetchval(sql, *args)
            except self._ERRORES_CONEXION as e:
                fallos += 1
                if intentos is not None and fallos >= intentos:
                    raise RepoUnavailable(str(e)) from e
                log.warning("Postgres no responde (%s) — reintento en %.0fs", e, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, self.RETRY_MAX_S)

    async def _fetch(self, sql: str, *args):
        delay = self.RETRY_BASE_S
        while True:
            try:
                async with self._pool.acquire() as conn:
                    return await conn.fetch(sql, *args)
            except self._ERRORES_CONEXION as e:
                log.warning("Postgres no responde (%s) — reintento en %.0fs", e, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, self.RETRY_MAX_S)

    # ── uplink ──
    async def upsert_panel_state(self, mac, *, estado=None, modo_energia=None,
                                 alarma_mode=None, cfg_v=None, rf_gen=None,
                                 energia=None, fw=None, despierta=None,
                                 ts=None, tsq=None, seen=True) -> None:
        res = await self._fetchval(self._SQL_UPSERT_STATE, mac, estado, modo_energia,
                                   alarma_mode, cfg_v, rf_gen, energia, fw,
                                   despierta, ts, tsq, seen)
        if res != "ok":
            # Las funciones no tiran excepción para el GtD: devuelven códigos.
            log.warning("upsert_panel_state mac=%s → %s", mac, res)

    async def insert_evento(self, mac, tipo, payload, *, eid=None, ts=None) -> bool:
        return await self._fetchval(self._SQL_INSERT_EVENTO, mac, tipo, payload,
                                    eid, ts, intentos=self.EVENT_RETRIES)

    async def confirm_command(self, cid, *, res=None, det=None) -> None:
        r = await self._fetchval(self._SQL_CONFIRM, cid, res, det,
                                 intentos=self.EVENT_RETRIES)
        if r != "ok":
            log.warning("confirm_command cid=%s → %s", cid, r)

    async def upsert_config_espejo(self, mac, cfg_v, payload) -> None:
        r = await self._fetchval(self._SQL_ESPEJO, mac, cfg_v, payload)
        if r != "ok":
            log.warning("upsert_config_espejo mac=%s → %s", mac, r)

    # ── downlink ──
    async def fetch_pending_commands(self, mac) -> list[dict[str, Any]]:
        return [dict(r) for r in await self._fetch(self._SQL_FETCH_CMDS, mac)]

    async def fetch_pending_config(self, mac) -> dict[str, Any] | None:
        filas = await self._fetch(self._SQL_FETCH_CFG, mac)
        return dict(filas[0]) if filas else None

    async def mark_command_sent(self, cid) -> None:
        await self._fetchval(self._SQL_MARK_CMD, cid)

    async def mark_config_sent(self, mac, cfg_v) -> None:
        await self._fetchval(self._SQL_MARK_CFG, mac, cfg_v)

    async def mark_config_failed(self, mac, cfg_v, det) -> None:
        await self._fetchval(self._SQL_MARK_CFG_FAILED, mac, cfg_v, det)
```
Ajustar el test unitario del Step 1 a la API real (p.ej. probar `_fetchval` con un pool falso que siempre tira `ConnectionError` y `intentos=2` → `RepoUnavailable` en ~0.01 s con `RETRY_BASE_S` pisado).

- [ ] **Step 4: Suite en verde. Commit**

```bash
git add -A && git commit -m "PgRepo real: asyncpg, notación nombrada, reintentos con backoff y RepoUnavailable"
```

### Task 14: Spool en disco para el canal `up`

aiomqtt ya mandó el PUBACK cuando el mensaje llega al handler: un fallo de base **pierde el mensaje**. Para `status`/`tele` da igual (retained, vuelve otro); para `up t:alarma` no.

**Files:**
- Create: `src/gtd/db/spool.py`
- Modify: `src/gtd/pipeline/uplink.py` (atrapar `RepoUnavailable`)
- Modify: `src/gtd/__main__.py` (drainer)
- Test: `tests/test_spool.py` (nuevo)

**Interfaces:**
- Produces: `Spool(path)` con `append(entry: dict)`, `leer() -> list[dict]`, `reescribir(entries: list[dict])`; `uplink.handle(..., spool: Spool | None = None)`; `uplink.replay(mac, doc, repo)` (lo usa el drainer); corrutina `drenar_spool(spool, repo, period_s)` en `__main__`.

- [ ] **Step 1: Tests que fallan**

```python
"""El spool es el WAL de los eventos: si Postgres está caído, el up ya está
ackeado en MQTT y NO puede perderse. JSONL append-only, drenado al recuperar."""

import json

from gtd.db.repo import RepoUnavailable, StubRepo
from gtd.db.spool import Spool
from gtd.pipeline import presencia, uplink

DEVICE_ID = "AV-240AC4000110"
MAC = "240AC4000110"


def test_append_y_leer_roundtrip(tmp_path):
    s = Spool(tmp_path / "up.jsonl")
    s.append({"mac": MAC, "doc": {"t": "alarma", "eid": "b-1"}})
    s.append({"mac": MAC, "doc": {"t": "ack", "cid": "c-9"}})
    leidos = s.leer()
    assert len(leidos) == 2 and leidos[0]["doc"]["eid"] == "b-1"
    s.reescribir([leidos[1]])
    assert len(s.leer()) == 1


def test_leer_sin_archivo_devuelve_vacio(tmp_path):
    assert Spool(tmp_path / "no_existe.jsonl").leer() == []


class RepoCaido(StubRepo):
    async def insert_evento(self, *a, **kw):
        raise RepoUnavailable("base caída")


async def test_alarma_con_base_caida_va_al_spool(tmp_path):
    presencia.reiniciar()
    spool = Spool(tmp_path / "up.jsonl")
    alarma = json.dumps({"v": 1, "ts": 1, "tsq": 4, "t": "alarma", "eid": "b-2",
                         "mode": "alert", "prev": "off", "origin": "rf"}).encode()
    await uplink.handle(f"av/{DEVICE_ID}/up", alarma, RepoCaido(), spool=spool)
    guardado = spool.leer()
    assert guardado[0]["mac"] == MAC and guardado[0]["doc"]["eid"] == "b-2"


async def test_replay_reinserta(tmp_path):
    presencia.reiniciar()
    repo = StubRepo()
    await uplink.replay(MAC, {"v": 1, "t": "alarma", "eid": "b-3", "mode": "alert",
                              "prev": "off", "origin": "rf", "ts": 1, "tsq": 4}, repo)
    assert repo.eventos[0]["eid"] == "b-3"
```

- [ ] **Step 2: Ver fallar.**

- [ ] **Step 3: Implementar.** `src/gtd/db/spool.py`:

```python
"""Spool en disco del canal `up` — JSONL append-only.

aiomqtt ya ackeó (PUBACK) cuando el mensaje llega al handler: si Postgres está
caído, el mensaje no existe en ningún otro lado. status/tele son retained y
vuelven solos; una alarma no. Es el mismo agujero que el GtD le señaló al
firmware (doc 05 §6) — sería incoherente dejarlo abierto de este lado.

Síncrono a propósito: append es una línea + flush + fsync, y pasa como mucho
una vez por mensaje con la base caída. No amerita aiofiles.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

log = logging.getLogger("gtd.spool")


class Spool:
    def __init__(self, path: Path | str) -> None:
        self._path = Path(path)

    def append(self, entry: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())

    def leer(self) -> list[dict[str, Any]]:
        if not self._path.exists():
            return []
        entradas: list[dict[str, Any]] = []
        with self._path.open(encoding="utf-8") as f:
            for linea in f:
                linea = linea.strip()
                if not linea:
                    continue
                try:
                    entradas.append(json.loads(linea))
                except json.JSONDecodeError:
                    # Una línea rota (corte a mitad de write) no puede frenar
                    # el drenado de las sanas.
                    log.error("línea corrupta en el spool, se descarta: %.80s", linea)
        return entradas

    def reescribir(self, entries: list[dict[str, Any]]) -> None:
        if not entries:
            self._path.unlink(missing_ok=True)
            return
        tmp = self._path.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            for e in entries:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())
        tmp.replace(self._path)
```

`uplink.py` — firma `async def handle(raw_topic, raw_payload, repo, *, gap_reconexion=60.0, spool=None)`; la llamada a `_handle_up` queda:

```python
elif channel is Channel.UP:
    try:
        await _handle_up(mac, doc, model, repo)
    except RepoUnavailable:
        if spool is None:
            raise
        # El PUBACK ya salió: este doc no existe en ningún otro lado.
        spool.append({"mac": mac, "doc": doc})
        log.error("base caída: up de mac=%s al spool", mac)
```
Y la función de replay (el drainer la usa; reparsea para reconstruir el modelo):

```python
async def replay(mac: str, doc: dict, repo: Repo) -> None:
    """Reinserta un `up` guardado en el spool. Idempotente: el dedup por eid
    hace que reinsertar dos veces devuelva False y nada más."""
    model, doc = payloads.parse(Channel.UP, json.dumps(doc))
    await _handle_up(mac, doc, model, repo)
```
(sumar `import json` y `from ..db.repo import Repo, RepoUnavailable` a los imports).

`__main__.py` — el drainer, FUERA del TaskGroup de MQTT (no depende del broker):

```python
async def _drenar_spool(spool, repo, period_s: int = 30) -> None:
    while True:
        await asyncio.sleep(period_s)
        entradas = spool.leer()
        if not entradas:
            continue
        quedan: list[dict] = []
        for i, e in enumerate(entradas):
            try:
                await uplink.replay(e["mac"], e["doc"], repo)
            except RepoUnavailable:
                quedan.extend(entradas[i:])   # sigue caída: preservar el orden
                break
            except Exception:
                log.exception("entrada de spool irreproducible, se descarta: %.80s", e)
        spool.reescribir(quedan)
        if not quedan:
            log.info("spool drenado (%d eventos)", len(entradas))
```
En `run()`: crear `spool = Spool(settings.spool_path)`, pasarlo a `uplink.handle(...)` en `_uplink_loop`, y `drainer = asyncio.create_task(_drenar_spool(spool, repo))` antes del `while True`, con `drainer.cancel()` en el `finally`.

- [ ] **Step 4: Suite en verde. Commit**

```bash
git add -A && git commit -m "spool del canal up: una alarma ackeada en MQTT no se pierde por una caída de la base"
```

### Task 15: `PgListener` real (P0-1 del lado Python)

**Files:**
- Modify: `src/gtd/db/listener.py`
- Test: `tests/test_listener_colapso.py` (nuevo)

**Interfaces:**
- Consumes: `gtd.fetch_pending_macs()` (Task 4).
- Produces: `PgListener(dsn)` con `start()`, `close()`, `get() -> (canal, mac)`, `sweep()`. El bucle de `__main__` (Task 16) llama `sweep()` tras cada reconexión MQTT.

- [ ] **Step 1: Test del colapso de NOTIFY (la parte pura, sin Postgres)**

```python
"""Cinco NOTIFY seguidos del mismo panel son UN solo trabajo: el fetch es por
MAC. Sin colapso, una ráfaga de comandos genera fetchs redundantes."""

from gtd.db.listener import CH_COMMANDS, PgListener


async def test_notify_repetido_colapsa():
    lis = PgListener("postgresql://x@localhost/x")
    for _ in range(5):
        lis._encolar(CH_COMMANDS, "240AC4000110")
    assert lis._q.qsize() == 1
    canal, mac = await lis.get()
    assert (canal, mac) == (CH_COMMANDS, "240AC4000110")
    # Tras el get, un NOTIFY nuevo del mismo panel vuelve a encolar.
    lis._encolar(CH_COMMANDS, "240AC4000110")
    assert lis._q.qsize() == 1
```

- [ ] **Step 2: Ver fallar.**

- [ ] **Step 3: Implementar** (reemplaza el placeholder en `listener.py`):

```python
import asyncpg

PING_S = 30          # una conexión asyncpg muerta NO avisa: hay que pincharla
RETRY_MAX_S = 30.0


class PgListener:
    """LISTEN gtd_commands/gtd_config sobre una conexión DEDICADA.

    - Dedicada porque LISTEN no sobrevive a un pool (y si algún día hay
      pgbouncer, este DSN tiene que ser directo al Postgres).
    - Ping periódico: una conexión muerta no tira error hasta que se la usa.
    - Al conectar (y reconectar) hace el BARRIDO con gtd.fetch_pending_macs():
      un NOTIFY emitido mientras no escuchábamos no vuelve nunca (P0-1).
    - NOTIFY repetidos por (canal, mac) se colapsan: el fetch es por MAC.
    """

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._q: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        self._pendientes: set[tuple[str, str]] = set()
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="pg-listener")

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()

    async def get(self) -> tuple[str, str]:
        canal, mac = await self._q.get()
        self._pendientes.discard((canal, mac))
        return canal, mac

    # interno ──────────────────────────────────────────────
    def _encolar(self, canal: str, mac: str) -> None:
        clave = (canal, mac)
        if clave in self._pendientes:
            return
        self._pendientes.add(clave)
        self._q.put_nowait(clave)

    def _on_notify(self, _conn, _pid, canal: str, payload: str) -> None:
        self._encolar(canal, payload)   # el payload del NOTIFY es la MAC

    async def sweep(self) -> None:
        """Barrido puntual (conexión corta). Lo llama __main__ al reconectar a
        MQTT: un publish que falló a mitad de camino dejó la fila pending y el
        NOTIFY ya se consumió."""
        try:
            conn = await asyncpg.connect(self._dsn)
        except (asyncpg.PostgresError, OSError) as e:
            log.warning("sweep: sin conexión a Postgres (%s)", e)
            return
        try:
            for fila in await conn.fetch("SELECT mac, canal FROM gtd.fetch_pending_macs()"):
                self._encolar(fila["canal"], fila["mac"])
        finally:
            await conn.close()

    async def _run(self) -> None:
        delay = 1.0
        while True:
            try:
                conn = await asyncpg.connect(self._dsn)
                try:
                    await conn.add_listener(CH_COMMANDS, self._on_notify)
                    await conn.add_listener(CH_CONFIG, self._on_notify)
                    for fila in await conn.fetch(
                            "SELECT mac, canal FROM gtd.fetch_pending_macs()"):
                        self._encolar(fila["canal"], fila["mac"])
                    log.info("PgListener escuchando (%s, %s)", CH_COMMANDS, CH_CONFIG)
                    delay = 1.0
                    while True:
                        await asyncio.sleep(PING_S)
                        await conn.execute("SELECT 1")
                finally:
                    await conn.close()
            except asyncio.CancelledError:
                raise
            except (asyncpg.PostgresError, OSError) as e:
                log.warning("PgListener caído (%s) — reintento en %.0fs", e, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, RETRY_MAX_S)
```
`StubListener` suma `async def sweep(self): pass` (mismo contrato).

- [ ] **Step 4: Suite en verde. Commit**

```bash
git add -A && git commit -m "PgListener real: conexión dedicada, ping, barrido de pendientes y colapso de NOTIFY"
```

### Task 16: Cablear el servicio (`__main__`, settings, .env)

**Files:**
- Modify: `src/gtd/__main__.py`
- Modify: `src/gtd/settings.py`
- Modify: `.env.example`

- [ ] **Step 1: `settings.py`** — sumar:

```python
# Spool del canal `up` (eventos que no pudieron entrar a la base). Relativo al
# working dir del servicio.
spool_path: str = "var/spool-up.jsonl"
```

- [ ] **Step 2: `__main__.py`** — cambios puntuales:
- `make_repo`/`make_listener` quedan igual (PgRepo/PgListener ya son reales).
- En `run()`: `spool = Spool(Path(settings.spool_path))` (import de `pathlib` y `gtd.db.spool`), drainer como en Task 14.
- `_uplink_loop` pasa `spool=spool` a `uplink.handle` (sumar parámetro a la función del loop).
- Después de `log.info("suscripto a %s", ...)`: `await listener.sweep()` con el comentario `# Reconexión MQTT: un publish que falló a mitad de camino dejó filas pending sin NOTIFY vivo (P0-1, tercer caso).`
- El `except*` del bucle queda:

```python
except* aiomqtt.MqttError as eg:
    log.warning("MQTT caído (%s) — reintento en %ss", eg.exceptions[0], RECONNECT_S)
    await asyncio.sleep(RECONNECT_S)
except* (asyncpg.PostgresError, OSError) as eg:
    # Cinturón: PgRepo/PgListener contienen sus errores; si algo se escapa
    # igual, el servicio NO muere — reintenta como con MQTT (doc 06 §3.b).
    log.error("error de base no contenido (%s) — reintento en %ss",
              eg.exceptions[0], RECONNECT_S)
    await asyncio.sleep(RECONNECT_S)
```
(con `import asyncpg` arriba).

- [ ] **Step 3: `.env.example`** — sumar al bloque Postgres:

```bash
# DSN de Postgres. Vacío ⇒ StubRepo (sin base). El rol es cps_alarms: SOLO puede
# ejecutar las funciones del esquema gtd — el motor le niega el DML directo.
# Desarrollo local (base cps_security_v2 del repo system-web):
# GTD_PG_DSN=postgresql://cps_alarms:CpsAlarms2026!@localhost:5432/cps_security_v2
GTD_PG_DSN=

# IMPORTANTE: conexión DIRECTA a Postgres, sin pgbouncer. Si algún día hay
# pooler, el listener necesita un DSN directo aparte (LISTEN no sobrevive a un
# pooler en modo transaction, y falla de forma intermitente).
```

- [ ] **Step 4: Suite completa + arranque en seco (StubRepo)**

```powershell
.venv\Scripts\python -m pytest -v
```
Expected: verde. (No arrancar el servicio contra el broker de producción desde acá.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "servicio: spool cableado, barrido al reconectar y la base caída ya no mata el proceso"
```

---

# FASE 3 — Prueba de integración de punta a punta (local)

### Task 17: `test_pg_integracion.py` — el contrato entero contra la base real

**Files:**
- Test: `tests/test_pg_integracion.py` (nuevo, en el repo GtD)

**Interfaces:**
- Consumes: TODO lo anterior. Corre solo si `GTD_TEST_PG_DSN` y `GTD_TEST_PG_ADMIN_DSN` están seteadas (skip limpio si no).

- [ ] **Step 1: Escribir el test.** Estructura:

```python
"""Integración real: PgRepo + funciones gtd contra cps_security_v2, con el rol
cps_alarms de verdad. Los casos de la guía web §6 más los del contrato v2.

Correr:
  $env:GTD_TEST_PG_DSN="postgresql://cps_alarms:CpsAlarms2026!@localhost:5432/cps_security_v2"
  $env:GTD_TEST_PG_ADMIN_DSN="postgresql://postgres:root@localhost:5432/cps_security_v2"
  .venv\\Scripts\\python -m pytest tests/test_pg_integracion.py -v
"""

import os

import asyncpg
import pytest

from gtd.db.repo import PgRepo

DSN = os.environ.get("GTD_TEST_PG_DSN")
DSN_ADMIN = os.environ.get("GTD_TEST_PG_ADMIN_DSN")

pytestmark = pytest.mark.skipif(
    not (DSN and DSN_ADMIN), reason="sin GTD_TEST_PG_DSN/GTD_TEST_PG_ADMIN_DSN")

MAC = "A842E38FCA6C"
MAC_HUERFANA = "A842E38FCA70"


@pytest.fixture
async def admin():
    conn = await asyncpg.connect(DSN_ADMIN)
    yield conn
    await conn.close()


@pytest.fixture
async def equipo(admin):
    """Un equipo OPERATIONAL en un barrio existente de la base + uno huérfano
    (INVENTORY, sin barrio). Se limpian al final — la base es de prueba."""
    await admin.execute("DELETE FROM device WHERE mac IN ($1, $2)", MAC, MAC_HUERFANA)
    device_id = await admin.fetchval("""
        INSERT INTO device (serial, mac, type, status, tested,
                            neighborhood_id, latitude, longitude, installed_at)
        SELECT 'AV-' || $1, $1, 'COMMUNITY_ALARM', 'OPERATIONAL', true,
               n.id, n.latitude + 0.0004, n.longitude + 0.0004, now()
          FROM neighborhood n ORDER BY n.id LIMIT 1
        RETURNING id""", MAC)
    await admin.execute("""
        INSERT INTO device (serial, mac, type, status, tested)
        VALUES ('AV-' || $1, $1, 'COMMUNITY_ALARM', 'INVENTORY', true)""",
        MAC_HUERFANA)
    yield device_id
    await admin.execute("DELETE FROM gtd.commands WHERE mac IN ($1, $2)", MAC, MAC_HUERFANA)
    await admin.execute("DELETE FROM gtd.panel_config WHERE mac IN ($1, $2)", MAC, MAC_HUERFANA)
    await admin.execute("DELETE FROM gtd.config_espejo WHERE mac IN ($1, $2)", MAC, MAC_HUERFANA)
    await admin.execute("DELETE FROM gtd.uplink_raw WHERE mac IN ($1, $2, 'FFFFFFFFFFFF')", MAC, MAC_HUERFANA)
    await admin.execute("DELETE FROM event WHERE device_id = $1", device_id)
    await admin.execute("DELETE FROM device WHERE mac IN ($1, $2)", MAC, MAC_HUERFANA)


@pytest.fixture
async def repo():
    r = PgRepo(DSN)
    await r.start()
    yield r
    await r.close()
```

Casos (cada uno un test, nombres en español):

1. `test_unknown_device_no_explota` — `upsert_panel_state('FFFFFFFFFFFF', estado='online')` no tira excepción; el admin ve la fila en `gtd.uplink_raw` con `resultado='unknown_device'`.
2. `test_tele_completo_escribe_estado` — tele con energia/cfg_v/rf_gen → admin lee `device_state`: `vbat='12.60'`, `cfg_v=7`, `online` sin tocar.
3. `test_null_no_toca` — tras el tele, `upsert_panel_state(MAC, alarma_mode='emergency')` NO borra vbat.
4. `test_durmiendo_fija_sleep_until` — `estado='durmiendo', despierta=<unix futuro>` → `online=false` y `sleep_until` no nulo; luego `estado='online'` → `sleep_until` NULL.
5. `test_watchdog_no_pisa_last_seen` — anotar `last_seen`, llamar `estado='offline', seen=False`, verificar `online=false` y `last_seen` SIN cambiar.
6. `test_last_seen_es_del_servidor` — mandar `ts=1500000000` (2017) con `tsq=4` → `last_seen` es ~now(), `ts_device` es 2017.
7. `test_dedup_de_alarma` — `insert_evento(..., eid='it-1')` → True; repetir → False; `event` tiene UNA fila.
8. `test_desarme_va_al_dead_letter` — `mode='off'` → True (no es duplicado), fila en `uplink_raw` con `resultado='desarme'`, nada en `event`.
9. `test_equipo_sin_barrio_es_orphan` — alarma del `MAC_HUERFANA` → `uplink_raw` `resultado='orphan'`.
10. `test_ciclo_de_comando` — admin llama `gtd.enqueue_command(device_id, 'estado', '{}')`; repo `fetch_pending_commands(MAC)` lo trae; `mark_command_sent(cid)`; `confirm_command(cid, res='ok')` → estado `ok` en `gtd.commands`.
11. `test_fetch_pending_macs` — con un comando pending y una cfg stale (armadas por admin), `SELECT * FROM gtd.fetch_pending_macs()` vía repo (`_fetch`) devuelve las dos filas con su canal.
12. `test_cfg_failed_y_republicacion` — admin siembra espejo (`gtd.upsert_config_espejo` con un cfg_full mínimo) + `gtd.publish_config`; repo `mark_config_failed(MAC, cfg_v, 'payload 1180 B > 1024')` → estado `failed` + detalle; admin re-`publish_config` → `pending` y `detalle` NULL.
13. `test_factory_marca_stale` — con panel_config en `sent`, `upsert_panel_state(MAC, cfg_v=0)` → `stale`.
14. `test_cfg_v_reportada_aplica` — panel_config `sent` con cfg_v=N; `upsert_panel_state(MAC, cfg_v=N)` → `applied`.
15. `test_cps_alarms_sin_dml_directo` — con una conexión asyncpg directa al DSN de cps_alarms, `INSERT INTO device_state ...` levanta `asyncpg.InsufficientPrivilegeError`.
16. `test_cps_alarms_no_encola_comandos` — `SELECT gtd.enqueue_command(...)` con el rol cps_alarms → `InsufficientPrivilegeError` (las funciones de salida son de la web).

- [ ] **Step 2: Correr**

```powershell
cd c:\Programas_drive\gateway-to-device
$env:GTD_TEST_PG_DSN="postgresql://cps_alarms:CpsAlarms2026!@localhost:5432/cps_security_v2"
$env:GTD_TEST_PG_ADMIN_DSN="postgresql://postgres:root@localhost:5432/cps_security_v2"
.venv\Scripts\python -m pytest tests/test_pg_integracion.py -v
```
Expected: 16 passed. Si un CHECK de `device` rechaza el fixture (p.ej. custodia), ajustar el INSERT del fixture contra `docs/esquema-postgres-v2.sql` del repo web — el fixture se adapta al esquema, JAMÁS al revés.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "integración real contra cps_security_v2: el contrato entero con el rol cps_alarms"
```

### Task 18: Verificación total de los dos repos

- [ ] **Step 1: GtD completo** — `pytest -v` (con y sin las env de integración). Verde.
- [ ] **Step 2: Web completo**

```powershell
cd c:\Programas_drive\sistema_cps\backend-nestjs
npx tsc --noEmit; npx eslint "src/**/*.ts"; npm test
cd ..\frontend-angular; npm test
```
Expected: todo verde (el suite e2e del backend sigue en rojo por el modelo v1 — preexistente, no es de este trabajo).

- [ ] **Step 3: Humo visual** — levantar backend + front, entrar a la ficha de un equipo (sembrar `device_state` de un equipo del fixture con `estado='durmiendo'` vía la función, con el rol cps_alarms) y verificar el badge "Durmiendo hasta las HH:mm" en la pestaña de estado.

---

# FASE 4 — Cierre

### Task 19: Docs del GtD — el ping-pong se cierra

**Files:**
- Create: `c:\Programas_drive\gateway-to-device\docs\07-decisiones-integracion.md`
- Modify: `c:\Programas_drive\gateway-to-device\migrations\001_init.sql` (encabezado de deprecación)
- Modify: `c:\Programas_drive\gateway-to-device\docs\README.md` (índice)

- [ ] **Step 1: `07-decisiones-integracion.md`** — documento corto que cierra el 05 y el 06: la tabla de decisiones P0-1…P2-8 (del encabezado de este plan) con su resolución final, la firma v2 de `upsert_panel_state` con ejemplo nombrado, qué quedó implementado de la lista §3 del doc 06 (a–f: TODO), y el aviso de que el contrato vive en el repo web (`docs/contrato-gtd-postgres.md`) — este repo consume, no define.
- [ ] **Step 2: `001_init.sql`** — reemplazar el encabezado por:

```sql
-- ============================================================================
-- DEPRECADO (2026-08-04). Este esquema NUNCA se aplicó y ya no es el contrato.
-- El contrato real son las FUNCIONES del esquema `gtd` en la base del sistema
-- web (repo CPSSecurity27/system-web, docs/contrato-gtd-postgres.md):
-- el GtD no toca tablas — llama funciones. Se conserva como referencia
-- histórica de qué esperaba el GtD antes de la integración.
-- ============================================================================
```
- [ ] **Step 3: README de docs** — sumar el 07 al índice.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: decisiones de la integración con la web; 001_init.sql queda como referencia histórica"
```

### Task 20: Propuestas al firmware (SOLO documento — el repo del firmware no se toca)

**Files:**
- Create: `c:\Programas_drive\gateway-to-device\docs\08-propuestas-firmware.md`

- [ ] **Step 1: Escribir el documento** con las tres propuestas, cada una con problema/evidencia/propuesta/prioridad:
  1. **`central` no vuelve en el `cfg_full`** (ya levantado): sin eso no se puede verificar que alias/ubicación/grupo se aplicaron. Referencia: `mq_build_cfg_full()` en `task_mqtt.c`.
  2. **La `cfg` retenida deja las passwords WiFi en el disco del broker** sin vencimiento (doc 06 §4): proponer `cmd t:refresh` invertido (el panel PIDE la cfg al conectar, nada retenido) o passwords cifradas con clave derivada del equipo. Consecuencia si no: el cifrado en reposo de Postgres (DT2) deja el eslabón débil en Mosquitto.
  3. **Alarma sin PUBACK al reboot** (doc 05 §6, del propio GtD): el outbox del firmware puede perder una alarma si reinicia antes del PUBACK. El GtD ya cerró su mitad (spool, Task 14); la del firmware sigue abierta.
- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "docs: propuestas al firmware (cfg_full/central, cfg retenida con secretos, alarma sin PUBACK)"
```

### Task 21: Merge a main y estado del proyecto (web)

- [ ] **Step 1: Actualizar `docs/estado-proyecto.md`** — punto 9: de "contrato CERRADO, sin implementar" a implementado + integrado (fecha 2026-08-04, decisiones del doc 06 resueltas, PgRepo/PgListener hechos DE ESTE LADO por decisión de liderar el enlace acá). Punto 10 sigue: el deploy del GtD contra producción espera el `SALT_MQTT` (PA4).
- [ ] **Step 2: Actualizar `docs/traspaso-de-pc.md`** — sección 4 (bloqueados): tachar los puntos 2, 3 y 4 (PgRepo, tipos rf_rx/audit, fw en la firma — TODOS resueltos en esta tanda); el 1 (SALT_MQTT), 5 (cifrado en reposo, ahora con la nota del broker), 6 (central), 7 (probar 1024 con placa) y 8 (umbrales de batería) siguen.
- [ ] **Step 3: Merge**

```powershell
cd c:\Programas_drive\sistema_cps
git checkout main
git merge feat/puente-gtd-postgres
git push origin main
```
(Es fast-forward: la rama contiene todo main.)
- [ ] **Step 4: Commit final del GtD si quedó algo suelto**, y push de su `main` si el usuario lo confirma.

---

## Self-review (hecho al escribir)

- **Cobertura**: P0-1 (T4+T15), P0-2 (T2+T4+T12), P1-3 (T3+T11), P1-4 (T2+T3+T7+T11), P2-5 (T3+T13), P2-6 (T8+T16), P2-7 (T11), P2-8 (T16+T17); bug MAC §1 (T9); lista §3 del doc 06: a=T9, b=T13+T16, c=T11, d=T12, e=T15, f=T10+T3. Renumeración de migraciones (T1). Docs (T5, T8, T19, T20). Merge (T21).
- **Tipos consistentes**: firma SQL de T3 = SQL nombrado de T13 = Protocol de T11 (12 parámetros, mismo orden). `fetch_pending_macs() → (mac, canal)` igual en T4, T15 y T17. `mark_config_failed(mac, cfg_v, det)` igual en T4, T12, T13 y T17.
- **Sin placeholders**: todo código completo salvo transcripciones explícitas (T5/T8/T19: el contenido está definido por referencia a bloques concretos de tasks anteriores).
