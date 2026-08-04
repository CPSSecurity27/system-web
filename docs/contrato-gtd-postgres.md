# Contrato GtD ↔ Postgres

> **Fecha:** 2026-08-03 · **Estado:** ACORDADO e IMPLEMENTADO del lado Postgres
> (migraciones `GtdBridgeSchema` + `GtdBridgeFunctions`, aplicadas y probadas
> contra la base de desarrollo). Falta el `PgRepo` del lado Python.
> **Interlocutor:** equipo de `CPSSecurity27/gateway-to-device` (GtD)
> **Base:** respuestas del GtD del 2026-08-03 (`05-preguntas-equipo-web.md`),
> verificadas por ellos contra el firmware `AlarmaESP32V6_05-03-2026`.

## 1. El principio

El GtD y la web comparten **una sola base** y nada más. El GtD **no toca ninguna
tabla**: llama funciones del esquema `gtd`. Adentro de cada función decidimos a
qué tabla va cada cosa.

Por qué: un cambio de mapeo es **una migración nuestra** y no un deploy
coordinado de dos servicios. Es la misma razón por la que en este esquema la
etapa del equipo se deriva de los hitos y el número de placa se compone en vez de
guardarse — un dato, un lugar.

Y no es un acuerdo de caballeros: **todas las funciones son `SECURITY DEFINER`**,
y a `cps_alarms` se le sacan los `INSERT/UPDATE` directos sobre `device_state` y
`event`. Le queda **solo `EXECUTE` sobre `gtd.*`**. El contrato lo impone el motor.

## 2. Cómo se llegó a esta forma (y qué se descartó)

La primera propuesta fue una función por tópico MQTT (`ingest_status`,
`ingest_tele`, `ingest_up`). **Se descartó** al leer `src/gtd/db/repo.py`: el
`Protocol Repo` del GtD **ya está normalizado** — sus pipelines parsean el JSON y
llaman métodos con campos nombrados. Funciones por tópico los habrían obligado a
reescribir los pipelines, que es exactamente lo que su README pide no tocar.

**Las funciones de entrada son 1:1 con los 8 métodos del `Protocol Repo`.**
`PgRepo` queda como un envoltorio delgado: un método = un `SELECT gtd.foo(...)`.

También se descartó importar sus tablas `panel_state` y `eventos`: duplicarían
`device_state` y `event`, y quedarían dos estados vivos libres de contradecirse
(rompe la regla 5). Sus otras dos tablas —`commands` y `panel_config`— **sí se
adoptan**: son cola de bajada y no teníamos nada equivalente.

`mark_offline` también se descartó: su watchdog de presencia ya llama
`upsert_panel_state(mac, estado='offline', seen=False)`. Una función aparte
sobraba. El `seen=False` importa: el watchdog marca offline porque el panel
**no** habló — `last_seen` no se toca.

> **No mover el watchdog a un cron SQL.** Corre **dentro** del TaskGroup de la
> conexión MQTT a propósito: si el GtD pierde el broker, muere con él. Un cron en
> la base no tiene esa protección y marcaría **toda la flota offline** cuando el
> caído es el GtD. Medido por ellos contra hardware real sobre Starlink.

## 3. La MAC es la clave del contrato

Todas las funciones toman **`p_mac`**: 12 hex mayúsculas sin `:`, igual que
`device.mac` (que ya tiene el CHECK `^[0-9A-F]{12}$`).

No el `serial`. El GtD trabaja con MAC pelada en todo su `Repo` y compone el
tópico él (`topics.cmd_topic(mac)` → `av/AV-<MAC>/cmd`), y los `NOTIFY` viajan
con la MAC como payload. Nosotros tenemos `serial = 'AV-' || mac` por CHECK, así
que la traducción es un `'AV-' || p_mac` **de nuestro lado**, que es donde va.

Los `ts` entran como **`BIGINT` epoch en segundos** (así los manda el `Repo`);
el `to_timestamp()` es nuestro. **`last_seen` NO viaja: lo pone el servidor**
(`now()` adentro de `upsert_panel_state`) — el reloj del panel puede estar días
atrás con `tsq >= 2`, y "cuándo lo escuchamos" es un dato nuestro, no de él
(P1-3 del doc 06). Lo que el panel declara viaja aparte como `ts_device` + `tsq`.

## 4. Esquema `gtd` — tablas nuevas

```sql
CREATE SCHEMA gtd;

-- Cola de bajada. Adoptada de migrations/001_init.sql del GtD, + FKs nuestras.
CREATE TABLE gtd.commands (
  cid          TEXT PRIMARY KEY,
  mac          TEXT NOT NULL,
  device_id    INT  NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  tipo         TEXT NOT NULL,          -- CmdType: los 13 del firmware
  payload      JSONB NOT NULL,
  estado       TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|ok|error|cancelled
  detalle      TEXT,
  requested_by INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX ix_commands_pending ON gtd.commands (mac) WHERE estado = 'pending';

-- Config a publicar (retained en av/<id>/cfg).
CREATE TABLE gtd.panel_config (
  mac        TEXT PRIMARY KEY,
  device_id  INT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  cfg_v      BIGINT NOT NULL,
  payload    JSONB  NOT NULL,
  estado     TEXT   NOT NULL DEFAULT 'pending',  -- pending|sent|applied|stale|failed
  detalle    TEXT,                               -- por qué está en failed
  updated_by INT REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Para el barrido de fetch_pending_macs (mismo predicado que fetch_pending_config):
CREATE INDEX ix_panel_config_pending ON gtd.panel_config (mac)
  WHERE estado IN ('pending', 'stale');

-- ESPEJO: el último cfg_full que reportó el panel. NO es lo que le mandamos:
-- es lo que EL PANEL DICE que está corriendo. Es la base del merge (§7) y la
-- única forma de saber qué quedó después de los clamps.
CREATE TABLE gtd.config_espejo (
  mac        TEXT PRIMARY KEY,
  device_id  INT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  cfg_v      BIGINT NOT NULL,
  payload    JSONB  NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dead letter + tipos sin destino en el modelo v2. Nada se pierde.
CREATE TABLE gtd.uplink_raw (
  id          BIGSERIAL PRIMARY KEY,
  mac         TEXT NOT NULL,
  tipo        TEXT NOT NULL,
  eid         TEXT,
  payload     JSONB NOT NULL,
  ts_device   TIMESTAMPTZ,
  tsq         SMALLINT,
  resultado   TEXT NOT NULL,   -- por qué cayó acá: unknown_device|orphan|sin_destino
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_uplink_raw_mac ON gtd.uplink_raw (mac, received_at DESC);
```

`gtd.uplink_raw` es obligatoria, no un lujo: `event.neighborhood_id` es
`NOT NULL`, así que una alarma de un equipo en `INVENTORY` **no se puede
insertar**. Sin dead letter, se pierde.

## 5. Cambios en `public`

### `device_state` crece

Hoy tiene 5 columnas y se queda corta: el panel reporta `vbat`/`vpanel`/`vfuente`,
que es el dato de mantenimiento más importante de un poste.

```sql
ALTER TABLE device_state
  ADD COLUMN power_mode TEXT,                  -- ACTIVE_240, MODEM_SLEEP, …
  ADD COLUMN cfg_v      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN rf_gen     BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN fw         TEXT,
  ADD COLUMN vbat       NUMERIC(5,2),          -- voltios
  ADD COLUMN vpanel     NUMERIC(5,2),
  ADD COLUMN vfuente    NUMERIC(5,2),
  ADD COLUMN last_seen  TIMESTAMPTZ,
  ADD COLUMN sleep_until TIMESTAMPTZ,          -- hasta cuándo avisó que duerme (P1-4)
  ADD COLUMN ts_device   TIMESTAMPTZ,          -- el reloj que el panel DECLARA
  ADD COLUMN tsq         SMALLINT;             -- calidad de ese reloj (0..4, menor mejor)
```

**`durmiendo` no es `offline`** (P1-4 del doc 06): un panel en sueño programado
avisó que se iba y hasta cuándo (`despierta`). `online` sigue siendo booleano
("¿está conectado AHORA?" — un dormido no lo está), y `sleep_until` es lo que
distingue "duerme hasta las 7" de "se cayó a las 3 AM". Cualquier estado
explícito distinto de `durmiendo` la limpia.

**`alarm_status` NO se renombra a `alarma_mode`** aunque el GtD lo llame así: el
resto de la tabla está en inglés (`online`, `last_heartbeat`) y el rename
arrastraría entidad, DTO y frontend por un cambio de vocabulario, no de
significado. Lo que cambia es el CATÁLOGO — el viejo `'connected'/'trigger'` de
Firebase por el del firmware — y eso es un `COMMENT`. Idem `modo_energia`, que
entra como `power_mode`. La traducción vive en la función.

`fw` llega por las dos vías: `upsert_panel_state` lo recibe en la firma v2
(P2-5 — el `status` lo trae y el GtD lo pasa) y `upsert_config_espejo` lo
completa desde `id.fw` del `cfg_full`.

`energia` va en **columnas y no en un JSONB** (como lo tenía el GtD), por lo mismo
que los datos de instalación de `device` van en columnas: para poder preguntar
"¿qué alarmas tienen la batería por debajo de 11 V?", que es lo que sirve cuando
hay que salir a arreglar algo.

`last_seen` es distinto de `last_heartbeat`: el primero es "cuándo habló", el
segundo se mantiene por compatibilidad con el tablero actual.

### `event` crece

```sql
ALTER TABLE event
  ADD COLUMN external_id TEXT,        -- el eid del panel: <boot_id>-<seq>
  ADD COLUMN ts_device   TIMESTAMPTZ, -- el ts que reportó el panel
  ADD COLUMN tsq         SMALLINT;    -- calidad de ese reloj (0..4, menor es mejor)
CREATE UNIQUE INDEX uq_event_external ON event (device_id, external_id)
  WHERE external_id IS NOT NULL;
```

**El índice único ES el dedup.** `insert_evento` devuelve `false` cuando choca, y
el GtD depende de ese booleano.

Alcanza con esto y **no hay que agregar dedup semántico** (por `mode`+`origin`+
`dni` en ventana de tiempo): el re-disparo legítimo existe y viaja con
`prev == mode`; un dedup semántico lo colapsaría. Confirmado con ellos.

También hay que corregir el comentario de `event.trigger_mode`: dice
`cps001, cps002…`, que es el catálogo **viejo de Firebase**. El catálogo real es
el del firmware (§9.1).

## 6. Las funciones

### 6.1 Entrada — las llama el GtD (`cps_alarms`), 1:1 con `Protocol Repo`

Todas devuelven `text` con el resultado en vez de tirar excepción: una excepción
en Postgres mata la transacción y con ella el pipeline.

---

**`gtd.upsert_panel_state(p_mac text, p_estado text, p_modo_energia text, p_alarma_mode text, p_cfg_v bigint, p_rf_gen bigint, p_energia jsonb, p_fw text, p_despierta bigint, p_ts_device bigint, p_tsq smallint, p_seen boolean) → text`**

Estado vivo → `device_state`. Escribe `tele`, `status`, LWT y el watchdog de
presencia; las cuatro cosas entran por acá. Firma v2 (2026-08-04): el GtD llama
con **notación nombrada** (`p_mac => $1, …`), así el orden deja de importar.

> **Semántica crítica: `NULL` significa "no tocar", no "poner en NULL".** En el
> `Repo` todos los parámetros son `| None = None`. Va `COALESCE(p_x, actual)` en
> cada campo. Si esto se implementa mal, un `status` sin voltajes borra el último
> `vbat` conocido — justo el dato que sirve para saber por qué se cayó.

Además:
- **`p_estado`** es el estado del canal `status` tal cual: `'online' |
  'durmiendo' | 'offline'`. `online` se DERIVA (`= 'online'`); `'durmiendo'` +
  `p_despierta` fijan `sleep_until`, cualquier otro estado explícito la limpia.
  Un estado desconocido mapea a offline (conservador: llama la atención).
- **`last_seen` lo pone la función (`now()`)**, no un parámetro: es el reloj del
  servidor. `p_ts_device`/`p_tsq` guardan lo que el panel DECLARA, para auditar
  deriva.
- **`p_seen = false`** es el watchdog del GtD marcando offline: el panel NO
  habló, así que `last_seen` no se toca.
- `p_energia` se abre a `vbat`/`vpanel`/`vfuente`; `p_fw` entra directo (P2-5).
- **Sella la primera conexión**: si `device.first_connection_at IS NULL`, lo
  escribe con `first_connection_source = 'OBSERVED'`. Es lo que
  `backend-nestjs/docs/activos.md` dice que tiene que pasar y hoy nadie hace.
- Si el `p_cfg_v` reportado alcanza al pendiente en `gtd.panel_config`, lo marca
  `applied` (incluida una en `failed`: si el panel la reporta, aplicó — se
  autocura). Si `p_cfg_v = 0` habiendo config guardada → `stale` (§7.4, factory).

Devuelve: `'ok' | 'unknown_device'`.

---

**`gtd.insert_evento(p_mac text, p_tipo text, p_payload jsonb, p_eid text, p_ts bigint) → boolean`**

**`false` si el `eid` ya existía.** El GtD usa ese booleano; es el dedup.
`INSERT ... ON CONFLICT DO NOTHING RETURNING`.

Es el dispatcher por `p_tipo`:

| `tipo` | Va a |
|---|---|
| `alarma` | **`public.event`** (abajo) |
| `ack`, `scan`, `ota`, `cfg_full` | `gtd.uplink_raw` |
| `rf_rx`, `rf_rx_end`, `audit`, `audit_detalle` | `gtd.uplink_raw` (§10) |
| desconocido | `gtd.uplink_raw` con `resultado='sin_destino'` |

Para `alarma`, del payload saca:
- `mode` → `event.trigger_mode` (verbatim) · `origin` → `event_origin` (§9.1)
- `dni` → resuelve vecino → `home` → llena el snapshot `activator_*` (§8)
- `ts`/`tsq` → `ts_device`/`tsq`; `neighborhood_id` se deriva del `device`
- `eid` → `external_id`

Si el equipo está en `INVENTORY` (sin barrio) → `gtd.uplink_raw` con
`resultado='orphan'` y devuelve `true` (no es un duplicado; el GtD no debe
reintentar).

---

**`gtd.confirm_command(p_cid text, p_res text, p_det text) → text`**

Cierra el comando: `estado`, `detalle`, `confirmed_at`. Del `up t:ack`.

---

**`gtd.upsert_config_espejo(p_mac text, p_cfg_v bigint, p_payload jsonb) → text`**

Guarda el `cfg_full` en `gtd.config_espejo`. **Arbitra por `cfg_v`: no pisa el
espejo con una versión más vieja que la guardada.** Requisito explícito de ellos.

Es la pieza que hace posible el merge de §7 y la única forma de saber **qué quedó
realmente** después de los clamps del panel.

---

**`gtd.fetch_pending_commands(p_mac text) → setof (cid text, tipo text, payload jsonb)`**

Lo que hay para publicar en `av/<id>/cmd`. No marca nada: leer no es enviar.

**`gtd.fetch_pending_config(p_mac text) → (cfg_v bigint, payload jsonb)`**

Lo que va a `av/<id>/cfg`. `NULL` si no hay nada pendiente.
**Acá se descifran las passwords WiFi** (§11): así la clave nunca sale de
Postgres y el GtD no necesita saber cómo está guardada.

**`gtd.mark_command_sent(p_cid text) → text`** — `estado='sent'`, `sent_at=now()`.
Después del PUBLISH, no antes.

**`gtd.mark_config_sent(p_mac text, p_cfg_v bigint) → text`** — ídem para config.
El `applied` lo pone el ack, no esto.

**`gtd.fetch_pending_macs() → setof (mac text, canal text)`** — el BARRIDO
(P0-1). `LISTEN/NOTIFY` no tiene memoria: un `NOTIFY` emitido mientras el
listener reconectaba no vuelve nunca, y la fila quedaría `pending` para siempre.
El GtD lo llama al arrancar, al reconectar a Postgres y al reconectar al broker
(un PUBLISH que falló a mitad de camino dejó la fila `pending` sin `NOTIFY`
vivo). `canal` ∈ `'gtd_commands' | 'gtd_config'`. Los predicados coinciden
EXACTO con los `fetch_pending_*`: si divergen, algo pendiente se vuelve
invisible para el barrido pero visible para el fetch.

**`gtd.mark_config_failed(p_mac text, p_cfg_v bigint, p_det text) → text`** — la
cfg que NO se pudo entregar (P0-2), típicamente `"payload 1180 B > 1024"`
(`MQTT_IN_PAYLOAD_MAX` del panel). Sin esto el GtD tenía dos opciones malas:
mentir con `mark_config_sent` o dejar la fila en un loop de `NOTIFY` inútil.
`failed` corta el loop (el trigger solo dispara con `pending`/`stale`);
republicar desde la web vuelve a `pending` y limpia el `detalle`.

### 6.2 Salida — las llama la web (`cps_web`)

Acá las funciones no son aislamiento (el esquema es nuestro): son **atomicidad y
auditoría** — generar el `cid`, incrementar el `cfg_v` sin carrera, dejar el
`audit_log`.

---

**`gtd.enqueue_command(p_device_id int, p_tipo text, p_params jsonb, p_user_id int) → text`**

Encola y devuelve el `cid`. Valida `p_tipo` contra los 13 de `CmdType`
(`estado, restart, alarma, scan, test, ota, factory, rf, refresh, hora, i2c_scan,
red, cal`), resuelve `device_id → mac`, escribe `audit_log`, e inserta —
disparando el `NOTIFY 'gtd_commands'` con la **MAC** como payload.

**Los destructivos (`factory`, `ota`, `restart`) exigen rol CPS**, y se chequea
acá adentro: en el controller se puede olvidar, acá no.

---

**`gtd.publish_config(p_device_id int, p_patch jsonb, p_user_id int) → bigint`**

Merge contra el espejo (§7), `cfg_v + 1` atómico, `estado='pending'`, audit,
NOTIFY. Devuelve el `cfg_v` nuevo.

**Rechaza el patch si no hay espejo para ese panel** (equipo que nunca conectó):
mandar `modulos` a ciegas **apaga módulos**. Recomendación textual del GtD.

Y **descarta del espejo las secciones de solo lectura** (`id`, `rf`, `cal`)
antes de publicar: existen en el `cfg_full` que sube, no en el `cfg` que baja
(`rf` se toca con `cmd t:rf`, `cal` con `cmd t:cal`). Devolverlas es ruido, y con
`MQTT_IN_PAYLOAD_MAX = 1024` cada byte de más acerca el límite en el que una cfg
con 5 redes deja de entrar (punto abierto §14.3).

---

**`gtd.cancel_command(p_cid text, p_user_id int) → boolean`**

Solo si sigue `pending`. `false` si ya salió — un comando enviado no se cancela,
se compensa.

---

**`gtd.enqueue_rf_batch(p_device_id int, p_lotes jsonb, p_user_id int) → int`**

Encola los `cmd t:rf op:"batch"` que cargan la base RF del panel (§8). Devuelve
la cantidad de lotes encolados (hasta 5 clientes por lote, 4 códigos por cliente).

> **No puede ser un `sync` puro en SQL.** `remote_code.code_encrypted` es
> AES-256-GCM y **la base nunca ve el claro** — la clave la tiene el backend
> NestJS. Así que el descifrado pasa en Node y los códigos entran ya en claro por
> `p_lotes`. Consecuencia: **`gtd.commands.payload` de un `t:rf` lleva códigos RF
> en claro**, igual que `panel_config` lleva passwords WiFi. El cifrado en reposo
> (§11) tiene que cubrir las dos tablas, no solo una.

## 7. El circuito de configuración

```
Panel web → gtd.publish_config() → INSERT gtd.panel_config (pending)
                                          ↓ trigger
                                  NOTIFY 'gtd_config'  (payload = MAC)
                                          ↓
                                  GtD (PgListener despierta)
                                          ↓
                                  gtd.fetch_pending_config()
                                          ↓
                              PUBLISH av/<id>/cfg (retained, QoS 1)
                                          ↓
                                  gtd.mark_config_sent()
                                          ↓
                    up t:ack {cfg_v: N, res:"ok"} → confirm_command → applied ✅
                                          ↓
                    up t:cfg_full → upsert_config_espejo → base del próximo merge
```

Que sea **retained** es lo que lo hace robusto: un panel que estuvo tres días sin
luz reconecta y el broker le entrega la última config solo.

### 7.1 El merge es por SECCIÓN, no por campo

El panel mergea por sección (cada una tiene su flag `has_*`), pero **dentro de
una sección los subcampos ausentes toman su default, no el valor actual**. Tres
trampas, todas con la misma forma:

| Sección | Qué pasa si mandás el objeto incompleto |
|---|---|
| `modulos` | **Apaga los módulos ausentes.** `{"modulos":{"rf":true}}` apaga `ds3231`, `eeprom` y `supervisor`. Sin error, con ack `ok`. |
| `central` | Subcampo ausente → `""` → **borra** el valor guardado |
| `redes` | **Reemplaza el set completo.** Omitir una red la borra. |

Mergean bien campo a campo: `alarma.autooff` (cada modo independiente,
`0`/ausente = no tocar) y `red_avanzada` (pero exige los 3).

**Por eso `publish_config` mergea contra `gtd.config_espejo` y siempre emite
`modulos`, `central` y `redes` COMPLETOS.**

### 7.2 Los clamps recortan, no rechazan

Si mandás `send_tele_s: 5`, el panel guarda `30`, contesta `ok`, y el `cfg_full`
muestra `30`. **La UI tiene que reconciliar contra el espejo**, nunca asumir que
lo enviado quedó.

Lo que **sí rechaza la cfg entera, sin ack**: `cfg_v` ausente o `0`,
`hora.tz_offset_s` fuera de ±14 h, `red_avanzada` incompleto, y cualquier campo
con el tipo equivocado (`"30"` string donde va número).

### 7.3 `cfg_v` es estrictamente mayor

`12 → 13` aplica; `13 → 13` ignora; `13 → 12` ignora. **Y el rechazo es silencio
total: no manda ack, ni `ok` ni `error`.**

- **Republicar la misma `cfg_v` es un no-op.** Para forzar, hay que **subir**
  `cfg_v`. (`cmd t:refresh` solo pide que republique su `cfg_full`, no reaplica.)
- **No existe ack negativo por versión vieja.** El único timeout implementable:
  publiqué `cfg_v=N`, no llegó `ack {cfg_v:N, res:"ok"}` en X segundos → no se
  aplicó.

### 7.4 Después de un `factory`, la config queda desincronizada

`cfg_v` persiste en NVS y **un `factory` lo vuelve a 0**. El panel queda con
defaults de fábrica pero nuestra `panel_config` sigue diciendo `cfg_v=40`.

Regla: **cuando el panel reporta `cfg_v = 0` habiendo config guardada, marcar
`estado='stale'` y republicar completo.** No depender de la monotonía global del
contador: depender del `cfg_v` que reporta el panel.

## 8. La base RF — el flujo que faltaba

**El `dni` que vuelve en la alarma es el que nosotros mismos cargamos.** El
control RF transmite solo un código de 64 bits; el panel lo busca en su base RF
local (EEPROM) y de ahí saca el `dni`. Esa base la carga el servidor con
`cmd t:rf op:"batch"`.

Consecuencia dura: **un código que no está en la base del panel no dispara nada.**
No hay evento, solo un log local. Si `enqueue_rf_batch` no corre, el barrio tiene
alarmas instaladas que no suenan.

Por eso `remote.device_id` ("alarma donde están grabados sus códigos RF") deja de
ser un dato informativo y pasa a ser **lo que hay que sincronizar**. `rf_gen` en
`device_state` es el contador de generación de esa base — el `cfg_v` del RF.

Detalles confirmados:
- Nunca llega un `dni` desconocido (el panel no dispara si no lo tiene).
- `codigos` es **cuántos códigos tiene registrados ese cliente** (1..4), no cuál
  se apretó. El botón sí determina el modo (`a`=emergency, `b`=suspicious,
  `c`=alert, `d`=off) pero la posición no viaja.
- `dni` viene solo cuando `dni > 0`, que en la práctica es `origin: "rf"`. Para
  los otros orígenes viajan en su lugar `cid` (origin `mqtt`) o `rol` →`tec|cps`
  (origin `portal`). `origin: "auto"` no trae ninguno.

## 9. Mapeos

### 9.1 `origin` → `event_origin`

| Firmware | Nuestro enum | Por qué |
|---|---|---|
| `rf` | `REMOTE` | control remoto del hogar |
| `mqtt` | `APP` | disparo por comando del servidor |
| `auto` | `DEVICE` | auto-off del propio equipo |
| `portal` | `PANEL` | portal cautivo local (rol `tec`/`cps`) |

`mode` (`off|suspicious|alert|emergency|fire|medical|silent|panic`) va **verbatim**
a `event.trigger_mode`. Una tabla de traducción a un catálogo propio sería un
segundo vocabulario que nadie mantiene.

### 9.2 `tsq` — escala 0..4, **menor es mejor**

| `tsq` | Qué es | ¿Confiar en el `ts` del panel? |
|---|---|---|
| 0 | NTP reciente | **Sí** |
| 1 | DS3231 (RTC con batería) | **Sí** |
| 2 | piso guardado en NVS | No — puede estar días atrasado |
| 3 | RTC interno sin corregir | No |
| 4 | +6 h sin sync | No |

**Regla: `tsq <= 1` → ordenar por `ts_device`; `tsq >= 2` → ordenar por
`created_at` del servidor.**

Trampa confirmada: el arranque MQTT está gateado por *reloj plausible*
(`>= 2024-01-01`) para que no falle el handshake TLS, así que **nunca llega un
`ts` de 1970 — pero el gate mira el valor, no la calidad**. Un `tsq: 2` pasa el
gate y aun así puede estar muy atrasado. "El ts es plausible" **no** sustituye a
mirar `tsq`.

### 9.3 El esquema `cfg` completo (bajada, S→D)

Verificado contra `mqtt_parse.c` / `alarma_core.c` del firmware. Ojo: la doc
`01-mqtt-contract.md` que estaba publicada tenía `red_av`, `tz`, `autooff` y
`roam` sueltos — **todo eso era viejo**; ellos ya lo corrigieron.

| Clave | Subcampo | Tipo | Rango | Default |
|---|---|---|---|---|
| `cfg_v` | — | uint32 | `1..2³²-1` (0 = malformado) | `0` |
| `redes[]` (máx 5) | `ssid` | string | ≤31 | — |
| | `psw` | string | ≤63 | — |
| | `prio` | uint | `1..5` | por orden |
| `modulos` | `ds3231` | bool | — | `false` |
| | `eeprom` | bool | — | `false` |
| | `supervisor` | bool | — | `false` |
| | `rf` | bool | — | **`true`** (fail-safe) |
| | `eeprom_slot` | uint | `0..1` | `0` |
| `tiempos` | `send_tele_s` | uint32 s | clamp `[30, 86400]` | `300` |
| `hora` | `tz_offset_s` | int32 s | `±50400`; fuera → **rechaza todo** | `-10800` |
| `mante` | `on` | bool | — | `false` (auto-salida 4 h) |
| `alarma.autooff` | `suspicious` | uint32 s | clamp `[120, 1800]` | `120` |
| | `alert` | | | `300` |
| | `emergency` / `fire` / `medical` / `silent` | | | `600` |
| | `panic` | | | `900` |
| `red_avanzada` | `roam_rssi` | int32 dBm | clamp `[-90, -50]` | `-72` |
| | `roam_delta` | uint32 dBm | clamp `[5, 30]` | `10` |
| | `roam_cooldown_s` | uint32 s | clamp `[60, 3600]` | `300` |
| | *(los 3 obligatorios si mandás el objeto)* | | | |
| `central` | `alias` | string | ≤31 | `""` |
| | `ubicacion` | string | ≤63 | `""` |
| | `grupo` | string | **≤15** | `""` |

### 9.4 Qué GENERA la web y qué se configura

`central` **no se tipea en ninguna pantalla** — ya tenemos esos datos:

| Clave cfg | Sale de |
|---|---|
| `central.alias` | `device.name` ("Esquina Norte") |
| `central.ubicacion` | `device.reference` / `pole_number` |
| `central.grupo` | el barrio — **ver problema abajo** |
| `hora.tz_offset_s` | provincia del barrio (`-10800` en todo el país) |
| `mante.on` | `device_maintenance` activo |

Si un operador los pudiera escribir a mano, en seis meses el poste se llamaría
distinto en la web y en el equipo, sin forma de saber cuál miente.

Se configuran de verdad (default por barrio, override por equipo):
`modulos`, `tiempos.send_tele_s`, `alarma.autooff`, `red_avanzada`, `redes`.

> **Problema abierto: `central.grupo` es de 15 caracteres.** Los nombres de
> barrio no entran ("Barrio Parque Los Aromos"). Hace falta un
> `neighborhood.code` corto, o truncar y aceptar que el grupo sea ilegible.

## 10. Lo que el GtD descarta hoy y vamos a necesitar

El firmware emite `rf_rx`, `rf_rx_end`, `audit` y `audit_detalle`; el GtD los tira
con `PayloadError: up con t desconocido`.

**Son exactamente los que alimentan una pantalla de alta de controles RF**, y
nuestro modelo tiene `remote` y `remote_code`. Hay que pedirles que los agreguen a
`UpType` y `_UP_MODELS` (ya se ofrecieron). Mientras tanto caen en
`gtd.uplink_raw` sin romper nada.

## 11. Cifrado en reposo (DT2, abierto)

`gtd.panel_config.payload` lleva **passwords WiFi en claro** (`redes[].psw`), y
`gtd.commands.payload` de un `t:rf` lleva **códigos RF en claro** (§6.2). El
cifrado en reposo es responsabilidad nuestra (DT2 del GtD) y **sigue abierto**.

Criterio propuesto: mismo esquema que `remote_code` (AES-256-GCM,
`iv || authTag || ciphertext`), descifrando dentro de `fetch_pending_config` /
`fetch_pending_commands` para que el claro nunca salga de Postgres.

## 12. NOTIFY

Se acepta la propuesta de notificar **solo ante cambio real** — el trigger
original disparaba en cada `INSERT OR UPDATE`, y la cola de `pg_notify` llena hace
fallar los `COMMIT`, no solo las notificaciones.

Dato que baja la urgencia: **no hay un NOTIFY por heartbeat**. El keepalive MQTT
(20 s) es PINGREQ/PINGRESP entre panel y broker; el GtD ni se entera. Lo que
escribe es el `tele` (default **300 s**) más los disparos por cambio de estado.
Con 1.000 paneles son ~3,3 escrituras/s.

Canales, sin cambios (están en `src/gtd/db/listener.py`):

| Canal | Payload | Quién escucha |
|---|---|---|
| `gtd_commands` | MAC | GtD |
| `gtd_config` | MAC | GtD |
| `app_panel_state` | MAC | la web |

`app_panel_state` se emite solo si cambia `online`, `alarma_mode`, `cfg_v`,
`rf_gen` o `modo_energia`. **No** por voltaje ni por `last_seen`: para eso el
tablero poll-ea. El NOTIFY es para lo que no puede esperar.

Y una regla que no se negocia: **los eventos nunca se filtran.** Una alarma no
puede depender de un `IS DISTINCT FROM`.

## 13. Roles

```sql
-- El contrato, impuesto por el motor y no por disciplina
REVOKE INSERT, UPDATE ON device_state FROM cps_alarms;
REVOKE INSERT          ON event        FROM cps_alarms;
GRANT  USAGE ON SCHEMA gtd TO cps_alarms, cps_web;
GRANT  EXECUTE ON ALL FUNCTIONS IN SCHEMA gtd TO cps_alarms;  -- entrada
GRANT  EXECUTE ON ALL FUNCTIONS IN SCHEMA gtd TO cps_web;     -- salida
```

Hay que separar los `GRANT EXECUTE` función por función: `cps_alarms` no tiene
por qué poder llamar `enqueue_command`, ni `cps_web` `insert_evento`.

Actualizar `docs/roles-conexion-v2.sql` (líneas 50-51) y las
`ALTER DEFAULT PRIVILEGES` para que el esquema `gtd` no herede permisos amplios.

## 14. Puntos abiertos

| # | Qué | De quién |
|---|---|---|
| 1 | **`SALT_MQTT` de producción** (PA4). Bloquea el alta masiva por derivación. Algoritmo cerrado: `HMAC-SHA256(SALT_MQTT, MAC_STA)[0..11]` → 24 hex, **sin prefijo** (el `SCPS-` era error de doc). Interín: alta con `PANEL_PASSWORD` explícita por MAC — alcanza para probar el camino completo con una placa. | acción humana |
| 2 | **Cifrado en reposo** de `panel_config` y `commands` (DT2) | nuestro |
| 3 | **`MQTT_IN_PAYLOAD_MAX = 1024`**: una cfg con 5 redes y passwords largas puede **no entrar** en el panel. Sin probar. Si no llega ack con una cfg grande, es por acá. | probar juntos |
| 4 | **`central` baja pero no vuelve** en el `cfg_full` — hoy no hay forma de verificar que alias/ubicación/grupo se aplicaron. Bug de firmware, ya levantado por ellos. | firmware |
| 5 | **`neighborhood.code`** corto para `central.grupo` (≤15) | nuestro |
| 6 | `rf_rx`/`rf_rx_end`/`audit`/`audit_detalle` en `UpType` (§10) | GtD |
| 7 | **¿`t:alarma` con `mode:"off"` resuelve el evento abierto?** Semánticamente es "alguien la apagó", pero los GRANTs dicen que el servicio de alarmas *crea* eventos y **no los resuelve**. Sin decidir. | nuestro |
| 8 | **Liveness del GtD.** Si el GtD se cae, nadie marca offline y `device_state` queda congelada mintiendo "online". Propuesta sin costo de coordinación: derivarlo de `max(last_seen)` de toda la flota — si *todos* callan, el caído es el GtD. | nuestro |

---

## 15. Respuestas al doc 06 del GtD (2026-08-04) — todas resueltas

El 2026-08-04 se decidió **liderar el enlace desde acá** (los dos repos en la
misma máquina, una sola cabeza): las 8 preguntas dejaron de ser preguntas y se
implementaron en los dos lados a la vez. Nada estaba desplegado, así que las
migraciones se editaron EN EL LUGAR — sin ventanas de convivencia de firmas.

| # | Decisión | Dónde quedó |
|---|---|---|
| P0-1 | SÍ: `gtd.fetch_pending_macs()` → `(mac, canal)`, mismos predicados que los `fetch_pending_*` + índice parcial en `panel_config` | §6.1 |
| P0-2 | SÍ: estado `failed` + `gtd.mark_config_failed(mac, cfg_v, det)` + columna `detalle`. Republicar vuelve a `pending` y limpia el detalle | §6.1, §4 |
| P1-3 | SÍ, tenían razón: `last_seen = now()` del servidor, adentro de la función. El reloj del panel viaja aparte (`ts_device` + `tsq` en `device_state`) | §3, §5, §6.1 |
| P1-4 | SÍ: `p_estado` ('online'/'durmiendo'/'offline') + `p_despierta` → `sleep_until`. `online` se deriva; cualquier estado ≠ durmiendo la limpia | §5, §6.1 |
| P2-5 | `fw` en la firma nueva. **Sin convivencia de firmas**: en Postgres, agregar un parámetro con DEFAULT no reemplaza la función — crea una SOBRECARGA, y una llamada vieja matchearía las dos (`function is not unique`). DROP+CREATE de una, con nada desplegado | §6.1 |
| P2-6 | Postgres **directo, sin pooler**. Si algún día hay pgbouncer, el listener lleva un DSN directo aparte: LISTEN sobre un pooler en modo transaction falla de forma intermitente | §13 |
| P2-7 | SÍ: `cfg_full` también por `insert_evento` para el histórico en `uplink_raw`, con `redes[].psw` REDACTADO por el GtD antes de mandar — el claro ya vive en el espejo, no se duplica en una tabla append-only | §6.1 |
| P2-8 | Resuelto por geografía: los dos repos en la misma máquina, DSN local contra `cps_security_v2` con el rol `cps_alarms` real. Test de integración en el repo GtD (`tests/test_pg_integracion.py`) | — |

Del lado del GtD quedó implementado TODO su §3 (a–f): normalización de MAC,
resiliencia ante caída de Postgres (reintentos + spool en disco del canal `up`),
uso del booleano de `insert_evento`, guarda de 1024 bytes, `PgListener` con
reconexión/barrido/colapso de NOTIFY, y los cuatro tipos nuevos.

Y su observación del §4 (la `cfg` **retenida** deja las passwords WiFi en el
disco de Mosquitto) quedó registrada en §11: cifrar Postgres (DT2) NO cierra
DT2 — mueve el eslabón débil al broker. Propuesta al firmware en el repo GtD,
`docs/08-propuestas-firmware.md`.

## Apéndice — `PgRepo` en una línea por método

| `Protocol Repo` | Función |
|---|---|
| `upsert_panel_state(mac, *, estado, …, seen)` | `gtd.upsert_panel_state(…)` |
| `insert_evento(mac, tipo, payload, eid, ts) -> bool` | `gtd.insert_evento(…) → boolean` |
| `confirm_command(cid, res, det)` | `gtd.confirm_command(…)` |
| `upsert_config_espejo(mac, cfg_v, payload)` | `gtd.upsert_config_espejo(…)` |
| `fetch_pending_commands(mac) -> list` | `gtd.fetch_pending_commands(…)` |
| `fetch_pending_config(mac) -> dict\|None` | `gtd.fetch_pending_config(…)` |
| `mark_command_sent(cid)` | `gtd.mark_command_sent(…)` |
| `mark_config_sent(mac, cfg_v)` | `gtd.mark_config_sent(…)` |
| `mark_config_failed(mac, cfg_v, det)` | `gtd.mark_config_failed(…)` |
| *(PgListener)* barrido al (re)conectar | `gtd.fetch_pending_macs()` |

`start()` / `close()` son del pool, no del contrato. Todas las llamadas van con
**notación nombrada** (`p_mac => $1, …`): el orden de la firma deja de importar.
