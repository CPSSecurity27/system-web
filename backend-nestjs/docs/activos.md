# Activos — alarmas comunitarias, inventario y controles remotos (v2)

## La distinción que define todo

**La alarma es del BARRIO, no de la vivienda.** Un poste con sirena en la vía
pública, compartido. La vivienda tiene **controles remotos** que disparan las del
barrio (y a lo sumo una alarma *preferida*: `home.default_device_id`, siempre del
mismo barrio).

## Cadena de custodia (v2: HAY inventario)

Igual para alarmas (`device`) y controles (`remote`):

```
FÁBRICA CPS               STOCK DE ORGANIZACIÓN         EN SERVICIO
status = INVENTORY    ->  status = INVENTORY        ->  alarma  -> barrio
organization_id NULL      organization_id = cliente     control -> hogar
```

- **Alta (fabricación): SOLO CPS** (`POST /devices`, `POST /remotes` sin destino).
  El device nace con `serial` + **`claim_code`** (único, de un solo uso).
  El alta de una alarma se hace **desde la MAC** — ver la sección siguiente.
- **Entrega del lote**: CPS mueve stock a una organización (`PATCH` de
  `organizationId`, solo válido en INVENTORY — CHECK de la base).
- **Instalación por reclamo**: `POST /devices/claim { serial, claimCode,
  neighborhoodId }`. Técnicos de CPS reclaman cualquier equipo; los de una
  organización, **solo de SU stock y para SUS barrios**. Así la muni se
  autoinstala sin que CPS pierda el control del stock. Queda en `audit_log`.
- Controles: la entrega física a una vivienda es `POST /remotes/:id/assign
  { homeId }`. Desde ahí la vivienda es dueña y el `homeId` no se toca más.
- Stock visible en `GET /devices/inventory` y `GET /remotes/inventory`
  (CPS ve todo; una organización, lo suyo).

## Alta de fábrica: desde la MAC

En la estación de flasheo se carga el equipo con **dos datos que se LEEN de la
placa** y no se inventan:

| Dato | De dónde sale |
|---|---|
| **MAC** | `esptool read_mac` — la MAC STA del eFuse, única e inmutable |
| **N° de placa** | impreso en la placa por el fabricante: `ALOY0043` |

```jsonc
POST /api/devices    // SOLO CPS
{ "mac": "A8:42:E3:8F:CA:6C", "boardNumber": "ALOY0043" }
```

El **`serial` no se manda**: se deriva como `AV-<12 hex mayúsculas>` y el CHECK
`chk_device_identity` lo impone en la base. Ese string es, a la vez, el usuario
MQTT, el client_id y el `<id>` del tópico (`av/AV-A842E38FCA6C/status`) — de que
sean el mismo string depende que la ACL del broker sea **una** regla
`pattern av/%u/…` para toda la flota en vez de cinco líneas por equipo.

El número de placa entra en **un solo campo**: el modelo va adentro del string
impreso, el backend parte `ALOY0043` en prefijo + número y resuelve el prefijo
contra `board_model`. Un campo menos en una estación donde se carga todo el día
es un error menos. Lo que se guarda es `board_model_id` + `board_seq`; el string
completo se **compone**, nunca se almacena.

**Validaciones de la MAC** (en `src/devices/mac.ts`, con tests propios):
se acepta con o sin `:`/`-` y en cualquier caja; se rechazan la de ceros (es lo
que devuelve `esptool` cuando **falla** la lectura), la de broadcast, y las
multicast (el bit 0 del primer byte prendido: una MAC STA de ESP32 nunca lo
está, así que hay un dígito mal leído).

**Avisos que NO bloquean** (`warnings` en la respuesta): el OUI del chip no
coincide con el de ningún equipo ya cargado, o hay un salto en la numeración de
placas (suele ser una placa fabricada que nunca se registró).

### El bloque `provisioning` — hoy es un log

La respuesta trae qué le falta al equipo para conectarse al broker: usuario
MQTT, los cinco tópicos, y el comando a correr en el server. **Todavía no se
registra la credencial**: la derivación `HMAC-SHA256(SALT_MQTT, MAC)` necesita el
`SALT_MQTT` de producción, que no está del lado servidor (punto abierto PA4 del
GtD). Las columnas `mqtt_provisioned_at/by` nacen vacías para no migrar filas
cuando el salt llegue, y para poder listar los equipos a medio provisionar.

## Etapas de puesta en marcha (hitos)

Entre que un equipo se da de alta y que conecta por primera vez hay pasos que
la fábrica necesita ver. **La etapa no se guarda: se DERIVA del último hito
alcanzado.** Una columna de etapa sería un segundo lugar donde vive el mismo
dato, libre de contradecir a las fechas.

| Etapa | Hito | Quién lo escribe |
|---|---|---|
| CREADO | `created_at` | el alta |
| PROVISIONADO | `mqtt_provisioned_at` | el registro de la credencial en el broker |
| ETIQUETADO | `labeled_at` | CPS, desde la fábrica |
| 1.ª CONEXIÓN | `first_connection_at` | **el servicio de alarmas** (o CPS a mano) |

`deviceStage()` evalúa de atrás para adelante y **no exige** que los anteriores
estén cumplidos: en la práctica un equipo se puede etiquetar antes de
provisionarse, y una etapa que mienta por "saltear" un paso sería peor que una
que informe hasta dónde llegó. El detalle fino lo da `milestones`, que expone
los cuatro por separado.

### Por qué `first_connection_source`

La primera conexión es un hecho **observado** por el broker — regla 5: el
estado vivo lo escribe el servicio de alarmas, no la web. Como el GtD todavía
no escribe, CPS puede marcarla a mano; en ese caso queda
`first_connection_source = 'MANUAL'`, con el autor en `first_connection_by` y
el override en `audit_log`. Un dato medido y uno cargado a dedo no valen lo
mismo, y la pantalla muestra la diferencia (ícono de mano en el badge).

Dos CHECK sostienen esto: la fecha y su origen viajan juntos o no viajan, y un
hito MANUAL siempre tiene autor.

```
PATCH /api/devices/:id/milestones   { labeled?: boolean, connected?: boolean }
```

Solo CPS. `true` sella el hito con la hora **del servidor**, `false` lo borra
(para poder deshacer un equipo cargado por error sin un UPDATE a mano). La
fecha nunca se acepta del cliente: un hito con fecha elegida por quien lo carga
deja de ser evidencia de nada.

## `board_model` — el catálogo de modelos

Una fila por modelo de placa (hoy solo `ALOY`); el `code` es **solo el prefijo**,
sin dígitos. Es catálogo y no enum para que un modelo nuevo sea un INSERT y no
una migración con deploy, y porque tarde o temprano hay que colgarle atributos
del hardware: hoy `remote_code` tiene clavado `position BETWEEN 1 AND 4` con el
comentario "el hardware tiene 4", y el día que un modelo soporte 8 ese CHECK pasa
a ser mentira.

`active = false` **discontinúa** un modelo (no se fabrica más) sin tocar los
equipos ya hechos con él. El `code` no se puede editar: los equipos componen su
número impreso con él.

```
GET   /api/devices/board-models        el desplegable
POST  /api/devices/board-models        solo CPS (OWNER/ADMIN)
PATCH /api/devices/board-models/:id    renombrar o discontinuar
```

## `device` — la alarma

Postgres guarda la **configuración** (serial, tipo, estado administrativo,
ubicación, hardware IMEI/ICCID/MAC, modelo y n° de placa, tested). `device.type`
es extensible (`COMMUNITY_ALARM` hoy; SIREN/REPEATER/SENSOR reservados y
**rechazados con 400** en el alta: una rama que nadie probó es donde se cuelan
los bugs). El `serial` es la identidad física y **no se puede cambiar**.

> Se llama `COMMUNITY_ALARM` y no "panel" a propósito: un panel es la cajita en
> la pared de una casa, que es exactamente lo que la regla 1 dice que esto no es.

El **estado vivo** (`online`, `last_heartbeat`, disparada) vive en **`device_state`**:
una fila por device, UPDATE in place, **la escribe SOLO el servicio de alarmas**
(programa aparte; GRANTs en §13 del SQL v2). La web la lee: `GET /devices/:id/state`.

Bitácora del técnico: `device_maintenance` (la cargan técnicos de CPS o de la
organización; la lee también el gestor del barrio).

## `remote` — el control

**DUEÑO ≠ PORTADOR**:

| campo | qué es |
|---|---|
| `homeId` (no se cambia una vez asignado) | la **vivienda es dueña** |
| `assignedToUserId` (nullable) | quién lo **lleva encima**; NULL = "en el cajón" |

Reglas que impone el código:

- **El cupo manda**: sin `neighborhood.remote_controls_enabled`, no hay altas.
- El portador debe ser **miembro del hogar** (`home_member` — ya no cuentas).
- La alarma del control (`deviceId`) debe ser **del mismo barrio** que la vivienda.

El titular puede reasignar el portador dentro de su casa y reportar el control
perdido (PATCH sin guard de cuenta: su permiso es la membresía de hogar).

## `remote_code` — SENSIBLE

Son los códigos RF que **ABREN LA ALARMA**. **4 por control** (M2: el hardware
tiene 4), impuesto por el esquema (`UNIQUE (remote_id, position)` + `position
BETWEEN 1 AND 4`).

- Cifrados con **AES-256-GCM** en NestJS antes de insertar (`iv (12) || authTag
  (16) || ciphertext`, IV random SIEMPRE). La base nunca ve un código en claro.
- `select: false`; nunca se loguea el valor.
- GCM es autenticado: si alguien altera un byte en la base, el descifrado FALLA
  con error de integridad (con CBC habría devuelto basura en silencio).
- La clave `REMOTE_CODES_KEY` (32 bytes base64) vive en el `.env`, no en la base.
  Si se pierde, los códigos son irrecuperables: se reprograman los controles.
  Se valida al arrancar.

### Quién ve los códigos

| | `GET /codes` (posiciones) | `GET /codes/:id/reveal` (en claro) |
|---|---|---|
| CPS (OWNER/ADMIN/TECH) | ✅ | ✅ **único que puede** |
| Gestor del barrio | ✅ | ❌ 403 |
| Titular | ✅ (los de su control) | ❌ 403 |

Cada `reveal` queda en el log (WARN) **y en `audit_log`** (quién, cuándo, qué
control y posición).

## Endpoints

```
GET    /api/devices?neighborhoodId=          instaladas, por alcance
GET    /api/devices/inventory                stock (CPS todo; org el suyo)
GET    /api/devices/:id/state                estado vivo (solo lectura)
GET    /api/devices/board-models             modelos de placa (desplegable)
POST   /api/devices/board-models             solo CPS (OWNER/ADMIN)
PATCH  /api/devices/board-models/:id         renombrar / discontinuar
POST   /api/devices                          SOLO CPS — alta desde MAC + n° de placa
POST   /api/devices/claim                    técnicos CPS/org: serial + código
PATCH  /api/devices/:id                      solo CPS; serial inmutable
PATCH  /api/devices/:id/milestones           solo CPS; etiquetado / 1.ª conexión
GET|POST|PATCH /api/devices/:id/maintenances bitácora

GET    /api/remotes?homeId=                  por alcance
GET    /api/remotes/inventory                stock
POST   /api/remotes                          CPS/gestor (con homeId) · CPS (stock)
POST   /api/remotes/:id/assign               entrega: stock -> vivienda
PATCH  /api/remotes/:id                      + titular (portador de SU casa)
GET    /api/remotes/:id/codes                posiciones, NUNCA el código
POST   /api/remotes/:id/codes                solo CPS; se cifra antes de insertar
GET    /api/remotes/:id/codes/:cid/reveal    solo CPS; auditado
DELETE /api/remotes/:id/codes/:cid           solo CPS
```

## Configuración del equipo (2026-08-04)

**No hay tabla de configuración.** `gtd.config_espejo` (lo que el panel DICE que
corre, después de los clamps silenciosos del firmware) es la verdad de lectura, y
`gtd.publish_config` el único camino de escritura. Una tabla propia sería un
tercer lugar donde vive el mismo dato, libre de contradecir al espejo y a la cola.

Diseño completo y el porqué de cada decisión:
`docs/superpowers/specs/2026-08-04-configuracion-por-equipo-design.md`.

### Quién puede qué

| Rol | Ver | Configurar | Ver passwords WiFi |
|---|---|---|---|
| CPS (OWNER/ADMIN/TECHNICIAN) | sí | sí | sí (auditado) |
| ORGANIZATION, barrio con `managed_by = ORGANIZATION` | sí | sí | no |
| ORGANIZATION, barrio con `managed_by = CPS` | sí | **no** | no |
| MONITOR (cualquiera) | sí | **no** | no |

**Los dos ejes son obligatorios y se validan por separado.** El ROL va en
`@RequireMembership(...CONFIGURAN_EQUIPOS)` del controller; el ALCANCE, en
`assertManagesNeighborhood` dentro del servicio. Con solo el segundo, un MONITOR
de la organización pasaba: tiene el barrio en su alcance y `managesNeighborhood`
responde por la CUENTA, no por el usuario. Lo agarró el e2e.

### Los límites son del firmware

Viven en `src/devices/device-config.limits.ts`, cada uno con su archivo y línea de
origen. Se validan de nuestro lado **aunque el firmware clampe**, porque el
firmware clampa en silencio y ackea `ok`: sin esto, alguien pide 5 s de telemetría,
la pantalla dice "aplicado" y el equipo quedó en 30.

| Campo | Límite |
|---|---|
| `redes` | 5 (`WIFI_MAX_PROFILES`) |
| `tiempos.send_tele_s` | 30 … 86400 |
| `red_avanzada.roam_rssi` | −90 … −50 |
| `red_avanzada.roam_delta` | 5 … 30 |
| `red_avanzada.roam_cooldown_s` | 60 … 3600 |
| payload mergeado | 1024 B (`MQTT_IN_PAYLOAD_MAX`) |

El de 1024 se mide sobre el payload **ya mergeado** (el patch solo no dice nada: el
merge le suma las secciones completas) y todo corre en una TRANSACCIÓN. Si no
entra, se revierte: como `pg_notify` es transaccional, el GtD nunca se entera del
intento y el `cfg_v` no se quema.

### Las passwords no salen

El `GET` nunca las devuelve — cada red viaja con `tienePassword`. Al guardar, una
red **sin** `psw` conserva la del espejo: el servidor la repone antes de llamar a
`publish_config` (`rehidratarPasswords`).

Eso último no es una comodidad: `publish_config` reemplaza el ARRAY ENTERO de
redes (`COALESCE(patch->'redes', base->'redes')`, no un merge red por red). Sin la
rehidratación, guardar cualquier cambio de WiFi habría borrado las contraseñas de
todo el barrio.

El único camino de lectura es `POST /devices/:id/config/reveal-wifi`, solo CPS y
siempre en `audit_log`.

### Endpoints

```
GET  /api/devices/:id/config                 espejo + estado de la cola + último scan
PUT  /api/devices/:id/config                 publica un patch (gestores y técnicos)
POST /api/devices/:id/config/scan            que el equipo busque redes
POST /api/devices/:id/config/refresh         pedirle su cfg actual (desbloquea "sin espejo")
POST /api/devices/:id/config/reveal-wifi     solo CPS; auditado
```

El **scan es a pedido, nunca automático**: interrumpe la máquina de estados del
WiFi y, mientras dura, el panel no está siendo una alarma.

## Credencial del broker (2026-08-04)

Sin credencial en Mosquitto, un equipo **no puede conectarse** por más que esté
instalado y con corriente. La web no la registra: **encola** y un proceso aparte
—el provisioner, en el repo del GtD— hace el trabajo.

Diseño: `docs/superpowers/specs/2026-08-04-provisioner-broker-design.md`.

### El flujo

```
POST /devices  →  gtd.provisioning_queue (pending)  →  NOTIFY gtd_provisioning
                                                              ↓
                                            provisioner (proceso privilegiado)
                                            deriva HMAC → mosquitto_passwd → reload
                                                              ↓
                            gtd.confirm_provisioning → device.mqtt_provisioned_at
```

**El alta de fábrica encola sola**, en la misma transacción que crea el equipo:
no puede quedar un equipo fabricado sin pedido de credencial. Es lo que hace
posible fabricar una tanda sin correr un comando por equipo.

### Por qué el provisioner es un proceso aparte del GtD

El GtD está encerrado a propósito (`NoNewPrivileges`, `ProtectSystem=strict`)
porque recibe payloads de cada panel por MQTT. Registrar en el broker necesita lo
contrario: escribir `/etc/mosquitto/gtd.passwd` y recargar el servicio. Meterlo
adentro sería desarmar ese encierro en el proceso más expuesto del sistema.

Comparten el repo —la derivación HMAC tiene que coincidir byte a byte con el
firmware— pero no el proceso.

### El `SALT_MQTT` no vive acá

La password se **deriva**, no se guarda: quien tiene el salt puede calcular la
credencial de cualquier panel de la flota. Vive **solo** en el entorno del
provisioner. La web nunca lo ve — solo dice "registrá esta MAC".

Por eso `gtd.provisioning_queue` no guarda ninguna password.

### Endpoints

```
POST /api/devices/:id/provision           solo CPS; reintentar o registrar uno viejo
POST /api/devices/:id/revoke-credential   solo CPS; SIEMPRE manual
```

**La baja nunca es automática.** Ningún cambio de estado del equipo revoca nada,
ni `RETIRED` ni `OUT_OF_SERVICE` (decisión de negocio). Como el olvido sería
invisible, la ficha **avisa** cuando un equipo dado de baja conserva su
credencial.

### Un fallo no mueve el hito

`confirm_provisioning` con un resultado distinto de `ok` marca la fila `failed`
con el detalle y **no toca `device`**. El hito `mqtt_provisioned_at` solo se
mueve cuando el broker aceptó de verdad. Y no se reintenta solo: los tres modos
de falla —salt equivocado, broker roto, equipo inválido— piden una persona.
