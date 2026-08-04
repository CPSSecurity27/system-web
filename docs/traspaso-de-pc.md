# Traspaso — dónde está todo (2026-08-03)

> Para retomar el trabajo en otra máquina sin perder contexto.
> El **setup** paso a paso está en `puesta-en-marcha-local.md`; esto es lo que ese
> documento no dice: en qué estado quedó el proyecto, qué se decidió y por qué, y
> qué está esperando a quién.

---

## 1. En la máquina nueva

Seguí `puesta-en-marcha-local.md` completo. Tres correcciones a ese instructivo,
aprendidas en esta tanda:

- **El paso 6 quedó corto**: `migration:run` ya no aplica 3 migraciones sino
  **12**. Las dos últimas (`GtdBridgeSchema`, `GtdBridgeFunctions`) crean el
  esquema `gtd`. La lista completa está en `backend-nestjs/docs/migraciones.md`.
- **`roles-conexion-v2.sql` cambió** y ahora es indispensable correrlo: le saca a
  `cps_alarms` la escritura directa sobre `device_state` y `event`, y reparte los
  `EXECUTE` de las funciones. Si no lo corrés, el contrato con el GtD no está
  impuesto por nada.
- **`psql` se cuelga pidiendo la clave** si la invocás sin `PGPASSWORD`. En
  PowerShell: `$env:PGPASSWORD = "<clave>"` antes de llamarlo.

### Credenciales de desarrollo

| Qué | Valor |
|---|---|
| Usuario OWNER institucional | `cps_root` |
| Usuario ADMIN humano | `ale_copa` (mail `cps27sp@gmail.com`) |
| Clave de los dos | `asdfghjklñ` |
| Rol de app / clave | `cps_web` / `CpsWeb2026!` |
| Rol del servicio de alarmas | `cps_alarms` / `CpsAlarms2026!` |
| Base | `cps_security_v2` |

Son **claves de desarrollo**. `.env` no se commitea: hay que rehacerlo en la
máquina nueva (paso 4 del instructivo), incluidos `JWT_SECRET` y
`REMOTE_CODES_KEY` **generados de cero**.

> Si la clave tiene un carácter no ASCII (la `ñ`), **no la pases por línea de
> comandos** en Windows: se mutila en silencio y terminás con un hash que no
> corresponde a lo que creés. Pasala por archivo o por el formulario.

### Datos de demo

La base local tiene tres alarmas de prueba en "Barrio Parque Los Aromos"
(`AV-A842E38FCA6C/70/74`) con estado vivo cargado, para poder ver la pestaña de
estado. Se borran así:

```sql
DELETE FROM device WHERE serial LIKE 'AV-A842E38FCA%';
DELETE FROM neighborhood WHERE code = 'AROMOS';
DELETE FROM account WHERE name = 'Consorcio Los Aromos (demo)';
DELETE FROM locality   WHERE georef_id = 'SEED-L';
DELETE FROM department WHERE georef_id = 'SEED-D';
DELETE FROM province   WHERE georef_id = 'SEED-P';
```

En la máquina nueva la base arranca vacía: si querés los datos de demo, hay que
sembrarlos de nuevo.

---

## 2. Qué se hizo en esta tanda

### El puente con el GtD (lo grande)

El **GtD** (`CPSSecurity27/gateway-to-device`) es el servicio de alarmas: un
puente Python entre los paneles ESP32 y Postgres. Comparte con la web **una sola
base y nada más**.

**Decisión central: contrato por FUNCIONES.** El GtD no toca ninguna tabla —
llama funciones del esquema `gtd`, y adentro de cada una decidimos a qué tabla va
cada cosa. Así un cambio de mapeo es una migración nuestra y no un deploy
coordinado de dos servicios.

Y no es un acuerdo de caballeros: las funciones son `SECURITY DEFINER` y
`cps_alarms` **no tiene INSERT/UPDATE** sobre `device_state` ni `event`.

**Las 8 funciones de entrada son 1:1 con su `Protocol Repo`.** Esto se corrigió
sobre la marcha: la primera idea era una función por tópico MQTT
(`ingest_status/tele/up`), pero al leer `src/gtd/db/repo.py` resultó que sus
pipelines **ya normalizan** — funciones por tópico los habrían obligado a
reescribirlos. Hay 4 funciones más, de salida, para la web.

Estado: **implementado y probado** contra la base (14 casos, más el up/down de
las migraciones). Falta el `PgRepo` del lado de ellos.

### La pestaña de estado en vivo

Ficha de la alarma con dos pestañas; la nueva muestra conexión, alimentación
(vbat/vpanel/vfuente) y qué tiene cargado (firmware, `cfg_v`, generación RF).
Se refresca sola cada 20 s, y solo con la pestaña abierta.

Distingue **tres** situaciones en vez de una: "nunca conectó" (sale de
`firstConnectionAt`), "sin datos" (el GtD todavía no escribe) y **"este dato
puede estar viejo"** — figura online pero hace más de 15 min que no habla, que es
lo que pasa si se cae el gateway y nadie marca offline.

Verificada en Chromium con los tres casos.

---

## 3. Hallazgos que cambian el alcance

**La base RF la carga el servidor.** El control remoto transmite un código de 64
bits y nada más; el panel lo busca en su base RF local y de ahí saca el `dni`. Esa
base la carga **la web** con `cmd t:rf op:batch`. Consecuencia dura: **un código
que no está en el panel no dispara nada** — ni evento, ni log remoto. Sin ese
flujo, un barrio tiene alarmas instaladas que no suenan. Hay una función
(`gtd.enqueue_rf_batch`) pero **nadie la llama todavía**.

No puede ser SQL puro: `remote_code.code_encrypted` es AES-256-GCM y la base nunca
ve el claro, así que el descifrado tiene que pasar en NestJS.

**El merge del `cfg` es por SECCIÓN, no por campo.** Mandar
`{"modulos":{"rf":true}}` **apaga** ds3231, eeprom y supervisor — sin error y con
ack `ok`. Por eso `publish_config` mergea contra el espejo y **rechaza el patch si
el panel nunca reportó su `cfg_full`**.

**`tsq` es 0..4 y MENOR ES MEJOR** (0=NTP, 4=sin sync). Con `tsq >= 2` hay que
ordenar por la hora del servidor.

**`cfg_v` es estrictamente mayor**, y el rechazo es silencio total: republicar la
misma versión es un no-op sin ack.

---

## 4. Bloqueado y esperando

| # | Qué | De quién |
|---|---|---|
| 1 | **`SALT_MQTT` de producción** (PA4). Bloquea el alta masiva de equipos por derivación. Algoritmo cerrado: `HMAC-SHA256(SALT_MQTT, MAC_STA)[0..11]` → 24 hex, sin prefijo. Interín: `PANEL_PASSWORD` explícita por MAC, alcanza para probar con una placa | acción humana |
| 2 | **`PgRepo` / `PgListener`** en Python | equipo GtD |
| 3 | `rf_rx`, `rf_rx_end`, `audit`, `audit_detalle` en su `UpType` — alimentan la pantalla de alta de controles RF | equipo GtD |
| 4 | `fw` como parámetro de `upsert_panel_state` (hoy solo llega por el `cfg_full`) | equipo GtD |
| 5 | **Cifrado en reposo** de `gtd.panel_config` (passwords WiFi) y `gtd.commands` (códigos RF) — DT2 | nuestro |
| 6 | **`central` no vuelve en el `cfg_full`**: no se puede verificar que alias/ubicación/grupo se aplicaron. Bug de firmware, ya levantado | firmware |
| 7 | `MQTT_IN_PAYLOAD_MAX = 1024`: una cfg con 5 redes puede no entrar en el panel. Sin probar | probar con placa |
| 8 | **Umbrales de batería PROVISORIOS** (12,0 V baja / 11,8 V crítica). Salen del comportamiento de una plomo-ácido de 12 V, **no** de la especificación real. Validar antes de que alguien salga a la calle por una alerta | nuestro |

---

## 5. Lo que sigue, en orden

1. **Modelar la configuración por barrio.** Es el camino crítico de la pantalla de
   configuración y **no depende del GtD**: hoy no existe tabla para las redes WiFi
   del barrio ni para los defaults de `modulos`, `tiempos.send_tele_s`,
   `alarma.autooff` y `red_avanzada`.
2. **El flujo de la base RF** (punto 3 de arriba). Es lo que hace que las alarmas
   suenen; sin esto lo demás es decorado.
3. **Pantalla de configuración**, cuando haya un panel real reportando `cfg_full`.
4. Ampliar `GET /devices/:id/state` si se quiere más, y evaluar push por
   `NOTIFY app_panel_state` en vez del polling de 20 s.

---

## 6. Mapa de documentos

| Documento | Para qué |
|---|---|
| `docs/estado-proyecto.md` | dónde está parado el proyecto — **empezar por acá** |
| `docs/contrato-gtd-postgres.md` | el puente con el GtD: el diseño y **el porqué** de cada decisión |
| `docs/gtd-guia-implementacion.md` | **para entregarle al equipo del GtD**: cómo usar las funciones, con `PgRepo` de referencia en asyncpg |
| `docs/esquema-postgres-v2.sql` | el DDL completo (§13 = esquema `gtd`, §14 = roles) |
| `docs/roles-conexion-v2.sql` | script idempotente de roles y permisos |
| `docs/negocio-redisenado.md` | cómo funciona el negocio |
| `docs/diseno-relaciones-fase1.md` | el diseño del modelo |
| `docs/puesta-en-marcha-local.md` | levantar todo desde cero |
| `backend-nestjs/docs/migraciones.md` | qué hace cada migración |

---

## 7. Trampas que costaron tiempo

- **`REVOKE ... FROM <rol>` no alcanza en funciones.** Postgres le da `EXECUTE` a
  `PUBLIC` por defecto en toda función nueva, así que revocarle a un rol puntual
  no hace nada: lo sigue teniendo por `PUBLIC`. Hay que
  `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA gtd FROM PUBLIC`. Se descubrió
  probando de verdad con el rol, no leyendo el código.
- **`[hidden]` no funciona sobre un `.row` de Bootstrap.** `display: flex` es
  estilo de autor y le gana al `display: none` del user-agent. Va `d-none`, que
  lleva `!important`.
- **En PL/pgSQL no existe `v := expr FROM tabla`.** Va `SELECT expr INTO v FROM …`.
- **`a || b` en JSONB da NULL si `b` es NULL.** Todo parámetro `jsonb` opcional
  necesita su `COALESCE`.
- **Los `numeric` y `bigint` vuelven como STRING** por el driver de pg. En el
  front hay que parsearlos.
- **asyncpg necesita el códec de `jsonb` registrado** o los `dict` llegan como
  texto. Es el error número uno para el equipo del GtD; está avisado en su guía.
