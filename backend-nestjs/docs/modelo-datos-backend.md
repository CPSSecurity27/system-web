# Modelo de datos — Backend CPS Security (PostgreSQL + NestJS) · v2

> **Qué es este documento.** El mapa del modelo de datos del backend, versión v2
> (implementada el 2026-07-16). El **DDL ejecutable y fuente de verdad** es
> `../../docs/esquema-postgres-v2.sql`; el porqué de cada decisión está en
> `../../docs/diseno-relaciones-fase1.md`. Acá va lo que hay que saber para tocar
> el código.

---

## 1. El sistema en una página

CPS Security vende **seguridad comunitaria monitoreada** a organizaciones, con un
molde único: `account` (ORGANIZATION) → contrato por barrio → `neighborhood` →
`home` → `home_member`.

Lo que varía son **dos perillas independientes**:

- `account.subtype` — la **escala**: MUNICIPAL (varios barrios, hasta su cupo) o
  COMMUNITY (uno solo, cupo fijo en 1).
- `neighborhood.managed_by` — **quién opera cada barrio**: ORGANIZATION
  (autogestión) o CPS (llave en mano). Se decide barrio por barrio, al vender.

Hasta 2026-07-30 la segunda se derivaba de la primera (`PRIVATE` ⇒ la opera CPS), lo
que hacía imposibles la comunitaria autogestionada y la municipal que terceriza un
barrio. Ahora son ortogonales.

### Las tres distinciones que definen el modelo entero

1. **La alarma es del BARRIO, no de la vivienda.** Postes/sirenas en la vía
   pública. La vivienda tiene controles remotos y, a lo sumo, una alarma
   *preferida* (`home.default_device_id`).
2. **Panel y app son superficies distintas de una misma tabla de personas.**
   `app_user` + `account_user` (roles de panel) para administrar; `app_user` +
   `home_member` (TITULAR/FAMILIAR) para los vecinos. **No existen cuentas HOME.**

   El vínculo vecino–vivienda **es la fila de `home_member`**: la vivienda no
   guarda a sus miembros y el vecino no guarda su vivienda. El modelo viejo
   (Firebase) tenía el mismo hecho en tres lugares —`user.home_id`,
   `home.members{}` y `home.owner_id`— sin nada que los obligara a coincidir.
   Desde 2026-08-02 un único total sobre `user_id` (`uq_home_member_one_home`)
   garantiza que **una persona vive en una sola casa**.
3. **Postgres guarda qué ES y qué PASÓ; `device_state` guarda qué está PASANDO**,
   y la escribe únicamente el servicio de alarmas (programa aparte que comparte
   solo esta base). Un solo escritor por tabla.

## 2. Jerarquía de relaciones

```
province ──< department ──< locality
                              └──< neighborhood            (el barrio; organization_id NOT NULL)
                                     ├──< home             (la vivienda)
                                     │     ├──< home_member    (1 TITULAR + N FAMILIAR)
                                     │     └──< remote         (control del HOGAR)
                                     │           └──< remote_code (RF cifrados, 1..4)
                                     ├──< device           (alarma comunitaria)
                                     │     ├── device_state     (vivo, 1 fila, solo servicio de alarmas)
                                     │     └──< device_maintenance
                                     ├──< event            (append-only, ILIMITADOS)
                                     │     └──< event_response
                                     └──< service_contract (1 ACTIVE por barrio)

account (COMPANY única | ORGANIZATION) ──< account_user >── app_user
account_user ──< staff_assignment >── neighborhood   (acota TECH/MONITOR por barrio)
app_user ──< refresh_token / user_token / user_device / audit_log
```

## 3. Roles y acceso

| Superficie | Rol | Quién | Notas |
|---|---|---|---|
| Panel | OWNER | usuario **INSTITUCIONAL** (`kind = INSTITUTIONAL`) | soberanía; exactamente 1 por cuenta (índice parcial); no se degrada/borra por API |
| Panel | ADMIN | persona real | operación diaria |
| Panel | TECHNICIAN | persona real | instala/reclama equipos; acotable por barrio |
| Panel | MONITOR | persona real | eventos y estados; sujeto a cupo; acotable por barrio |
| App | TITULAR | vecino | 1 por hogar, titular de 1 solo hogar |
| App | FAMILIAR | vecino | hasta `neighborhood.max_family_members` |

**El alcance ya NO se deriva de contratos** — se deriva de la estructura
(`ScopeService`): COMPANY → global; ORGANIZATION → sus barrios
(`neighborhood.organization_id`), acotado por `staff_assignment` para
TECH/MONITOR; vecino → sus hogares (`home_member`) + su barrio como lectura.
El contrato solo dice si el servicio está al día.

## 4. Cupos (entitlements) — la parte flexible de la tarifa

| Cupo | Vive en | Frena |
|---|---|---|
| `max_neighborhoods` | `account` | crear barrios |
| `max_monitor_users` | `account` | membresías MONITOR |
| `max_family_members` | `neighborhood` | alta de familiares |
| `remote_controls_enabled` | `neighborhood` | alta de controles |

Reglas uniformes: **solo CPS los escribe** (`PATCH /accounts/:id/quotas`,
`PATCH /neighborhoods/:id/quotas`), se imponen **al crear**, reducirlos aplica
**grandfathering** (nada se borra ni suspende; se bloquean altas), y todo cambio
queda en `audit_log` con valor viejo → nuevo. **Los eventos no tienen cupo.**

## 5. Cómo la base garantiza las reglas (lo que NO hay que romper)

La técnica central sigue siendo la **FK compuesta sobre `UNIQUE (id, type)`** de
`account`: `neighborhood` y `service_contract` llevan una copia del tipo fijada en
`'ORGANIZATION'` por CHECK y atada por FK — una COMPANY no puede ser dueña de
barrios ni contratar, declarativamente.

Índices únicos **parciales** (la otra mitad del truco):

- una sola cuenta COMPANY (CPS es única)
- un OWNER por cuenta
- un TITULAR por hogar / una persona titular de un solo hogar
- un contrato ACTIVE por barrio
- un `user_device` ACTIVE por persona
- `claim_code` único cuando no es NULL

CHECKs de custodia: `device`/`remote` en `INVENTORY` ⇔ sin barrio/hogar; el stock
organizacional (`organization_id`) solo existe en inventario. `remote_code.position`
1..4. Y `staff_assignment` lleva **dos FK compuestas que comparten `account_id`**:
asignarle a un miembro un barrio de otra organización es imposible a nivel base.

### Invariantes que van en el CÓDIGO (la base no llega)

1. OWNER ⇔ usuario INSTITUTIONAL (y un institucional solo puede ser OWNER, nunca
   `home_member`). — `AccountsService` / `HomesService` / `UsersService`
2. Cupos al crear (barrios, monitores, familiares) con grandfathering.
3. Portador de un control ∈ miembros del hogar; alarma del control y
   `default_device` del hogar en el mismo barrio. — `RemotesService` / `HomesService`
4. Claim: una organización solo reclama equipos de SU stock, para SUS barrios. — `DevicesService`
5. Resolución de eventos: solo MONITOR/ADMIN/OWNER del barrio (o CPS). — `EventsService`

## 6. Auditoría

`audit_log` es **append-only** (`AuditService`; el INSERT nunca rompe la operación
auditada). Auditan siempre: cupos (viejo → nuevo), contratos, transferencias de
comunidades, membresías y roles, claim/entrega de equipos, reveal de códigos RF.

## 7. Base nueva y arranque

Una sola migración (`1785000000000-InitialSchemaV2`) crea todo. No hay migración de
datos: se decidió base limpia (no había producción).

```bash
npm run migration:run
npm run auth:bootstrap -- cps_root <clave> [admin] [clave] [email]   # COMPANY + OWNER institucional (+ ADMIN)
npm run geography:sync
```

## 8. Fuera de alcance (siguiente iteración)

- **Servicio de alarmas** (programa separado: MQTT → `device_state` + `event` + FCM).
  Los GRANTs de un-solo-escritor están en §13 del SQL v2 y se aplican al crearlo.
- 2FA del OWNER; estado ACKNOWLEDGED del evento (pospuesto a propósito);
  PostGIS si hace falta geografía real.
- `user_device` y `UserTokenType.PHONE_OTP` quedaron sin uso: el vecino pasó a
  registrarse con email en vez de DNI + OTP (v2.1, ver `docs/auth.md`).
