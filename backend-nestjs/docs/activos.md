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

## `device` — la alarma

Postgres guarda la **configuración** (serial, tipo, estado administrativo,
ubicación, hardware IMEI/ICCID/MAC, tested). `device.type` es extensible
(ALARM_PANEL hoy; SIREN/REPEATER/SENSOR reservados). El `serial` es la identidad
física y **no se puede cambiar**.

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
POST   /api/devices                          SOLO CPS (fábrica o instalación directa)
POST   /api/devices/claim                    técnicos CPS/org: serial + código
PATCH  /api/devices/:id                      solo CPS; serial inmutable
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
