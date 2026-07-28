# Negocio — cuentas, barrios, viviendas, contratos y cupos (v2)

## La distinción que define todo

**Las alarmas NO pertenecen a las viviendas.** Son infraestructura del **barrio**
(postes en la vía pública). Una vivienda no "tiene" una alarma: tiene controles
remotos que disparan las del barrio, y a lo sumo una alarma *preferida*.

## Las dos líneas de negocio (mismo molde, una perilla)

| | PÚBLICO (municipalidad) | PRIVADO (consorcio/comunidad) |
|---|---|---|
| Cuenta | ORGANIZATION `MUNICIPAL` | ORGANIZATION `PRIVATE` |
| Quién opera | la muni se autogestiona (`managed_by = ORGANIZATION`) | CPS (`managed_by = CPS`) |
| Quién paga | solo la muni | la comunidad entera (el consorcio) |
| OWNER | se entrega a la institución | puede quedar en custodia de CPS |

**Onboarding (idéntico en ambos):** CPS crea la cuenta + su OWNER institucional +
el contrato del barrio. **Transferir una comunidad** (privada → municipal o
viceversa) = `POST /neighborhoods/:id/transfer` (solo CPS, auditado): cambia
cliente y/o gestor; hogares, vecinos, equipos e historial quedan intactos.

## Quién puede qué

| | crear barrio | crear vivienda | crear vecinos | crear personal | firmar contrato | cupos |
|---|---|---|---|---|---|---|
| CPS (COMPANY OWNER/ADMIN) | ✅ cualquiera | ✅ | ✅ | ✅ | ✅ | ✅ **solo CPS** |
| Muni (ORG OWNER/ADMIN) | ✅ *los suyos, hasta su cupo* | ✅ en sus barrios | ✅ | ✅ (MONITOR sujeto a cupo) | ❌ | ❌ (los ve) |
| Titular (home_member) | ❌ | ❌ | ✅ *familiares de SU casa, hasta el cupo* | ❌ | ❌ | ❌ |

Los contratos los firma **solo CPS**: es la empresa la que contrata con el cliente.

## Cupos: la tarifa flexible

Todos los "máximos" son parte de la tarifa y **solo CPS los modifica**, siempre con
`audit_log` (valor viejo → nuevo): `max_neighborhoods` y `max_monitor_users` en la
cuenta, `max_family_members` y `remote_controls_enabled` en el barrio.

- Se imponen **al crear**: nunca se supera un cupo con un alta.
- **Reducir no destruye** (grandfathering): lo existente queda; se bloquean altas.
- **Los eventos son ilimitados**: una alarma jamás se rechaza por tarifa.

El negocio del cupo: la muni quiere el barrio 11 y compró 10 → llama a CPS, se
ajusta la tarifa, CPS sube el cupo, la muni sigue sola.

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
