# Seguridad — auditoría y reglas

> **Nota v2 (2026-07-16):** los agujeros históricos de abajo se describen en
> términos del modelo v1 ("cuenta HOME", "titular = ADMIN de HOME"). En v2 los
> vecinos ya no tienen cuenta (son `home_member`), pero las defensas siguen
> vigentes con la misma forma: `assertCanManage` ahora acepta compartir cuenta
> **o compartir hogar**, y `assertNoPuedeCapturarACps` sigue igual. Se suma
> además la **auditoría persistente** (`audit_log`, append-only, vía
> `AuditService`): cupos, contratos, transferencias, membresías, claim de
> equipos y reveal de códigos RF quedan registrados siempre. Y al crear la base
> definitiva van los **GRANTs de un-solo-escritor** (§13 del SQL v2).

## La regla que resume todo

> **El ROL dice QUÉ podés hacer. La MEMBRESÍA dice SOBRE QUÉ / SOBRE QUIÉN.**
> Chequear uno sin el otro es el bug.

Los dos agujeros encontrados en la auditoría eran el mismo error: `@RequireMembership`
validaba el rol y nadie validaba el alcance. **`@RequireMembership` no alcanza nunca por sí
solo** en un endpoint con `:id`.

## Agujeros encontrados y cerrados (2026-07-13)

### 1. CRÍTICO — escalación de privilegios en `/users/:id`

`GET` y `PATCH /api/users/:id` pedían "ser ADMIN de alguna cuenta" y no verificaban de cuál.
Como **el titular de una vivienda también es ADMIN** (de su cuenta HOME), un vecino podía:

- leer los datos de cualquier usuario del sistema (nombre, username, email);
- **suspender al ADMIN de CPS** → el admin global quedaba fuera del sistema (verificado: el
  login pasaba a dar 401). Denegación de servicio total, ejecutada por el usuario menos
  privilegiado que existe.

**Cerrado:** `UsersService.assertCanManage()` — hay que **compartir una cuenta** con el otro.

### 2. El rodeo de la anterior — captura de un miembro de CPS

Con solo lo anterior quedaba una vuelta elegante: el vecino sumaba al ADMIN de CPS **a su
propia cuenta HOME** (`POST /accounts/:id/members`), con lo cual pasaban a "compartir
cuenta"… y ahí ya podía suspenderlo.

**Cerrado:** `AccountsService.assertNoPuedeCapturarACps()` — quien no es de CPS no puede
sumar a un miembro de CPS a ninguna cuenta.

### 3. ALTO — cuentas ajenas en `/accounts/:id`

`GET /accounts/:id`, `GET /accounts/:id/members`, `POST/PATCH/DELETE .../members` pedían rol
ADMIN sin verificar **de qué cuenta**. El admin de un municipio podía leer la cuenta
"Familia Pérez", **la lista de sus integrantes** (nombres, usuarios, correos) y hasta
meterle miembros.

**Cerrado:** `AccountsService.assertAccess()` en los 5 endpoints.

## Barrido de ataques cruzados (todos pasan)

Escenario: 2 municipios con 1 barrio cada uno, 2 viviendas en el primero.

| ataque | resultado |
|---|---|
| Juan (vecino) lee/suspende al admin de CPS | **403** |
| Juan suma al admin de CPS a su cuenta | **403** |
| Juan lista el padrón de usuarios | **403** |
| Ana (municipio A) lee barrio / contrato / device de B | **403 / 404 / 403** |
| Ana lee la cuenta HOME de una familia y sus miembros | **403** |
| Ana revela un código RF (no es CPS) | **403** |
| Gaby lee la vivienda / control / códigos de Juan | **403** |
| Juan revela el código RF de su propio control | **403** (solo CPS) |
| Juan edita una alarma o carga mantenimiento | **403** (solo CPS) |
| Ana firma un contrato / crea cuenta / dispara sync | **403** (solo CPS) |

Lo que **sí** sigue funcionando: Juan administra a su familia y ve las alarmas de su barrio
(infraestructura compartida); Ana administra su barrio y sus viviendas; CPS ve todo.

## Detalles de diseño

**403 vs 404.** En barrios, viviendas, devices y cuentas → **403** ("existe, no es tuyo").
En **contratos** → **404**, para no revelar ni siquiera que ese contrato existe.

**El filtrado pasa en el backend, no en el front.** Los listados vienen ya recortados: el
dato ajeno **no sale del servidor**. No se ocultan botones.

**Los filtros de query se aplican ENCIMA del alcance**, nunca en lugar de él.
`?localityId=` de una localidad ajena devuelve `[]`, no barrios ajenos. Por eso son query
params sobre el listado y no rutas propias (`/localities/:id/neighborhoods`): una ruta aparte
es justo donde uno se olvida de aplicar el scope.

**Suspender deja afuera EN EL ACTO.** El `JwtAuthGuard` relee al usuario en cada request. Es
lo que hace que echar a un técnico sea inmediato — y también lo que hacía tan grave el bug #1.

## Checklist para cada endpoint nuevo

1. ¿Tiene `:id` o un filtro? → **¿verifica alcance, además del rol?**
2. ¿Un ADMIN de ORGANIZATION o un TITULAR de hogar puede llamarlo? → **asumí que
   es un atacante y probalo.**
3. ¿Devuelve una lista? → **¿está recortada por alcance en el backend?**
4. ¿Toca datos sensibles (códigos RF, password_hash)? → **¿está en `select: false`?**
5. ¿Es una acción sensible (cupos, contratos, transferencias, roles, claim,
   reveal)? → **¿pasa por `AuditService`?**
6. Antes de darlo por bueno: **correr el ataque cruzado**, no solo el caso feliz.
