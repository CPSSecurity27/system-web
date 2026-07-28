# Frontend — estado y pendientes

> **Actualizado: 2026-07-18 (segunda pasada).** El frontend está **MIGRADO a
> la API v2**, verificado contra el backend real (base `cps_security_v2`), y
> con **los pendientes menores cerrados**: compila, los tests pasan y todas
> las respuestas de la API coinciden con los tipos.
> El contrato v2 completo: `../../backend-nestjs/docs/frontend-handoff.md`.

---

## 1. Qué está construido (contra v2)

Las 15 rutas: dashboard, **`/eventos` (tablero del monitoreo, nueva)**,
`/barrios` (+detalle con mapa, cupos y transferencia), `/viviendas`
(+**miembros del hogar**, nueva), `/alarmas` (+detalle con estado vivo,
**fábrica** y **stock/claim**, nuevas), `/controles` (+códigos RF 1..4,
entrega desde stock), `/cuentas` (+onboarding con OWNER institucional y
cupos), `/contratos` (org → barrio, comercial puro), `/usuarios`, `/perfil`,
`/login`, `/forgot-password`, `/reset-password`, **`/verify-email` (nueva)**.

El interceptor de refresh (rotación + promesa única) quedó tal cual: auth no
cambió entre v1 y v2.

## 2. Decisiones tomadas en la migración

- **Roles**: `AuthService` expone `isCps`, `isOrgManager`, `isManager`
  (CPS ∪ org), `isMonitor`, `isTechnician`, `isVecino`, `isTitular` (por
  `homeMemberships`) y `displayName` (el vecino no tiene username). Nunca se
  mira el rol suelto: siempre el par (tipo de cuenta, rol).
- **Guards**: `cpsGuard` (cuentas, usuarios, fábrica, contratos/nuevo) y
  `managerGuard` nuevo (barrios/nuevo, viviendas/nueva, stock, controles/nuevo)
  — la organización se autogestiona.
- **Onboarding en un paso**: `/cuentas/nueva` crea cuenta → usuario
  INSTITUCIONAL → membresía OWNER, encadenados.
- **Vecinos**: se crean desde la pantalla de miembros del hogar con nombre +
  DNI, **sin contraseña** (el login DNI+OTP es un pendiente del backend).
- **Cupos**: los 400 comerciales del backend se muestran tal cual (barrios,
  monitores, familiares, controles). La UI no duplica esas reglas.
- **Claim code**: se muestra UNA vez al fabricar y en la tabla de stock; el
  claim vive en `/alarmas/stock` junto a la entrega de lotes (solo CPS).
- **Estado vivo**: `GET /devices/:id/state` se consulta en el detalle; si es
  `null` se muestra "sin datos" (lo escribirá el servicio de alarmas).
- **Códigos RF**: alta y revelado solo CPS, de a uno, sin cachear; posición
  1..4.
- **Eventos**: `id` se maneja como **string** (bigint); tablero paginado
  (20 por página) con filtros por barrio y estado, resolución
  RESOLVED/FALSE_ALARM y alta manual origen PANEL.
- **Titularidad (2026-07-18)**: botón "Hacer titular" en miembros del hogar,
  solo gestores (`POST /homes/:id/transfer-titular`): el elegido pasa a
  TITULAR y el saliente queda como FAMILIAR (para sacarlo, el borrado de
  siempre). Los 400/409 del backend se muestran tal cual.

## 3. Cerrado en la segunda pasada (2026-07-18)

1. ~~**Responder eventos**~~ — fila expandible en el tablero: lista de
   respuestas (`GET /events/:id`) + botón "Estoy yendo" con nota opcional.
   Solo en eventos OPEN; si ya respondiste, lo dice (el backend es
   idempotente: una respuesta por persona).
2. ~~**Reasignar portador**~~ — botón "Cambiar" en la tarjeta del control
   (gestores y titular): selector de miembros ACTIVOS del hogar dueño, con
   opción "sin portador". El 400 de no-miembro se muestra tal cual.
3. ~~**Asignaciones de personal**~~ — botón por miembro TECHNICIAN/MONITOR en
   la pantalla de la cuenta: checkboxes con los barrios de la org, PUT del
   conjunto completo (`/accounts/:id/members/:userId/assignments`, endpoints
   NUEVOS del backend). Nada tildado = ve toda la organización.
4. ~~**Heredados de v1**~~ — mapa clickeable (`app-map [clickable]` emite
   lat/lng) en alta de vivienda e instalación de equipo; paginación real en
   `/usuarios` (con buscador con debounce) y `/cuentas` (25 por página);
   pantalla `/verify-email` (el mailer ahora apunta el link al front, como el
   reseteo) + botón "Enviar mail de verificación" en el perfil; suspender /
   reactivar / cancelar contrato desde la lista (solo CPS; cancelar pone
   fin = hoy y es definitivo: para volver se firma otro).

## 4. Login del vecino: email + contraseña, no DNI+OTP (2026-07-21)

SMS/WhatsApp salían caros y no había proveedor contratado. Se pivoteó: el
vecino se registra con **email** (obligatorio; DNI queda opcional) y activa su
cuenta con un mail — misma pantalla que "olvidé mi contraseña"
(`/activar-cuenta`, mismo componente `ResetPassword` con `route.data.activation`
para el copy). Desde ahí entra con **email o DNI + contraseña**, un solo campo
de login para todo el sistema (`identifier`).

Cambios de UI: `/login` pide "Usuario, email o DNI"; alta de vecino (miembros
del hogar) pide email en vez de DNI, ya no dice "sin contraseña". Verificado
E2E contra el backend real: alta → mail de activación (token capturado del log
sin SMTP) → activar → login por email → login por DNI con la misma clave.

**Vista del VECINO logueado**: las pantallas ya lo contemplan (solo lectura,
sin botones de gestión), pero falta crear un vecino de prueba, activarlo y
loguear como tal para verlas en uso — es lo único que queda de este pendiente.

## 5. Notas de entorno (siguen vigentes)

- Node 22/24 (los impares: warning de Angular + `localStorage` experimental
  rompe jsdom en tests — por eso el `InMemoryTokenStorage`).
- Leaflet: `allowedCommonJsDependencies` + `divIcon` propio.
- Datos de prueba: la base `cps_security_v2` quedó sembrada por el E2E del
  backend; credenciales en `../../docs/estado-proyecto.md` §3.1.
- Verificación: `npx tsc --noEmit && npx ng build && npm test -- --watch=false`
  (no hay eslint en este proyecto; formato con `npx prettier --write`).
