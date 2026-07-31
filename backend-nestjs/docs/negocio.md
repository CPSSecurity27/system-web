# Negocio — cuentas, barrios, viviendas, contratos y cupos (v2)

## La distinción que define todo

**Las alarmas NO pertenecen a las viviendas.** Son infraestructura del **barrio**
(postes en la vía pública). Una vivienda no "tiene" una alarma: tiene controles
remotos que disparan las del barrio, y a lo sumo una alarma *preferida*.

## Dos ejes, no dos líneas (2026-07-30)

| Eje | Dónde vive | Qué responde |
|---|---|---|
| **Escala** | `account.subtype` | MUNICIPAL = varios barrios; COMMUNITY = uno solo (cupo fijo en 1) |
| **Modalidad** | `neighborhood.managed_by` | ORGANIZATION = la opera el cliente; CPS = llave en mano |

La modalidad es **por barrio** y se elige al vender. No se deriva del subtipo: si lo
hiciera serían imposibles la comunitaria autogestionada y la municipal que le terceriza
un barrio a CPS, que son dos ventas reales. El subtipo se llamaba `PRIVATE` y hacía las
dos cosas a la vez; ese era el bug de diseño.

**Onboarding:** MUNICIPAL = `POST /accounts` + `POST /users` + `POST
/accounts/:id/members` (carga sus barrios después). COMMUNITY = `POST
/accounts/onboard-community`, atómico: cuenta + su único barrio + OWNER + membresía en
una transacción, con `managedBy` obligatorio en el body.

**Transferir una comunidad** = `POST /neighborhoods/:id/transfer` (solo CPS, auditado):
cambia el cliente; `managed_by` se **preserva** salvo que se mande explícito. Hogares,
vecinos, equipos e historial quedan intactos.

## Quién puede qué

| | crear barrio | crear vivienda | crear vecinos | crear personal | firmar contrato | cupos |
|---|---|---|---|---|---|---|
| CPS (COMPANY OWNER/ADMIN) | ✅ cualquiera | ✅ | ✅ | ✅ | ✅ | ✅ **solo CPS** |
| ORG OWNER/ADMIN | ✅ *los suyos, hasta su cupo* | ✅ en los barrios que **gestiona** | ✅ ídem | ✅ (sujeto al cupo del rol) | ❌ | ❌ (los ve) |
| Titular (home_member) | ❌ | ❌ | ✅ *familiares de SU casa, hasta el cupo* | ❌ | ❌ | ❌ |

**"Gestiona" ≠ "ve".** En un barrio con `managed_by = CPS`, la organización dueña lo ve
entero —lo paga, necesita sus eventos y su estado— pero no lo edita, ni carga viviendas,
ni vecinos. Lo impone `ScopeService.managesNeighborhood()`, en un solo lugar para todos
los módulos. El TITULAR queda al margen: su casa la administra él, la opere quien la opere.

Los contratos los firma **solo CPS**: es la empresa la que contrata con el cliente.

## Cupos: la tarifa flexible

Todos los "máximos" son parte de la tarifa y **solo CPS los modifica**, siempre con
`audit_log` (valor viejo → nuevo):

| Cupo | Nivel |
|---|---|
| `max_neighborhoods` | cuenta |
| `max_admin_users`, `max_technician_users`, `max_monitor_users` | cuenta |
| `max_family_members`, `remote_controls_enabled` | barrio |

- Se imponen **al crear** (y al promover de rol): nunca se supera un cupo con un alta.
- **Reducir no destruye** (grandfathering): lo existente queda; se bloquean altas.
- **En los cupos de personal, 0 = "esta cuenta no tiene ese rol"**, y el mensaje de error
  lo dice distinto que el de cupo agotado: uno se amplía llamando a CPS, el otro hay que
  contratarlo. Es el mecanismo que expresa "la comunitaria no tiene técnicos propios"
  sin una matriz de roles-por-tipo aparte. El OWNER no tiene cupo: es único por índice.
- **Los eventos son ilimitados**: una alarma jamás se rechaza por tarifa.

El negocio del cupo: la muni quiere el barrio 11 y compró 10 → llama a CPS, se
ajusta la tarifa, CPS sube el cupo, la muni sigue sola.

## Planes: el catálogo, que es una plantilla

`plan` (solo CPS, `/api/plans`) define qué cupos otorga cada producto. Al crear una
cuenta los cupos se **copian**; `account.plan_id` queda como etiqueta histórica y
**nunca** se lee para resolver un cupo. Editar un plan no le cambia nada a quien ya lo
compró — si lo hiciera, un cambio bajaría el cupo de cien clientes de golpe, sin
auditoría y sin grandfathering. Un plan no se borra: se discontinúa (`active: false`).

## Aislamiento de datos

El alcance lo calcula `ScopeService` y **se deriva de la estructura, no de los
contratos**: COMPANY → global; ORGANIZATION → los barrios con
`organization_id` = su cuenta (TECH/MONITOR acotables por `staff_assignment`);
vecino → su hogar (`home_member`) + su barrio como lectura de infraestructura.

Un gestor de barrio ve todas las viviendas de **su** barrio. Un titular ve **solo
la suya**. Cruzar el límite da **403**, y los listados vienen ya filtrados del
backend (el dato ajeno no sale del servidor). Los filtros de query
(`?localityId=`, `?neighborhoodId=`, `?homeId=`) se aplican ENCIMA del alcance.

## Contratos: comercial puro, congelado

`price`, la cuenta y el barrio **no se editan**: se congelan al firmar, como una
factura. Para cambiarlos se cancela y se firma otro (queda el historial; un barrio
acumula contratos vencidos). El `PATCH` solo toca `status`, `description`,
`endDate`. Un solo contrato ACTIVE por barrio (índice parcial → el segundo da 409).
Los cupos ya NO viven en el contrato: van en cuenta/barrio (ver arriba).

## Usuarios y membresías

**Crear un usuario NO le da acceso a nada**: es solo una identidad. El acceso lo da
la membresía de cuenta (`POST /accounts/:id/members`) o de hogar
(`POST /homes/:id/members`). Tres identidades de `app_user`:

- **panel**: username + password (persona real)
- **institucional** (OWNER): username + password, sin DNI — solo la crea CPS
- **vecino** (v2.1): email obligatorio (+ DNI y teléfono opcionales), SIN
  password al crearlo — activa la cuenta con un mail (fija la clave y verifica
  el correo en el mismo paso) y desde ahí entra con email o DNI + contraseña.
  SMS/WhatsApp quedaron pospuestos por costo — ver `docs/auth.md`.

Reglas del OWNER: institucional ⇔ OWNER, uno por cuenta, no se degrada ni borra
por API (traspaso = acto formal de CPS). Regla del TITULAR: uno por hogar, titular
de un solo hogar, no se borra: se transfiere (`POST /homes/:id/transfer-titular`,
solo gestores, auditado) — el elegido pasa a TITULAR y el saliente queda FAMILIAR.

## Endpoints (resumen; Swagger en /api/docs es el contrato exacto)

```
POST   /api/accounts                        solo CPS (ORGANIZATION + subtype + cupos)
PATCH  /api/accounts/:id/quotas             SOLO CPS — auditado
POST   /api/accounts/:id/members            OWNER/ADMIN; MONITOR sujeto a cupo
GET    /api/accounts/:id/members/:userId/assignments   barrios de un TECH/MONITOR
PUT    /api/accounts/:id/members/:userId/assignments   reemplaza el conjunto — auditado
                                            (sin filas = ve toda su org; barrio ajeno
                                             es imposible a nivel base: FK compuesta)

GET    /api/neighborhoods                   ya filtrado por alcance
POST   /api/neighborhoods                   CPS o la organización (su cupo)
PATCH  /api/neighborhoods/:id/quotas        SOLO CPS — auditado
POST   /api/neighborhoods/:id/transfer      SOLO CPS — auditado

GET    /api/homes?neighborhoodId=
POST   /api/homes                           CPS o gestor del barrio
POST   /api/homes/:id/members               gestor (todo) o titular (familiares)
PATCH  /api/homes/:id/members/:userId       suspender/reactivar
DELETE /api/homes/:id/members/:userId       familiares (el titular no se borra)
POST   /api/homes/:id/transfer-titular      gestor — auditado (swap titular↔familiar)

GET    /api/contracts                       por alcance
POST   /api/contracts                       solo CPS { accountId, neighborhoodId, price, ... }
PATCH  /api/contracts/:id                   solo estado/descripción/fin
```

Activos (devices/remotes/claim/códigos): `docs/activos.md`. Eventos: módulo
`events` (`GET/POST /api/events`, `PATCH /api/events/:id/resolve`,
`POST /api/events/:id/responses`).
