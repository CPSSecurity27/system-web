# Handoff al frontend — el contrato de la API v2

> **Qué es este documento.** El contrato entre el backend (modelo v2, 2026-07-16)
> y el front. Autosuficiente: con esto + Swagger alcanza para trabajar sin
> contexto previo.
>
> ⚠️ **El frontend actual fue construido contra la API v1 y quedó desalineado.**
> La lista de cambios que lo rompen está en
> `../../frontend-angular/docs/pendientes-y-decisiones.md`.

---

## 1. Levantar el backend

```bash
cd backend-nestjs
npm install
# crear una base PostgreSQL NUEVA y apuntarla en .env
npm run migration:run
npm run auth:bootstrap -- cps_root <clave> ale_copa <clave> mail@cps.com
npm run geography:sync
npm run start:dev          # http://localhost:3000/api
```

**Swagger en http://localhost:3000/api/docs es la fuente de verdad del contrato**
— este documento explica el *porqué*; Swagger tiene el *qué*. CORS ya incluye
`http://localhost:4200`.

No hay datos de prueba sembrados: la base es nueva. Crear desde Swagger (o pedir
un seed) siguiendo el flujo de §4.

## 2. Autenticación — igual que siempre (v1 == v2 acá)

`POST /api/auth/login { identifier, password }` → `{ accessToken, refreshToken }`.
`identifier` es username (panel) o email/DNI (vecino, v2.1) — el backend prueba
los tres, un solo campo en el form de login.
Access corto (15 min, `Authorization: Bearer`), refresh largo y **rotativo** (cada
refresh revoca el usado). Las tres trampas del interceptor siguen vigentes:
guardar el refresh nuevo, **un solo refresh en vuelo**, y no reintentar si el
refresh da 401 (borrar tokens → login).

**Nuevo en v2:** `GET /auth/me` devuelve además las membresías de HOGAR:

```json
{
  "id": 5, "username": "ale_copa", "name": "...", "emailVerified": false,
  "memberships":     [{ "membershipId": 3, "accountId": 2, "accountType": "ORGANIZATION", "role": "ADMIN" }],
  "homeMemberships": [{ "homeId": 9, "role": "TITULAR" }]
}
```

## 3. Permisos — lo que define TODA la UI (CAMBIÓ en v2)

Roles de panel: **OWNER · ADMIN · TECHNICIAN · MONITOR** (en COMPANY u
ORGANIZATION). **Ya no existen `accountType: "HOME"` ni `role: "USER"`.**
El vecino se reconoce por `homeMemberships`, no por sus cuentas:

```ts
const esCps     = me.memberships.some(m => m.accountType === 'COMPANY');
const esOrg     = me.memberships.some(m => m.accountType === 'ORGANIZATION');
const esGestor  = me.memberships.some(m => ['OWNER','ADMIN'].includes(m.role));
const esMonitor = me.memberships.some(m => m.role === 'MONITOR');
const esTitular = me.homeMemberships.some(h => h.role === 'TITULAR');
```

### Quién puede qué (navegación)

| | CPS | Organización (muni/consorcio) | Titular (hogar) |
|---|---|---|---|
| barrios | todos + crear + **cupos** + **transferir** | los suyos + **crear hasta su cupo** | ve el suyo (infraestructura) |
| viviendas | todas | las de sus barrios + crear | **la suya** + editar |
| miembros de hogar | ✅ | ✅ en sus barrios | familiares de su casa |
| cuentas y membresías | todas + **quotas** | la suya (OWNER/ADMIN) | — |
| contratos | ✅ firma | ve los suyos | — |
| alarmas | ABM + **fábrica/stock/claim** | ve + **claim de su stock** | ve las de su barrio |
| controles | todo + stock + códigos | alta/assign en sus barrios | reasigna portador |
| **códigos RF en claro** | ✅ solo CPS | ❌ | ❌ |
| eventos | todo | ve + **resuelve (MONITOR/ADMIN/OWNER)** | ve su barrio + responde |
| padrón `/users` | ✅ solo CPS | ❌ (usa members) | ❌ |

Los datos siguen llegando **ya filtrados por el backend**: el front no filtra nada.

## 4. El flujo de negocio v2 (para armar las pantallas)

**Onboarding de un cliente (solo CPS):**

```
POST /accounts { name, type:'ORGANIZATION', subtype:'MUNICIPAL'|'PRIVATE',
                 maxNeighborhoods?, maxMonitorUsers? }
POST /users    { name, kind:'INSTITUTIONAL', username, password }    <- el OWNER
POST /accounts/:id/members { userId, role:'OWNER' }
GET  /accounts/:id/members/:userId/assignments        <- barrios de un TECH/MONITOR
PUT  /accounts/:id/members/:userId/assignments        <- { neighborhoodIds } reemplaza
                                                         el conjunto; [] = toda su org
POST /neighborhoods { name, localityId, organizationId, managedBy? } <- o lo crea la org
POST /contracts { accountId, neighborhoodId, price, startDate, endDate?, description? }
```

- **Los contratos ya NO llevan `homeId` ni `maxFamilyMembers`**: son organización →
  barrio, comercial puro. Los topes son CUPOS (abajo).
- El OWNER es **institucional y único** por cuenta: usuario sin DNI, no se degrada
  ni borra desde la UI (mostrar deshabilitado).

**Cupos (pantalla solo-CPS):** `PATCH /accounts/:id/quotas` y
`PATCH /neighborhoods/:id/quotas` (`maxFamilyMembers`, `remoteControlsEnabled`).
El 400 de cupo excedido trae mensaje claro ("Para ampliarlo, contactá a CPS") —
mostrarlo tal cual: es el mecanismo comercial, no un error.

**Vivienda y vecinos (ya no hay cuentas HOME):**

```
POST /homes { name, neighborhoodId, address?, contactPhone?, defaultDeviceId?, lat?, lng? }
POST /users { name, email, dni?, telephone? }         <- vecino: email obligatorio, SIN
                                                          password (se manda mail de
                                                          activación; login con email/DNI)
POST /homes/:id/members { userId, role:'TITULAR'|'FAMILIAR' }
GET  /homes/:id/members
PATCH/DELETE /homes/:id/members/:userId               <- el TITULAR no se borra
POST /homes/:id/transfer-titular { newTitularUserId } <- ...se TRANSFIERE (gestor):
                                                         el elegido pasa a TITULAR,
                                                         el saliente queda FAMILIAR.
                                                         Devuelve los miembros.
```

**Equipos (nuevo: inventario + claim):**

```
POST /devices { serial, type?, organizationId? }       <- fábrica (CPS): nace INVENTORY + claimCode
GET  /devices/inventory                                <- stock (CPS todo; org el suyo)
POST /devices/claim { serial, claimCode, neighborhoodId, name?, lat?, lng? }
GET  /devices/:id/state                                <- estado vivo (online, alarm_status) — puede ser null
POST /remotes { name }  ->  POST /remotes/:id/assign { homeId }
```

**Eventos (nuevo módulo — el tablero del monitoreo):**

```
GET   /events?neighborhoodId=&status=OPEN&limit=&offset=   <- paginado { items, total }
POST  /events { neighborhoodId, origin:'PANEL'|'APP', scope?, deviceId?, homeId?, ... }
PATCH /events/:id/resolve { status:'RESOLVED'|'FALSE_ALARM' }
POST  /events/:id/responses { note? }
```

Estados: `OPEN → RESOLVED | FALSE_ALARM` (sin ACK por ahora). `id` del evento es
**string** (bigint). El activador viaja como snapshot congelado (`activatorName`).

## 5. Estado vivo

`GET /devices/:id/state` existe y devuelve `{ online, alarmStatus, lastHeartbeat }`
o `null` — lo escribirá el **servicio de alarmas** (programa aparte, futuro). Hasta
que exista, mostrar "sin datos de estado" cuando sea null. No inventar el dato.

## 6. Errores

| código | qué pasó | qué mostrar |
|---|---|---|
| 400 | validación o regla de negocio (cupos incluidos) | el `message` del backend (string o array) |
| 401 | token vencido | refresh; si falla, login |
| 403 | no es tuyo / no es tu rol | "no tenés acceso" |
| 404 | no existe (o contrato ajeno) | "no encontrado" |
| 409 | ya hay contrato ACTIVE / serial repetido / ya hay OWNER / ya hay titular | el `message` |

## 7. Documentación del backend

| archivo | qué explica |
|---|---|
| `docs/modelo-datos-backend.md` | el modelo v2 y sus invariantes |
| `docs/negocio.md` | cuentas, cupos, contratos, aislamiento, quién puede qué |
| `docs/activos.md` | inventario/claim, alarmas, controles, códigos RF |
| `docs/auth.md` | tokens, RBAC v2, verificación de correo |
| `docs/seguridad.md` | la regla rol vs alcance + checklist |
| `docs/geografia.md` | sync georef, el caso CABA |
| `docs/migraciones.md` | por qué NO existe `migration:generate` |
| `../../docs/` | diseño, negocio y estado del proyecto completo |
