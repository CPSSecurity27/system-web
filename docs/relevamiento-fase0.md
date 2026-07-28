# Relevamiento Fase 0 — Situación actual del sistema CPS

> ⚠️ **DOCUMENTO HISTÓRICO.** Describe la situación ANTES del rediseño; las
> divergencias que señala ya fueron resueltas y el backend ya implementa el modelo
> v2. Conservarlo como registro de por qué se decidió lo que se decidió. Para el
> estado actual: `estado-proyecto.md`.
>
> **Fecha:** 2026-07-16
> **Fuentes contrastadas:** (1) PDF `arquitectura_cps.pdf` (arquitectura lógica v1.0),
> (2) código actual (`backend-nestjs` + `frontend-angular`), (3) Firebase RTDB
> `cpssecurityarg` (modelo viejo, descartado — solo referencia).
> **Propósito:** base para la Fase 1 (diseño del modelo de relaciones objetivo).
> **Regla acordada (2026-07-16):** no se modifica código hasta tener el diseño completo
> cerrado. Primero diseño, después implementación.

---

## 1. Las tres fuentes en una línea cada una

| Fuente | Modelo | Estado |
|---|---|---|
| **PDF** | CPS → Organización (MUNICIPAL/PRIVATE) → Comunidad → Hogar **con alarma principal propia** | Visión original, parcialmente vigente |
| **Firebase RTDB** | organizations / communities / homes / devices / remotes / **events** / device_state, con inventario y provisioning | Descartado; evidencia del negocio real |
| **Código actual** | account (COMPANY/ORGANIZATION/HOME) + membresías → neighborhood → home; **la alarma es del barrio**, la vivienda tiene controles | Implementado y funcionando en local |

## 2. La divergencia conceptual central

**El PDF dice que cada hogar tiene UNA alarma principal. El código dice que las alarmas
son infraestructura del barrio (postes/sirenas en vía pública) y que la vivienda tiene
controles remotos que las disparan.** No es un detalle: define el modelo entero.

Evidencia del Firebase viejo: los devices son `type: community_alarm`, los eventos tienen
`scope: community | single`, y el hogar tenía apenas un `default_device_id` (preferencia,
no propiedad). La realidad física parece ser la del código. **Decisión a ratificar en Fase 1.**

## 3. Qué TENEMOS (código actual)

### Backend (NestJS + PostgreSQL + TypeORM)

- **Identidad y RBAC:** `app_user` + `account` + `account_user` (tabla puente).
  Una persona, N membresías con rol por cuenta. Roles = par `(account.type, role)`:
  COMPANY/ORGANIZATION admiten ADMIN y TECHNICIAN; HOME admite ADMIN (titular) y USER
  (familiar). Impuesto por CHECK + FK compuesta `(account_id, account_type)` en la base.
- **Multi-tenancy por contratos:** `ScopeService` deriva el alcance de los contratos
  ACTIVE (COMPANY → global; ORGANIZATION → sus barrios; HOME → su vivienda). Cierra el
  agujero del sistema viejo (cualquier admin municipal veía todo).
- **Auth completa:** JWT corto + refresh token rotativo y revocable (hasheado, con
  user_agent/IP), argon2id, forgot/reset password, verificación de email, bootstrap admin.
- **Geografía normalizada:** province/department/locality sincronizadas de la API georef
  (georef_id TEXT). Read-only.
- **Contratos (`service_contract`):** condiciones congeladas al firmar (price NUMERIC,
  max_family_members, remote_controls_enabled, fechas). Un solo contrato ACTIVE por
  destino (índice único parcial). Destino derivado del tipo de cuenta (CHECK).
- **Activos:** `device` (alarma comunitaria del barrio, serial UNIQUE) +
  `device_maintenance` (bitácora del técnico); `remote` (dueño = vivienda, portador =
  usuario, reasignable) + `remote_code` (códigos RF cifrados AES-256-GCM, tope 8 por
  esquema, reveal solo CPS y logueado).
- **Invariantes en código:** al menos un ADMIN por cuenta; USER de HOME ≤
  max_family_members del contrato ACTIVE; portador del control debe ser de la cuenta
  dueña del hogar; alarma del control debe ser del mismo barrio.
- Migraciones versionadas, `.env` validado al arrancar, docs internas de alta calidad.

### Frontend (Angular)

12 rutas maquetadas y cableadas a la API real (dashboard, barrios, viviendas, alarmas,
controles, cuentas, contratos, usuarios, perfil, login/reset). Aislamiento verificado
contra backend real. Pendientes propios listados en
`frontend-angular/docs/pendientes-y-decisiones.md`.

## 4. Mapeo PDF → código actual

| Concepto del PDF | En el código | Estado |
|---|---|---|
| Plataforma CPS | `account` COMPANY | ✅ equivalente |
| Organización MUNICIPAL / PRIVATE | `account` ORGANIZATION (sin subtipo) | ⚠️ se perdió la distinción municipal/privado |
| Comunidad | `neighborhood` | ✅ |
| Plan de Comunidad | campos congelados del `service_contract` | ⚠️ cambio de filosofía (ver §6.1); falta `community_mode_enabled` |
| Hogar | `home` + cuenta HOME | ✅ |
| Titular / Familiares | ADMIN / USER de la cuenta HOME | ✅ (sin DNI todavía) |
| Alarma principal del hogar | **no existe** — alarma es del barrio | 🔴 divergencia central (§2) |
| Controles remotos (1:1 usuario, 4 códigos) | dueño=vivienda, portador nullable, hasta 8 códigos | ⚠️ mejorado, contradice PDF; confirmar con hardware |
| Super Usuario CPS / Admin CPS | COMPANY+ADMIN (sin distinción entre ambos) | ⚠️ colapsados |
| Owner vs Admin (municipal) | solo ADMIN | ⚠️ colapsados |
| **Monitoreo** Municipal / Comunidad | **no existe rol de monitoreo** | 🔴 falta |
| Técnico Municipal | ORGANIZATION+TECHNICIAN | ✅ |
| Transferencia de comunidades | cancelar contrato + firmar otro con otra cuenta | ✅ resuelto por diseño (mejor que el PDF) |
| device.type extensible (SIREN, SENSOR…) | sin columna `type` | ⚠️ falta si se quiere crecer |
| Estados inventory/installed/retired | solo OPERATIONAL/MAINTENANCE/OUT_OF_SERVICE | coherente con "sin inventario" (§6.2) |
| App de vecinos (login DNI, 1 dispositivo) | **no existe nada** | 🔴 falta completa |
| Templates de configuración / MQTT | no existe | 🔴 falta (depende del canal de tiempo real) |
| 2FA / seguridad fuerte Owner | no existe | falta |
| Cascadas de suspensión | no implementadas | falta |

## 5. Qué FALTA (ordenado por peso)

1. **Eventos / activaciones de alarma** — el corazón operativo del negocio. El sistema
   viejo ya los tenía (snapshot del activador, GPS, modo `cps001`/`cps002`, scope
   community/single, resolución, respuestas de vecinos). En el nuevo está planificado
   (§8 del modelo) pero no existe. Sin esto no hay monitoreo posible.
2. **Canal de tiempo real / estado vivo** — decisión abierta (A: Firebase RTDB con custom
   token vs C: MQTT → NestJS → Redis → WebSocket). `device_state` del viejo muestra el
   contrato mínimo: `online`, `last_heartbeat`, `alarm.status`. FCM hace falta igual.
3. **Rol de MONITOREO** — el PDF lo define a nivel municipal y comunidad; el enum actual
   (ADMIN/TECHNICIAN/USER) no lo cubre. Un operador hoy tendría que ser ADMIN (excesivo).
4. **App de vecinos** — identidad por DNI (el `app_user` actual ni siquiera tiene DNI),
   OTP/verificación por teléfono, restricción de un dispositivo activo por persona,
   endpoints móviles, push FCM. El viejo `users_app` trackeaba sesión y plataforma.
5. **Modo comunidad** (`community_mode_enabled` + scope del evento) — existía en PDF y en
   Firebase; el contrato actual no lo contempla.
6. **Auditoría de acciones sensibles** — hay `created_by`/`updated_by` y un WARN en el
   reveal de códigos; falta bitácora consultable (quién vio códigos, transferencias,
   cambios de contrato). En un sistema de seguridad física es de primera clase.
7. **2FA** para roles altos (el PDF lo exige para Owner Municipal).
8. **Cascadas de estado** — suspender hogar/familiar/comunidad debe arrastrar controles y
   accesos según reglas explícitas (PDF §13.5). Hoy no hay máquina de estados formal.
9. **Subtipo de organización** (municipal/privada) — si el negocio lo necesita para
   reportes, facturación o UX diferenciada.
10. **`device.type`** — columna trivial de agregar, necesaria si vienen sirenas/sensores.
11. **Pendientes del frontend** — reasignar portador, cerrar contrato desde UI,
    verificación de email, coordenadas en formularios, paginación real.

## 6. Qué SOBRA o se descartó (y si estuvo bien)

### 6.1 Cambios de filosofía deliberados (documentados y defendibles)

- **"Plan de comunidad" → condiciones congeladas en el contrato.** El PDF quería que el
  plan viajara con la comunidad; el código congela condiciones por contrato (como una
  factura). Consecuencia: al transferir una comunidad las condiciones se re-pactan en el
  contrato nuevo. Es un modelo más honesto comercialmente. **A ratificar.**
- **Sin inventario de dispositivos.** El PDF y el Firebase viejo lo tenían (estados
  `inventory`, `claim_code`, `tested`, `manufactured_at`, hardware IMEI/ICCID/MAC). El
  código decidió que un equipo entra ya instalado. ⚠️ **Ojo:** si el flujo real de
  fábrica→depósito→instalación con claim codes existe (el viejo lo sugiere), esta
  decisión hay que revisarla o confirmar que el inventario es "otro sistema".
- **Control remoto: dueño ≠ portador.** Contradice el 1:1 del PDF y es mejor: si el
  familiar se va, el control queda en el hogar.
- **Sin rol OWNER separado** — el titular es el ADMIN de su cuenta HOME. Simplificación
  razonable *para hogares*; para organizaciones ver "Owner vs Admin" en §5.

### 6.2 Sobrantes reales del modelo viejo (bien descartados)

- Los 7 índices manuales del RTDB (`login_index`, `device_serial_index`, `home.members`,
  `home.remotes`, `community.stats`, particionado de events) → índices de Postgres.
- `community_map_public`, rol `guest`, deriva de esquema (`contact` en 2/16 hogares).
- Cloud Functions como transacciones a mano → transacciones reales.
- Estado vivo mezclado con registro → separación Postgres / canal de tiempo real.

## 7. Decisiones que la Fase 1 tiene que cerrar

| # | Decisión | Estado |
|---|---|---|
| D1 | ¿Alarma del barrio o del hogar? | **RESUELTO (2026-07-16): solo alarmas comunitarias, pertenecen al barrio.** El hogar tiene controles remotos, nunca alarma propia |
| D1b | Modelo comercial | **RESUELTO:** dos esquemas. PRIVADO: CPS gestiona la comunidad y **la comunidad entera contrata** (consorcio/grupo, no cada hogar). PÚBLICO: **solo la municipalidad contrata** (los vecinos no pagan a CPS). ⇒ desaparecen los contratos por vivienda; el alcance del titular ya no puede derivarse de contratos HOME |
| D1c | Autogestión municipal | **RESUELTO: opción A, autonomía total.** La muni crea barrios, hogares, vecinos y su personal desde su panel, operativos al instante. CPS se reserva equipos (inventario/provisioning), configuración avanzada y transferencias |
| D2 | Canal de tiempo real | **RESUELTO (2026-07-16): Firebase se elimina por completo.** Canal propio sobre NestJS + PostgreSQL (MQTT/WebSocket, a diseñar en Fase 1) |
| D3 | ¿Rol MONITOREO? | **RESUELTO: sí** — agregar `MONITOR`, válido en COMPANY y ORGANIZATION |
| D4 | ¿Inventario / provisioning con claim codes? | **RESUELTO: sí** — se incorpora al diseño |
| D5 | ¿Modo comunidad? | Sí — flag en contrato + scope en el futuro `event` |
| D6 | Identidad del vecino (DNI + OTP, 1 dispositivo) | DNI como identidad + OTP por teléfono; nunca DNI solo |
| D7 | ¿Subtipo MUNICIPAL/PRIVATE en ORGANIZATION? | Columna `subtype` informativa, sin lógica asociada por ahora |
| D8 | ¿Owner vs Admin en organizaciones? | Definir si hace falta un rol "root" no operativo |
| D9 | Auditoría | Tabla `audit_log` append-only desde ya |
| D10 | 4 vs 8 códigos por control | Confirmar con el hardware real |

## 8. Veredicto general

La base construida es **sólida y mejor que el PDF** en identidad/RBAC, multi-tenancy,
contratos y seguridad de datos. El PDF sigue aportando cosas que el código aún no tiene
(monitoreo, modo comunidad, app de vecinos, cascadas de estado, extensibilidad de
dispositivos). El Firebase viejo aporta la evidencia más valiosa de todas: **el modelo de
eventos y el flujo de provisioning que el negocio realmente usa**. El diseño objetivo de
la Fase 1 sale de cruzar esas tres cosas.
