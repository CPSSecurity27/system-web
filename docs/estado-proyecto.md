# Estado del proyecto — CPS Security

> **Actualizado:** 2026-07-21. Este es el documento de arranque para cualquier
> sesión nueva (humana o con IA): qué está hecho, qué falta y en qué orden seguir.

---

## 1. Dónde estamos

El proyecto pasó por un rediseño completo del modelo en 4 fases, todas cerradas:

| Fase | Qué fue | Resultado |
|---|---|---|
| 0 — Relevamiento | Contrastar PDF original + código + Firebase viejo | `relevamiento-fase0.md` (histórico) |
| 1 — Diseño | Modelo de relaciones, roles, cupos, eventos | `diseno-relaciones-fase1.md` |
| 2 — Modelo físico | DDL completo para base nueva | `esquema-postgres-v2.sql` |
| 3 — Implementación backend | Migrar `backend-nestjs` al modelo v2 | **HECHO** — compila, lint y tests en verde |

**Decisiones ya tomadas (no re-litigar):** alarmas solo comunitarias (del barrio);
clientes = organizaciones MUNICIPAL/PRIVATE con OWNER institucional; sin cuentas
HOME ni contratos por vivienda (vecinos = `home_member`); cupos = tarifa solo-CPS
con grandfathering; eventos ilimitados (`community_mode_enabled` eliminado);
Firebase eliminado por completo; servicio de alarmas como programa separado que
comparte solo la base; controles con 4 códigos RF; sin git por decisión del usuario.

## 2. Qué tiene el backend v2 (resumen)

- **23 tablas** en una sola migración (`InitialSchemaV2`), para base NUEVA sin datos.
- Roles de panel: OWNER (institucional) / ADMIN / TECHNICIAN / MONITOR, con
  `staff_assignment` para acotar técnicos y monitores por barrio.
- Vecinos: `home_member` (1 TITULAR por hogar, FAMILIAR hasta el cupo del barrio).
- Cupos con endpoints solo-CPS: `PATCH /accounts/:id/quotas`, `PATCH /neighborhoods/:id/quotas`.
- Autogestión municipal: la organización crea barrios (contra su cupo), hogares,
  vecinos y su personal. Transferencia de comunidades: `POST /neighborhoods/:id/transfer`.
- Inventario y claim de equipos: `POST /devices` (fábrica) → stock → `POST /devices/claim`;
  ídem controles con `POST /remotes/:id/assign`.
- Módulo `events` (append-only, resolución del monitoreo) + `device_state` (lo
  escribirá el servicio de alarmas) + `audit_log` (AuditService en acciones sensibles).
- Bootstrap: `npm run auth:bootstrap -- <owner> <pass> [admin] [pass] [email]`.

## 3. Pendientes, en orden sugerido

1. ~~**Probar el backend contra una base real**~~ — **HECHO (2026-07-18)**: se creó
   la base `cps_security_v2` (el `.env` ya apunta ahí), corrieron migración +
   bootstrap + geografía, y se recorrió TODO el flujo E2E por la API con
   resultado limpio: onboarding de municipalidad y consorcio, cupos (barrios,
   monitores, familiares) con sus 400 comerciales, contrato único por barrio
   (409), reglas de OWNER (institucional, único, 409/400), hogar (titular único,
   no borrable), fábrica → entrega de stock → claim con código de un solo uso,
   stock ajeno rechazado (403), control stock → assign → portador (solo miembros
   del hogar), códigos RF (cifrar/revelar solo CPS, posición 1..4), eventos
   (crear → resolver por MONITOR, tablero paginado), aislamiento entre
   organizaciones (403/listas recortadas), transferencia de comunidad con cupo, y
   `audit_log` con las 12 acciones sensibles registradas (cupos con viejo→nuevo).

   **Datos de prueba en `cps_security_v2`** (claves de desarrollo, cambiarlas
   fuera de local): `cps_root`/`RootCps2026!` (OWNER CPS), `ale_copa`/`AleCopa2026!`
   (ADMIN CPS), `muni_sanpedro` (OWNER muni), `marta_muni`/`Marta2026!` (ADMIN
   muni), `monitor_sp`/`Monitor2026!` (MONITOR), `pedro_lapachos`/`Pedro2026!`
   (ADMIN consorcio), vecinos por DNI sin clave. 3 barrios, 2 hogares, 2 equipos,
   1 control con código RF, 1 evento resuelto.
2. ~~**Migrar el frontend Angular a la API v2**~~ — **HECHO (2026-07-18)**: las
   14 rutas migradas y verificadas contra el backend real (tipos v2, roles por
   par cuenta+rol, vecino por `homeMemberships`). Pantallas nuevas: eventos
   (tablero del monitoreo), miembros del hogar, stock/claim de equipos, cupos
   y transferencia de barrios, onboarding de cuenta con OWNER institucional.
   Compila, tests en verde. Estado y pendientes menores del front:
   `frontend-angular/docs/pendientes-y-decisiones.md`.

   **Segunda pasada (2026-07-18, pendientes menores cerrados)**: respuestas
   de eventos ("estoy yendo") en el tablero, cambio de portador del control,
   **asignaciones de personal por barrio** (endpoints nuevos
   `GET/PUT /accounts/:id/members/:userId/assignments`, auditados, probados
   E2E: el alcance del monitor se achica y se restaura), cierre/suspensión de
   contrato desde la UI, pantalla `/verify-email` (el mailer ahora manda el
   link al front), coordenadas clickeando el mapa (alta de vivienda y claim),
   y paginación real con buscador en `/usuarios` y `/cuentas`.
3. ~~**Login del vecino**~~ — **PIVOTEADO Y HECHO (2026-07-21)**: se descartó
   DNI + OTP (SMS/WhatsApp caro, sin proveedor) a favor de **email +
   contraseña**. El vecino se registra con email obligatorio (DNI queda
   opcional, dato de la persona) y activa la cuenta con un mail que reutiliza
   `reset-password` (fija la clave y verifica el correo en el mismo paso, 48h
   de margen); desde ahí entra con email o DNI + contraseña, un solo campo de
   login (`identifier`) para todo el sistema. Migración `VecinoEmailLogin`
   (suma `email` al CHECK de identidad). `user_device` y `PHONE_OTP` quedan
   sin uso — no se borran, ese camino no se construyó. Probado E2E: alta →
   mail de activación → activar → login por email → login por DNI con la
   misma clave → 401 uniforme en los casos malos. Detalle en
   `backend-nestjs/docs/auth.md`. **Queda pendiente**: crear un vecino de
   prueba, activarlo y loguearlo para ver la vista del vecino en el front (la
   UI ya la contempla, nunca se probó logueada).
4. ~~**Roles de conexión de PostgreSQL**~~ — **HECHO (2026-07-18)**: script
   idempotente `docs/roles-conexion-v2.sql` aplicado a `cps_security_v2` y
   verificado (los "permiso denegado" esperados). La app corre como `cps_web`;
   las migraciones usan `DB_MIGRATIONS_USER` (admin) desde el `.env`. Claves de
   desarrollo en el script y el `.env`; en producción se crean a mano.
5. ~~**Transferencia de titularidad de un hogar**~~ — **HECHO (2026-07-18)**:
   `POST /homes/:id/transfer-titular { newTitularUserId }` (solo gestores): el
   miembro ACTIVO elegido pasa a TITULAR y el saliente queda como FAMILIAR (el
   swap es atómico y no consume cupo); queda en `audit_log`
   (`home_member.titular_transfer`). En el front: botón "Hacer titular" en la
   pantalla de miembros del hogar. Probado E2E (transferencia, 400 ya-titular,
   404 no-miembro, 403 monitor, vuelta atrás).
6. **Servicio de alarmas** (programa separado, MQTT → `device_state` + `event` + FCM):
   diseñarlo recién cuando el resto esté estable.
7. Más adelante: 2FA para OWNER, estado ACKNOWLEDGED del evento (pospuesto a
   propósito), tests e2e del modelo v2.

## 4. Mapa de documentación

| Documento | Qué es | Estado |
|---|---|---|
| `CLAUDE.md` (raíz) | Guía para la IA: reglas del dominio y convenciones | vigente |
| `README.md` (raíz) | Vista general y cómo levantar | vigente |
| `docs/estado-proyecto.md` | este archivo | vigente |
| `docs/negocio-redisenado.md` | el negocio en lenguaje de negocio | vigente |
| `docs/diseno-relaciones-fase1.md` | diseño del modelo con el porqué de cada decisión | vigente (implementado) |
| `docs/esquema-postgres-v2.sql` | DDL, fuente de verdad del esquema | vigente |
| `docs/relevamiento-fase0.md` | análisis de las 3 fuentes que originó el rediseño | **histórico** |
| `backend-nestjs/docs/*` | detalle por módulo (modelo, negocio, activos, auth, seguridad, geografía, migraciones, handoff al front) | vigentes (v2) |
| `frontend-angular/docs/pendientes-y-decisiones.md` | estado del front (migrado a v2) + pendientes | vigente |
| `frontend-angular/docs/angular-ui-styles-spec.md` | especificación de estilos UI | vigente |

También existe un **esquema visual** del modelo publicado como Artifact (diagrama
ER por bloques): pedirle el link a la IA o regenerarlo desde `esquema-postgres-v2.sql`.
