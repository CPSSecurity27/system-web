# PgRepo contra Postgres — guía para el equipo del GtD

> **De:** equipo web CPS · **Fecha:** 2026-08-03 · **Actualizada:** 2026-08-04
> **Para:** `CPSSecurity27/gateway-to-device`
> **Estado (2026-08-04):** el enlace se lideró desde acá y **`PgRepo` /
> `PgListener` ya están implementados en el repo del GtD** (rama
> `feat/pgrepo-enlace-web`), contra la firma v2 de este documento. Las 8
> preguntas del doc 06 quedaron resueltas — la tabla de decisiones está en
> `contrato-gtd-postgres.md` §15. Esta guía queda como referencia del contrato.
>
> Este documento es autosuficiente: con esto alcanza para entender `PgRepo` sin
> mirar nuestro esquema.

---

## 1. Lo que cambió respecto de su `001_init.sql`

**`panel_state` y `eventos` no existen.** Sus datos van derecho a nuestras tablas
(`device_state` y `event`), traducidos adentro de las funciones. Si las
importábamos tal cual quedaban dos estados vivos y dos historiales de eventos,
libres de contradecirse.

`commands` y `panel_config` **sí existen**, prácticamente como las escribieron,
en un esquema `gtd`. Más dos nuestras: `config_espejo` (el `cfg_full` que reportan)
y `uplink_raw` (dead letter).

**Ustedes no tocan ninguna tabla.** Llaman funciones. Y no es un acuerdo de
caballeros: el rol `cps_alarms` **no tiene INSERT ni UPDATE** sobre `device_state`
ni `event` — solo `EXECUTE` sobre ocho funciones. Si intentan un INSERT directo,
Postgres los frena.

Por qué: así un cambio de mapeo es una migración nuestra y no un deploy coordinado
de dos servicios.

**Sus pipelines no se tocan.** Las ocho funciones son 1:1 con los ocho métodos de
su `Protocol Repo`. `PgRepo` es un envoltorio de una línea por método.

---

## 2. Conexión

```
GTD_PG_DSN=postgresql://cps_alarms:<clave>@<host>:5432/cps_security_v2
```

**Postgres directo, sin pooler** (respuesta a P2-6). Si algún día aparece un
pgbouncer en el medio, avisamos ANTES del deploy y el `PgListener` se lleva un
DSN directo aparte: `LISTEN` sobre un pooler en modo `transaction` falla de
forma intermitente — el peor modo de falla posible para diagnosticar a
distancia. En desarrollo (esta máquina): `localhost:5432`, sin nada en el medio.

Lo que ese rol puede hacer:

| | |
|---|---|
| ✅ `SELECT` sobre `public.*` | leer configuración, equipos, barrios |
| ✅ `INSERT` sobre `audit_log` | si quieren dejar rastro de algo |
| ✅ `EXECUTE` sobre las 8 funciones de `gtd` | **el contrato** |
| ❌ escribir `device_state` o `event` | va por las funciones |
| ❌ tocar las tablas de `gtd` | va por las funciones |
| ❌ resolver eventos | eso lo hace un humano en el panel |

### Lo primero que hay que hacer con asyncpg

Registrar el códec de `jsonb`. Sin esto, cada `dict` que manden llega como texto y
las funciones fallan o guardan basura. Es el error número uno.

```python
import json
import asyncpg

async def _init_conn(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )

pool = await asyncpg.create_pool(dsn, init=_init_conn, min_size=1, max_size=5)
```

---

## 3. Las ocho funciones

Todas devuelven un `text` de resultado (o `boolean` donde corresponde) **en vez de
tirar excepción**: una excepción en Postgres mata la transacción y con ella su
pipeline. Si les vuelve algo que no es `'ok'`, es información, no una falla que
haya que reintentar.

### 3.1 `upsert_panel_state` (firma v2, 2026-08-04)

```sql
gtd.upsert_panel_state(
  p_mac          TEXT,
  p_estado       TEXT     DEFAULT NULL,  -- 'online' | 'durmiendo' | 'offline'
  p_modo_energia TEXT     DEFAULT NULL,
  p_alarma_mode  TEXT     DEFAULT NULL,
  p_cfg_v        BIGINT   DEFAULT NULL,
  p_rf_gen       BIGINT   DEFAULT NULL,
  p_energia      JSONB    DEFAULT NULL,
  p_fw           TEXT     DEFAULT NULL,  -- P2-5: del status, directo
  p_despierta    BIGINT   DEFAULT NULL,  -- epoch s: hasta cuándo duerme
  p_ts_device    BIGINT   DEFAULT NULL,  -- el reloj que el panel DECLARA (epoch s)
  p_tsq          SMALLINT DEFAULT NULL,  -- calidad de ese reloj (0..4)
  p_seen         BOOLEAN  DEFAULT TRUE   -- false = watchdog (el panel NO habló)
) RETURNS TEXT   -- 'ok' | 'unknown_device'
```

Cambios v2 (las respuestas a su doc 06):

- **`p_estado` reemplaza a `p_online`** (P1-4): manden el `estado` del canal
  `status` tal cual. `'durmiendo'` + `p_despierta` fijan `device_state.sleep_until`
  — "duerme hasta las 7" deja de parecer "se cayó a las 3 AM". `online` lo
  derivamos nosotros.
- **`p_last_seen` YA NO EXISTE** (P1-3, tenían razón): `last_seen = now()` del
  servidor, adentro de la función. El reloj declarado va en `p_ts_device` +
  `p_tsq`, para auditar deriva.
- **`p_seen => false`** es para su watchdog de presencia: marca offline SIN
  tocar `last_seen` (el panel no habló — mentirlo escondería la caída).
- Llamen con **notación nombrada** (`p_mac => $1, …`), como propusieron en
  P2-5: el orden deja de importar.

> ### `NULL` significa "no tocar", NO "poner en NULL"
> Es la semántica de su `Repo` (`| None = None`) y está implementada con
> `COALESCE`. Manden `None` en todo lo que ese mensaje no traiga. Un `status` sin
> voltajes **no borra** el último `vbat` conocido — que es justo el dato que sirve
> para saber por qué se cayó un equipo.

`p_energia` es el objeto tal cual: `{"vbat":12.60,"vpanel":18.30,"vfuente":13.80}`.
Lo abrimos nosotros. `modo` adentro de `energia` lo ignoramos: usen `p_modo_energia`.

Efectos que no se ven en la firma y conviene que sepan:

- **Sella la primera conexión** del equipo si era la primera vez (queda marcada
  como observada por el broker, no cargada a mano).
- Si `p_cfg_v` alcanza a la config pendiente, **la marca aplicada**.
- Si `p_cfg_v = 0` habiendo config guardada, **la marca `stale`**: es el caso
  post-`factory` y hace que `fetch_pending_config` la vuelva a entregar.

### 3.2 `insert_evento`

```sql
gtd.insert_evento(
  p_mac     TEXT,
  p_tipo    TEXT,     -- alarma | ack | scan | ota | cfg_full | rf_rx | audit | …
  p_payload JSONB,    -- el mensaje COMPLETO, sin recortar
  p_eid     TEXT   DEFAULT NULL,
  p_ts      BIGINT DEFAULT NULL
) RETURNS BOOLEAN     -- FALSE = el eid ya existía (duplicado)
```

**`false` significa duplicado y nada más.** Es el dedup que pidieron, con
`ON CONFLICT DO NOTHING RETURNING` sobre un índice único parcial `(equipo, eid)`.
Cubre la redistribución QoS 1 dentro de una sesión, que es exactamente lo que hay
que cubrir.

Manden el payload **entero**. De ahí sacamos `mode`, `origin`, `dni`, `tsq`,
`prev`, `codigos`. Si recortan, perdemos datos que hoy no usamos y mañana sí.

Qué hace con cada `tipo`:

| `tipo` | Destino |
|---|---|
| `alarma` | crea el evento del negocio (lo que ve el monitoreo) |
| todo lo demás | `gtd.uplink_raw`, sin perderse nada |

Casos que devuelven `true` aunque **no** creen un evento — no son errores y **no
hay que reintentarlos**:

- **MAC desconocida** — el equipo no está dado de alta de nuestro lado.
- **Equipo sin barrio** — está en inventario, todavía no instalado.
- **Desarme** (`mode:"off"`) — ver §5.3.

### 3.3 `confirm_command`

```sql
gtd.confirm_command(p_cid TEXT, p_res TEXT DEFAULT NULL, p_det TEXT DEFAULT NULL)
RETURNS TEXT   -- 'ok' | 'unknown_cid'
```

Del `up t:ack`. `p_res = 'ok'` cierra bien, cualquier otra cosa cierra en error.

### 3.4 `upsert_config_espejo`

```sql
gtd.upsert_config_espejo(p_mac TEXT, p_cfg_v BIGINT, p_payload JSONB)
RETURNS TEXT   -- 'ok' | 'unknown_device'
```

Arbitra por `cfg_v` como pidieron: **no pisa el espejo con una versión más vieja**
que la guardada.

Esta función es más importante de lo que parece. El espejo es **la única fuente
confiable de qué configuración está corriendo**, porque los clamps del firmware
recortan en silencio y ackean `ok`. Y es la base del merge (§5.1): sin espejo, la
web **no puede** publicar un patch parcial.

De paso completamos la versión de firmware desde `id.fw` y la generación RF desde
`rf.gen` — son el único lugar donde esos dos datos viajan.

### 3.5 Bajada

```sql
gtd.fetch_pending_commands(p_mac TEXT)  -- setof (cid TEXT, tipo TEXT, payload JSONB)
gtd.mark_command_sent(p_cid TEXT)       -- 'ok' | 'unknown_cid'

gtd.fetch_pending_config(p_mac TEXT)    -- 0 o 1 fila (cfg_v BIGINT, payload JSONB)
gtd.mark_config_sent(p_mac TEXT, p_cfg_v BIGINT)  -- 'ok' | 'noop'

-- v2 (2026-08-04):
gtd.fetch_pending_macs()                -- setof (mac TEXT, canal TEXT) — el BARRIDO (P0-1)
gtd.mark_config_failed(p_mac TEXT, p_cfg_v BIGINT, p_det TEXT)  -- 'ok' | 'noop' (P0-2)
```

`payload` de un comando **ya viene armado para publicar**: trae su `t` y su `cid`.
Publíquenlo tal cual en `av/AV-<MAC>/cmd`.

`marcar enviado` va **después** del PUBLISH, no antes. Leer no es enviar.

**El barrido** (`fetch_pending_macs`): córranlo al arrancar, al reconectar a
Postgres y al reconectar al broker — `LISTEN/NOTIFY` no tiene memoria y un
`NOTIFY` perdido no vuelve. `canal` dice por cuál pipeline despachar
(`gtd_commands` / `gtd_config`), igual que un NOTIFY normal.

**La cfg que no se pudo entregar** (`mark_config_failed`): p.ej. un payload que
no entra en los 1024 bytes del panel. Ni mientan con `mark_config_sent` ni la
dejen `pending`: `failed` + detalle corta el loop de NOTIFY, y si la web
republica, la fila vuelve a `pending` con el detalle limpio.

---

## 4. `PgRepo` de referencia

> **2026-08-04:** el `PgRepo` REAL ya vive en el repo del GtD
> (`src/gtd/db/repo.py`), con reintentos con backoff y spool para el canal `up`.
> Lo de abajo queda como referencia mínima del mapeo — si difieren, manda el
> código del repo.

```python
import json
from typing import Any

import asyncpg


class PgRepo:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: asyncpg.Pool | None = None

    async def start(self) -> None:
        async def init(conn: asyncpg.Connection) -> None:
            await conn.set_type_codec(
                "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
            )

        self._pool = await asyncpg.create_pool(
            self._dsn, init=init, min_size=1, max_size=5
        )

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    # ── uplink ──────────────────────────────────────────────────────────
    async def upsert_panel_state(
        self, mac: str, *, estado: str | None = None,
        modo_energia: str | None = None, alarma_mode: str | None = None,
        cfg_v: int | None = None, rf_gen: int | None = None,
        energia: dict[str, Any] | None = None, fw: str | None = None,
        despierta: int | None = None, ts: int | None = None,
        tsq: int | None = None, seen: bool = True,
    ) -> None:
        # Notación NOMBRADA (P2-5): el orden de la firma deja de importar.
        # Los NULL son significativos ("no tocar"), así que van todos.
        await self._pool.fetchval(
            """SELECT gtd.upsert_panel_state(
                 p_mac => $1, p_estado => $2, p_modo_energia => $3,
                 p_alarma_mode => $4, p_cfg_v => $5, p_rf_gen => $6,
                 p_energia => $7, p_fw => $8, p_despierta => $9,
                 p_ts_device => $10, p_tsq => $11, p_seen => $12)""",
            mac, estado, modo_energia, alarma_mode, cfg_v, rf_gen,
            energia, fw, despierta, ts, tsq, seen,
        )

    async def insert_evento(
        self, mac: str, tipo: str, payload: dict[str, Any],
        *, eid: str | None = None, ts: int | None = None,
    ) -> bool:
        return await self._pool.fetchval(
            "SELECT gtd.insert_evento($1,$2,$3,$4,$5)", mac, tipo, payload, eid, ts
        )

    async def confirm_command(
        self, cid: str, *, res: str | None = None, det: str | None = None
    ) -> None:
        await self._pool.fetchval(
            "SELECT gtd.confirm_command($1,$2,$3)", cid, res, det
        )

    async def upsert_config_espejo(
        self, mac: str, cfg_v: int, payload: dict[str, Any]
    ) -> None:
        await self._pool.fetchval(
            "SELECT gtd.upsert_config_espejo($1,$2,$3)", mac, cfg_v, payload
        )

    # ── downlink ────────────────────────────────────────────────────────
    async def fetch_pending_commands(self, mac: str) -> list[dict[str, Any]]:
        rows = await self._pool.fetch(
            "SELECT * FROM gtd.fetch_pending_commands($1)", mac
        )
        return [dict(r) for r in rows]

    async def fetch_pending_config(self, mac: str) -> dict[str, Any] | None:
        row = await self._pool.fetchrow(
            "SELECT * FROM gtd.fetch_pending_config($1)", mac
        )
        return dict(row) if row else None

    async def mark_command_sent(self, cid: str) -> None:
        await self._pool.fetchval("SELECT gtd.mark_command_sent($1)", cid)

    async def mark_config_sent(self, mac: str, cfg_v: int) -> None:
        await self._pool.fetchval("SELECT gtd.mark_config_sent($1,$2)", mac, cfg_v)
```

### El listener

Los canales y el payload quedaron **como los tenían**:

| Canal | Payload | Quién escucha |
|---|---|---|
| `gtd_commands` | la MAC (12 hex mayúsculas, sin `:`) | ustedes |
| `gtd_config` | la MAC | ustedes |
| `app_panel_state` | la MAC | nosotros |

`app_panel_state` ahora se emite **solo ante cambio real** (`online`, modo de
alarma, `cfg_v`, `rf_gen`, modo de energía) — implementamos su propuesta. No
notifica por voltaje ni por "visto por última vez": para eso el tablero consulta.

**Un `NOTIFY` puede perderse** si el listener estaba reconectando. Al levantar la
conexión, hagan un barrido inicial de pendientes en vez de confiar solo en el
evento. La cola no se vacía sola.

---

## 5. Cosas que no se adivinan

### 5.1 La MAC es la clave, siempre

12 hex **mayúsculas**, sin `:`. Nunca el `AV-<MAC>` del tópico — la traducción la
hacemos nosotros. Si mandan minúsculas no van a matchear.

### 5.2 `ts` y `last_seen` en segundos

Epoch en **segundos**, `BIGINT`, como los tiene su `Repo`. Si mandan milisegundos
vamos a guardar fechas del año 56000 y nadie se va a dar cuenta por un tiempo.

### 5.3 El desarme no cierra el evento

Un `t:alarma` con `mode:"off"` **no crea ni resuelve** ningún evento. Apagar la
sirena no es "el incidente terminó": el cierre es una decisión operativa con autor,
y la toma un humano en el panel de monitoreo.

Ustedes no cambian nada — sigan mandándolo por `insert_evento` como cualquier
alarma. Devuelve `true`, queda registrado con su `ts` y su `dni`, y el estado vivo
lo refleja al instante.

### 5.4 El `dni` es nuestro y vuelve a nosotros

Lo cargamos en la base RF del panel y nos vuelve en la alarma; con eso resolvemos
vecino, teléfono y vivienda. Confirmamos lo que nos dijeron: el panel no dispara
con un código que no tiene, así que **no esperamos `dni` desconocidos**.

### 5.5 El watchdog de presencia se queda donde está

**No lo muevan a un cron SQL.** Que viva dentro del TaskGroup de la conexión MQTT
es correcto: si el GtD pierde el broker, muere con él. Un cron en la base marcaría
**toda la flota offline** cuando el caído es el gateway. Su medición sobre
Starlink nos convenció, y por eso tampoco hicimos una función `mark_offline`
aparte: su llamada a `upsert_panel_state(mac, online=False)` ya alcanza.

---

## 6. Cómo probar sin una placa

Con el rol `cps_alarms`, contra la base de desarrollo:

```sql
-- Un equipo que no existe: devuelve 'unknown_device' y NO explota
SELECT gtd.upsert_panel_state('FFFFFFFFFFFF', true);

-- Un tele completo
SELECT gtd.upsert_panel_state(
  'A842E38FCA6C', true, 'ACTIVE_240', 'off', 7, 3,
  '{"vbat":12.60,"vpanel":18.30,"vfuente":13.80}'::jsonb, 1700000000);

-- "NULL = no tocar": esto NO debe borrar el vbat de arriba
SELECT gtd.upsert_panel_state('A842E38FCA6C', p_alarma_mode => 'emergency');

-- Una alarma, y el dedup: la segunda tiene que devolver FALSE
SELECT gtd.insert_evento('A842E38FCA6C', 'alarma',
  '{"mode":"emergency","origin":"rf","dni":30111222,"tsq":0}'::jsonb,
  'abc123-1', 1700000000);
SELECT gtd.insert_evento('A842E38FCA6C', 'alarma',
  '{"mode":"emergency","origin":"rf","dni":30111222,"tsq":0}'::jsonb,
  'abc123-1', 1700000000);   -- false
```

Nosotros lo corrimos con 14 casos contra la base real, incluidos el dedup, el
"NULL = no tocar", el desarme y el `factory`. Los 14 pasan.

Si algo cae en el dead letter y quieren ver por qué, está todo ahí:

```sql
SELECT mac, tipo, resultado, received_at
  FROM gtd.uplink_raw ORDER BY id DESC LIMIT 20;
```

`resultado` dice qué pasó: `unknown_device`, `orphan` (equipo sin barrio),
`sin_destino` (tipo que todavía no mapeamos) o `desarme`.

---

## 7. Lo que les pedimos

1. **Los cuatro tipos que descartan** — `rf_rx`, `rf_rx_end`, `audit`,
   `audit_detalle`. Se ofrecieron a agregarlos y **los vamos a necesitar**: son los
   que alimentan la pantalla de alta de controles RF. No es urgente esta semana;
   mientras tanto caen en `uplink_raw` sin romper nada. Cuando los agreguen,
   mándenlos por `insert_evento` como cualquier otro: el destino lo decidimos
   nosotros.
2. **`fw` en `upsert_panel_state`** — hoy la versión de firmware solo nos llega por
   el `cfg_full`, que puede tardar. Si le agregan un parámetro `fw`, lo tomamos.
   Es lo único que nos falta de su `Repo` para las campañas de OTA.
3. **El `SALT_MQTT`** (PA4). Sigue siendo lo único que bloquea el alta masiva por
   derivación. Vamos a probar el camino completo con el interín de
   `PANEL_PASSWORD` explícita.
4. **`MQTT_IN_PAYLOAD_MAX = 1024`** — nos preocupa igual que a ustedes. Ya
   descartamos del `cfg` que baja las secciones de solo lectura (`id`, `rf`, `cal`)
   para no gastar presupuesto al pedo. Cuando haya una placa, probemos juntos una
   cfg de 5 redes con passwords largas.

## 8. Lo que arreglamos de lo que marcaron

- **`NOTIFY` por heartbeat**: filtrado por cambio real, como propusieron.
- **`av/all/cmd`**: no lo usamos. De acuerdo con sacar el permiso de escritura de
  la ACL del usuario `gateway` — que quede impuesto por el broker y no por
  disciplina.
- **`red_av` vs `red_avanzada`**: usamos `red_avanzada` en los dos sentidos.
- **Merge por sección**: la web mergea contra el espejo y emite `modulos`,
  `central` y `redes` **siempre completos**. Y si no hay espejo, **rechaza el
  patch** en vez de adivinar, como recomendaron.
- **`cfg_v` estrictamente mayor**: nunca republicamos la misma versión.

## 9. Lo que sigue abierto de nuestro lado

- **Cifrado en reposo** (su DT2). Las passwords WiFi de `panel_config` y los
  códigos RF de `commands` están **en claro** hoy. Cuando lo implementemos, el
  descifrado va a pasar adentro de `fetch_pending_config` /
  `fetch_pending_commands`: para ustedes no cambia nada, van a seguir recibiendo el
  payload listo para publicar.
- **`central` no vuelve en el `cfg_full`** (el bug de firmware que levantaron).
  Mientras tanto no podemos verificar que alias/ubicación/grupo se aplicaron.

---

**Contacto y detalle completo:** `docs/contrato-gtd-postgres.md` en el repo
`CPSSecurity27/system-web`. Ahí está el porqué de cada decisión; esto es el cómo.
