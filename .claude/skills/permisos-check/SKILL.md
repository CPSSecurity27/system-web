---
name: permisos-check
description: Use when adding or modifying any endpoint, guard, query filter, or list response in the CPS Security backend — especially routes with an :id param, and before declaring authorization work done.
---

# Chequeo de permisos y alcance (CPS Security)

## La regla que resume todo

> **El ROL dice QUÉ podés hacer. La MEMBRESÍA dice SOBRE QUÉ / SOBRE QUIÉN.**
> Chequear uno sin el otro **es** el bug.

Los dos agujeros críticos de la auditoría 2026-07-13 fueron exactamente eso:
`@RequireMembership` validaba el rol y nadie validaba el alcance.

**`@RequireMembership` no alcanza NUNCA por sí solo en un endpoint con `:id`.**

## Checklist por endpoint

1. ¿Tiene `:id` o un filtro? → **¿verifica alcance, además del rol?**
2. ¿Un ADMIN de ORGANIZATION o un TITULAR de hogar puede llamarlo? → **asumí que
   es un atacante y probalo.**
3. ¿Devuelve una lista? → **¿está recortada por alcance en el backend?**
4. ¿Toca datos sensibles (códigos RF, `password_hash`)? → **¿está en `select: false`?**
5. ¿Es una acción sensible (cupos, contratos, transferencias, roles, claim,
   reveal)? → **¿pasa por `AuditService`?**
6. Antes de darlo por bueno: **correr el ataque cruzado**, no solo el caso feliz.

## Las defensas que ya existen — usalas, no las reinventes

| Helper | Qué garantiza |
|---|---|
| `UsersService.assertCanManage()` | Compartir cuenta **o** compartir hogar con el otro usuario |
| `AccountsService.assertAccess()` | La cuenta del `:id` es una a la que pertenecés |
| `AccountsService.assertNoPuedeCapturarACps()` | Quien no es de CPS no suma a un miembro de CPS a ninguna cuenta |

El tercero cierra un rodeo real: sin él, alcanzaba con **sumar al admin de CPS a
tu propia cuenta** para pasar a "compartir cuenta" y después suspenderlo.

## Decisiones de diseño que hay que respetar

**403 vs 404.** Barrios, viviendas, devices y cuentas → **403** ("existe, no es
tuyo"). **Contratos → 404**, para no revelar ni que ese contrato existe.

**El filtrado pasa en el backend, no en el front.** Los listados salen ya
recortados: el dato ajeno **no sale del servidor**. No se ocultan botones.

**Los filtros de query se aplican ENCIMA del alcance, nunca en lugar de él.**
`?localityId=` de una localidad ajena devuelve `[]`, no barrios ajenos.
Por eso son query params sobre el listado y **no rutas propias**
(`/localities/:id/neighborhoods`): una ruta aparte es justo donde uno se olvida
de aplicar el scope.

**Suspender deja afuera EN EL ACTO.** El `JwtAuthGuard` relee al usuario en cada
request. Es lo que hace inmediato echar a un técnico — y lo que hacía tan grave
el bug de escalación.

## El barrido de ataques cruzados

Escenario: 2 municipios con 1 barrio cada uno, 2 viviendas en el primero.
Todos estos deben dar 403 (o 404 en contratos):

- Vecino lee/suspende al admin de CPS; lo suma a su cuenta; lista el padrón
- Admin del municipio A lee barrio / contrato / device de B
- Admin del municipio A lee una vivienda y sus integrantes
- Vecino lee la vivienda / control / códigos de otro vecino
- Cualquiera que no sea CPS revela un código RF
- Cualquiera que no sea CPS firma contrato, crea cuenta o dispara sync

Lo que **sí** debe seguir funcionando: el vecino administra a su familia y ve
las alarmas de su barrio (infraestructura compartida); el admin administra su
barrio y sus viviendas; CPS ve todo.

Si tocaste guards, scope o membresías, **corré el barrido completo** — no solo
el caso que estabas arreglando.

## Errores frecuentes

| Error | Por qué duele |
|---|---|
| Confiar en que el front no muestra el botón | El endpoint sigue expuesto; el atacante usa curl |
| Rol correcto, alcance ausente | Es literalmente el bug de la auditoría |
| Ruta anidada "más linda" en vez de query param | Donde se olvida el scope |
| Devolver 404 en barrios "por las dudas" | La convención es 403; 404 es solo para contratos |
| Acción sensible sin `AuditService` | Los cupos y contratos deben quedar registrados **siempre** |

## Referencias

- `backend-nestjs/docs/seguridad.md` — auditoría completa y agujeros cerrados
- `backend-nestjs/docs/auth.md` — guards, roles y membresías
- `docs/roles-conexion-v2.sql` — GRANTs de un-solo-escritor a nivel Postgres
