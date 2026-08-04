# Configuración por equipo — diseño (2026-08-04)

> Segunda mitad del enlace con el GtD. El plan 1 dejó la cañería (el contrato por
> funciones, `publish_config`, el merge contra el espejo). Esto es lo que falta
> para que un humano pueda configurar una alarma desde la web.

---

## 1. Qué se construye

Una pestaña **Configuración** en la ficha del equipo, con todo lo que el panel
acepta: redes WiFi, módulos, tiempos, hora, auto-off por modo de alarma, roaming
y mantenimiento. Más los endpoints que la sostienen y dos funciones SQL nuevas.

**Qué NO se construye** (y por qué): no hay configuración por barrio. Ver §2.

---

## 2. Las cinco decisiones tomadas

### 2.1 La configuración es POR EQUIPO, sin capa de barrio

Cada panel lleva su configuración completa e independiente. No existe una tabla
de defaults del barrio de la que los equipos hereden.

**Por qué.** Cada equipo reporta su estado individualmente y se configura
individualmente; una capa de herencia obligaría a preguntar "¿este valor es del
barrio o lo pisó el equipo?" en cada campo de cada pantalla, y a resolver qué
pasa cuando cambia el default de un barrio con 40 postes ya configurados.

**El costo asumido**: cargar 40 postes con el mismo WiFi municipal es cargar 40
veces. Se mitiga con **"Copiar configuración de otro equipo"** (§5.4), que
precarga el formulario desde otro panel. Son copias independientes: no queda
vínculo, y cambiar el original no toca a las copias.

### 2.2 Quién puede editar: quien OPERA el barrio

| Rol | Ver | Editar | Ver passwords WiFi |
|---|---|---|---|
| CPS (ADMIN / TECHNICIAN) | sí | sí | sí (auditado) |
| ORGANIZATION con `managed_by = ORGANIZATION` | sí | sí | no |
| ORGANIZATION con `managed_by = CPS` | sí | no | no |
| MONITOR (cualquiera) | sí | no | no |

Se implementa con `ScopeService.assertManagesNeighborhood(scope, neighborhoodId)`,
que ya existe y ya codifica exactamente esta regla (CPS gestiona cualquier barrio;
la organización solo si `managed_by ≠ CPS`). Los TECHNICIAN de una organización
quedan además acotados por `staff_assignment`, que `AccessScope` ya resuelve.

**Por qué la organización edita.** Las redes WiFi de un barrio municipal son de
la municipalidad: su técnico es quien sabe la clave y quien está parado al lado
del poste. Obligarlo a pedirle a CPS que cargue un SSID sería fricción sin
seguridad — igual puede entrar por el portal cautivo local del equipo.

**Por qué las passwords son solo-CPS.** Editarlas no requiere leerlas (§5.2), así
que restringir la LECTURA no le saca capacidad a nadie. Revelar queda como acción
explícita, solo-CPS y con `audit_log`, igual que los códigos RF.

### 2.3 Enfoque A: el espejo es la verdad, no hay tabla de configuración

No se crea ninguna tabla para la configuración deseada. Ya existen las dos que
hacen falta:

- **`gtd.config_espejo`** — lo que el panel DICE que corre. La única verdad, y la
  única que sobrevive a los clamps silenciosos del firmware.
- **`gtd.panel_config`** — lo que le mandamos, con su estado (`pending`, `sent`,
  `applied`, `stale`, `failed`).

La pantalla **lee el espejo** y **escribe llamando a `gtd.publish_config`**, que
ya mergea por sección contra el espejo, versiona `cfg_v`, audita y dispara el
`NOTIFY`.

**Por qué no una tabla `device_config` tipada.** Sería un TERCER lugar donde vive
la misma configuración, libre de contradecir al espejo y a la cola. La ventaja que
daría —consultas tipo "¿qué equipos telemetran cada 60 s?"— no la necesita nadie
hoy. Si algún día hace falta, se resuelve con columnas generadas sobre el JSONB
del espejo, sin duplicar el estado.

**El formulario nunca escribe el espejo.** Se edita una copia en memoria; el
espejo solo lo escribe `gtd.upsert_config_espejo` cuando el panel reporta.

### 2.4 Confirmación en escalera: dos pasos visibles y una red silenciosa

Una configuración no se da por buena porque la mandamos. El firmware
(`task_mqtt.c:462-480`) responde así ante una `cfg`:

| Caso | Respuesta del panel |
|---|---|
| `cfg` malformada | contador interno + log local, **ningún ack** |
| `cfg_v ≤ la ya aplicada` | **ningún ack** (idempotencia deliberada) |
| La aplica | `up t:ack {cfg_v, res:"ok"}` |

Dos cosas que eso implica: **el `res` está hardcodeado en `"ok"`** (no existe ack
de error para `cfg`), y **aplicar una `cfg` no refresca el espejo de manera
confiable** — `app_roam_set`, `app_autooff_set_mode` y `app_mante_set` llaman a
`cfg_full_touch()` por dentro, pero `tiempos` usa `eeprom_nvs_mqtt_set_tele_s`
directo y no refresca. El espejo se actualiza *a veces*, según qué secciones tocó
el patch. No es una base sobre la que se pueda construir.

Por eso, tres señales:

1. **`up t:ack cfg_v`** → estado `applied`. Rápido (segundos). Significa "la
   apliqué", nunca "apliqué exactamente lo que mandaste".
2. **`cmd t:refresh` encadenado al ack** → el panel republica su `cfg_full` → el
   espejo se actualiza con lo que realmente quedó → **verificado**. Encadenado al
   ack y no disparado junto con la `cfg`, porque van por tópicos distintos y un
   refresh que gane la carrera refrescaría la configuración vieja.
3. **El `tele`, como reconciliación silenciosa** — trae `cfg_v` cada
   `send_tele_s` (default **300 s**) y es **retained**, así que el broker lo
   reentrega aunque el GtD haya estado caído. `upsert_panel_state` ya marca
   `applied` con eso: **cero código nuevo**. No aparece en la UI ni mueve
   ninguna barra de progreso; cura el estado por atrás cuando 1 y 2 se
   perdieron. Es la única de las tres con entrega durable — el `ack` y el
   `cfg_full` viajan sin retain, y `mq_pub_cfg_full` (líneas 302-309) además
   **descarta el `cfg_full` en silencio si no entra en el buffer**.

**`verified` es derivado, no un estado guardado**: `config_espejo.cfg_v >=
panel_config.cfg_v`. Un estado más en el CHECK sería un segundo lugar donde vive
el mismo hecho.

**El timeout no es un reloj ciego.** Usa `device_state.online` y `sleep_until`
(del plan 1):

| Situación | Qué muestra |
|---|---|
| Panel online, sin ack en 60 s | "sin confirmar" + botón republicar |
| Panel durmiendo | "esperando — duerme hasta las HH:MM". Sin timeout: la `cfg` va retenida y la toma al despertar |
| Panel offline | "esperando a que vuelva". Sin timeout, misma razón |

### 2.5 El scan de redes es a pedido, nunca automático

Un botón **"Buscar redes"**, más el último scan conocido con su antigüedad.

**Por qué no automático al abrir.** En `task_wifi.c:541-553` el scan interrumpe la
máquina de estados del WiFi (`WM_STATE_SCANNING`, `wifi_manager_scan()`
bloqueante, y recién después restaura). Llaman a `esp_task_wdt_reset()` justo
antes porque dura lo suficiente como para hacer saltar el watchdog. Mientras
escanea, **el panel no está siendo una alarma**. Un scan por cada apertura de
pantalla —tres personas curioseando, un F5— es un poste que deja de atender por
un adorno de formulario.

Además el resultado es asincrónico: el ack del comando dice literalmente
`"resultado por up t:scan"`, y el listado llega después por su cuenta. Una
pantalla que escanea al abrir esperaría algo que puede no llegar nunca.

---

## 3. Lo que se agrega al contrato SQL

Dos funciones. Ambas `SECURITY DEFINER`, en el esquema `gtd`.

### 3.1 `gtd.confirm_config(p_mac, p_cfg_v, p_res, p_det) RETURNS TEXT`

**Para `cps_alarms`.** Hoy el ack de una `cfg` no trae `cid`, así que el GtD lo
manda por `insert_evento` y cae en el dead letter como `sin_destino`: la
confirmación existe y la estamos tirando.

Hace tres cosas:
1. Marca `gtd.panel_config` en `applied` si `cfg_v` coincide.
2. **Encola sola el `cmd t:refresh`** (vía la misma lógica que `enqueue_command`),
   para que el espejo se actualice sin que el GtD tenga que saber nada.
3. Devuelve `'ok'` | `'unknown_device'` | `'noop'` (cfg_v que no corresponde).

Que el encadenado viva en Postgres y no en Python es lo mismo que ya decidimos
para todo el contrato: el mapeo es una migración nuestra, no un deploy de ellos.

### 3.2 `gtd.last_scan(p_device_id) RETURNS TABLE (redes JSONB, received_at TIMESTAMPTZ)`

**Para `cps_web`.** Devuelve el último `up t:scan` del equipo. No necesita tabla
nueva: los scans **ya se están guardando** en `gtd.uplink_raw` (todo lo que no es
`alarma` cae ahí con el payload completo). La función existe para que la
intención quede explícita y para poder cambiar el almacenamiento después sin
tocar la web.

El panel manda hasta **20 redes** con `ssid`, `rssi`, `seg`, `ch` y `guardada`
(si ya está en las credenciales del panel).

---

## 4. Endpoints

Todos en `DevicesController`, todos con el checklist de `permisos-check`.

| Método | Ruta | Quién | Qué hace |
|---|---|---|---|
| `GET` | `/devices/:id/config` | ve el barrio | Espejo (sin passwords) + estado de la cola + último scan + capacidades |
| `PUT` | `/devices/:id/config` | **gestiona** el barrio | Valida el patch y llama `gtd.publish_config` |
| `POST` | `/devices/:id/config/scan` | gestiona | `gtd.enqueue_command(id, 'scan')` |
| `POST` | `/devices/:id/config/refresh` | gestiona | `gtd.enqueue_command(id, 'refresh')` — pedir la configuración actual |
| `POST` | `/devices/:id/config/reveal-wifi` | **solo CPS** | Devuelve las passwords en claro. `audit_log` obligatorio |

**No hay endpoint de mantenimiento.** `mante.on` es una sección de la `cfg` (no
existe `cmd t:mante` en el catálogo del firmware), así que viaja por el mismo
`PUT` que el resto.

### 4.1 Validación del patch (en el `PUT`)

Los límites salen del firmware, verificados:

| Campo | Límite | Fuente |
|---|---|---|
| `redes` | máximo **5** | `WIFI_MAX_PROFILES` |
| `tiempos.send_tele_s` | 30 … 86400 | `app_tele_period_set` |
| `red_avanzada.roam_rssi` | −90 … −50 | `app_roam_set` |
| `red_avanzada.roam_delta` | 5 … 30 | `app_roam_set` |
| `red_avanzada.roam_cooldown_s` | 60 … 3600 | `app_roam_set` |
| payload total | **1024 bytes** | `MQTT_IN_PAYLOAD_MAX` |

Se validan **de nuestro lado** aunque el firmware clampe, porque el firmware
clampa **en silencio y ackea `ok`**: sin esta validación, el usuario pide 5 s de
telemetría, la pantalla dice "aplicado" y el equipo quedó en 30. El error va con
el valor efectivo ("el mínimo es 30 s").

El chequeo de 1024 bytes se hace sobre el payload ya mergeado que devuelve
`publish_config`, y es un 400 con el tamaño real — no un `failed` descubierto
media hora después.

### 4.2 Errores

| Situación | Respuesta |
|---|---|
| Sin espejo | **409**: "el equipo nunca reportó su configuración". La UI ofrece **Pedir configuración al equipo** (`/config/refresh`), que es el desbloqueo |
| Patch fuera de rango | 400 con el límite y el valor efectivo |
| Payload > 1024 B | 400 con el tamaño |
| Equipo sin MAC / sin barrio | 409 |
| No gestiona el barrio | 403 con el mensaje de `assertManagesNeighborhood` |

---

## 5. La pantalla

Tercera pestaña de la ficha del equipo, junto a **Ficha** y **Estado en vivo**.

### 5.1 Secciones

**Editables:** Redes WiFi (hasta 5, ordenadas por prioridad) · Módulos (ds3231,
eeprom, supervisor, rf + slot de eeprom) · Tiempos (`send_tele_s`) · Hora
(`tz_offset_s`) · Auto-off por modo de alarma · Red avanzada (roaming) ·
Mantenimiento (`mante.on`).

**Solo lectura, con su explicación:** Identidad (`central`: alias, ubicación,
grupo — **se generan** desde el nombre del equipo y el `code` del barrio, no se
tipean) · RF (`total_codigos`, `gen` — se tocan con `cmd t:rf`) · Calibración
(`cal` — se toca con `cmd t:cal`) · Firmware (`id.fw`).

Apagar un módulo pide confirmación nombrando la consecuencia (apagar `rf` deja al
panel sordo a los controles remotos).

### 5.2 Passwords

El `GET` nunca las devuelve: cada red viaja con `tienePassword: true`. Al guardar,
una red existente sin password nueva **conserva la que tiene** (el merge la toma
del espejo del lado del servidor). Así se edita sin leer, y el único camino a la
lectura es `/config/reveal-wifi`, solo-CPS y auditado.

### 5.3 Estado de la publicación

Barra sobre el formulario que dice la verdad en cada momento:

- *Sin cambios pendientes · verificado contra el equipo hace 3 min*
- *Enviada, esperando confirmación…* (con el contexto del timeout de §2.4)
- *Aplicada — verificando qué quedó…* (entre el ack y el `cfg_full`)
- *No se pudo entregar: {detalle}* (estado `failed`) + **Republicar**
- *El equipo nunca reportó su configuración* + **Pedir configuración**

Antes de guardar, un diff explícito: **qué campos cambian, de qué valor a cuál**.
Sin eso, "Guardar" sobre un formulario de 20 campos es un acto de fe.

### 5.4 Copiar de otro equipo

Selector de equipos del mismo barrio con espejo disponible. Precarga el
formulario (sin passwords, que no se leen) y **no guarda nada** hasta que el
usuario revise y confirme. Es un atajo de tipeo, no un vínculo.

### 5.5 Redes disponibles

Encabezado de la sección WiFi: *Redes vistas hace 5 minutos* · **[Buscar redes]**.
El botón se deshabilita con el panel durmiendo u offline, explicando por qué.

Clic en una red del listado → **autocompleta el SSID** y deja el foco en la
password. Elimina el SSID mal tipeado, que es la causa número uno de un poste que
no conecta. Las que ya están cargadas se marcan con `guardada`.

---

## 6. Qué se prueba

**Backend (unitarios + integración contra la base real):** los cinco endpoints
con los cuatro roles × `managed_by` (matriz de §2.2); el 409 sin espejo; cada
límite de §4.1 en su borde (29/30/86400/86401, −91/−90/−50/−49, 6 redes); el
payload de 1025 bytes; que el `GET` jamás devuelva una password; que
`reveal-wifi` escriba en `audit_log`; y que `PUT` sin password conserve la del
espejo.

**Las dos funciones SQL:** `confirm_config` con `cfg_v` que coincide, que no
coincide y de un equipo inexistente; que encole el `refresh` una sola vez; y
`last_scan` sin scans, con uno y con varios (devuelve el más nuevo).

**Frontend:** los cinco estados de §5.3; el diff previo al guardado; el
autocompletado desde el scan; y que el formulario quede bloqueado sin espejo.

---

## 7. Fuera de alcance

- **Configuración por barrio / plantillas.** Decisión §2.1. Si algún día se
  agrega, entra como capa de defaults *debajo* de esto, sin cambiar el modelo.
- **`cmd t:test`** (probar un SSID puntual). El firmware lo tiene y el resultado
  vuelve por el mismo `up t:scan`. Es la herramienta del técnico parado en la
  calle, no de quien configura desde la oficina.
- **Cifrado en reposo** de las passwords (DT2). Sigue abierto, y con la
  observación del GtD: cifrar Postgres no alcanza mientras la `cfg` viaje
  retenida en el broker.
- **Campañas masivas** (aplicar una configuración a N equipos de una).

---

## 8. Propuestas al firmware que salen de acá

No se implementan (el firmware no se toca), se documentan:

1. **Que `mq_apply_cfg` llame a `system_state_cfg_full_touch()` una vez al
   final**, sin condición. Hoy el refresco del espejo depende de qué setter tocó
   el patch, lo que nos obliga a encadenar un `cmd t:refresh` a cada publicación.
   Una línea allá nos ahorra un comando por cada cambio de configuración de cada
   panel de la flota.
2. **Un ack de error cuando la `cfg` no parsea.** Hoy una `cfg` malformada es
   silencio total, indistinguible de un panel dormido.
3. **Que `mq_pub_cfg_full` no descarte en silencio** cuando el documento no entra
   en el buffer (líneas 302-309): limpia el flag `dirty` y cuenta el fallo, pero
   nadie del lado servidor se entera de que el espejo quedó viejo.
