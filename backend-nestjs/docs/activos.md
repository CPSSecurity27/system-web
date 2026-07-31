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
