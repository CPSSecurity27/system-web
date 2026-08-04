# Estado del proyecto — CPS Security

> **Actualizado:** 2026-08-02. Este es el documento de arranque para cualquier
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
clientes = organizaciones MUNICIPAL/COMMUNITY con OWNER institucional; el subtipo
dice la ESCALA y `managed_by` dice QUIÉN OPERA cada barrio (dos ejes, nunca uno
derivado del otro); sin cuentas HOME ni contratos por vivienda (vecinos =
`home_member`); cupos = tarifa solo-CPS con grandfathering, por rol, con 0 = "ese
rol no existe acá"; el plan es plantilla que se copia, no fuente que se lee; CPS no
es un cliente y vive en su propia sección; **la CANTIDAD de eventos es ilimitada**
(no hay cupo de eventos) — ojo, el `community_mode_enabled` de Firebase volvió el
2026-08-02 como `neighborhood.community_scope_enabled`, pero es otra cosa: no
limita cuántos eventos se disparan sino si el vecino puede hacer sonar TODO el
barrio (ver punto 8);
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
6. ~~**Alta de equipos desde la MAC**~~ — **HECHO (2026-07-28)**: se leyó el repo
   del **GtD** (`github.com/CPSSecurity27/gateway-to-device`, el servicio de
   alarmas) y se alineó la identidad del equipo con su contrato.
   - `ALARM_PANEL` → **`COMMUNITY_ALARM`** ("panel" es la cajita de una casa,
     justo lo que la regla 1 dice que esto no es).
   - **`serial` ya no se elige: se deriva de la MAC** (`AV-<12 hex mayúsculas>`)
     y un CHECK lo ata. Ese string es a la vez el usuario MQTT, el client_id y
     el `<id>` del tópico (`av/AV-A842E38FCA6C/status`) — de eso depende que la
     ACL del broker sea una regla `pattern av/%u/…` para toda la flota.
   - `POST /devices` pide **MAC + número de placa** (`ALOY0043`), los dos leídos
     del equipo físico. Normalización y validaciones en `src/devices/mac.ts`
     (con tests): rechaza la MAC de ceros (lectura fallida de esptool), la de
     broadcast y las multicast. Avisos que no bloquean: OUI desconocido y saltos
     en la numeración de placas.
   - Tabla **`board_model`** (catálogo, hoy solo `ALOY`) + `device.board_seq`.
     El string impreso se COMPONE, no se guarda.
   - `mqtt_provisioned_at/by` nacen vacías: la credencial MQTT se deriva con
     `HMAC-SHA256(SALT_MQTT, MAC)` y **el salt de producción no está del lado
     servidor** (punto abierto PA4 del GtD). Mientras tanto la web muestra el
     bloque `provisioning` como **log**, con el comando a correr en el server.
   - **La base hay que rehacerla**: los equipos viejos no pasan el CHECK nuevo.
   - Detalle: `backend-nestjs/docs/activos.md`.
7. ~~**Organización de cuentas: planes, cupos por rol y separación de CPS**~~ —
   **HECHO (2026-07-30)**. Migración `AccountPlansAndRoleQuotas`:
   - **`PRIVATE` → `COMMUNITY`**. El subtipo ahora dice SOLO la escala (municipal =
     varios barrios, comunitaria = uno). Antes decidía también quién opera, lo que
     fusionaba dos ejes y hacía imposibles dos ventas reales.
   - **`managed_by` pasa a ser la puerta.** Quién opera un barrio se decide **por
     barrio** y es explícito en el alta (llave en mano o autogestión); ya no se deriva
     del subtipo. Con `managed_by = CPS`, la organización dueña VE su barrio pero no lo
     gestiona — ni el barrio, ni sus viviendas, ni sus vecinos. Vive en un solo lugar
     (`ScopeService.managesNeighborhood`) y el TITULAR de un hogar queda al margen.
     La transferencia de barrio ahora PRESERVA `managed_by` salvo orden explícita.
   - **Cupos por rol**: `max_admin_users` y `max_technician_users` junto al de monitores.
     **Cupo 0 = ese rol no existe en la cuenta**, con mensaje distinto al de cupo
     agotado. Con eso, "la comunitaria no tiene técnicos propios" es un número y no una
     regla especial escondida. El CHECK de la base ahora exige los cuatro cupos en toda
     ORGANIZATION y ninguno en COMPANY.
   - **Tabla `plan`**: catálogo comercial. Es una PLANTILLA — al vender, los cupos se
     COPIAN a la cuenta. `account.plan_id` queda como etiqueta histórica, nunca como
     origen de lectura: un plan leído en vivo rompería grandfathering y auditoría.
     Endpoints solo-CPS (`/api/plans`), sin DELETE (se discontinúa con `active: false`).
     Dos planes semilla: `COMUNITARIA_BASE` y `MUNICIPAL_BASE`.
   - **Frontend reorganizado**: `/cuentas` → `/clientes` (filtrada a ORGANIZATION, con
     redirects desde las rutas viejas) y sección nueva **Mi Empresa** (`/empresa`) con
     Personal y Planes. CPS salió de la lista de clientes porque no lo es — la base ya
     lo decía (una sola COMPANY, sin cupos, sin contratos) y la UI era el único lugar
     que la trataba como una cuenta más, con un "—" en cada columna. Personal reusa el
     MISMO componente que la ficha de un cliente, resolviendo el id desde la sesión.
   - **La base hay que rehacerla igual** (ver punto 6): el rename entra en el mismo tren.

   **Queda anotado, sin hacer**: el personal de CPS no se puede acotar a nada. Las FK
   compuestas de `staff_assignment` exigen que el barrio sea de la propia cuenta, y
   COMPANY no tiene barrios, así que hoy cualquier MONITOR o TECHNICIAN de CPS ve la
   flota entera de todos los clientes. Con los socios siendo empleados internos deja de
   ser urgente, pero sigue siendo un agujero de alcance.
8. ~~**Viviendas y vecinos**~~ — **HECHO (2026-08-02)**. Diseño en
   `docs/superpowers/specs/2026-08-02-viviendas-y-vecinos-design.md`, migración
   `HomeAddressAndNeighborResident` (probada up → down → up contra
   `cps_security_v2`). Se auditó la base Firebase real (`cpssecurityarg`, RTDB:
   16 viviendas, 21 usuarios) para decidir contra datos y no contra la memoria.
   - **La DIRECCIÓN identifica la vivienda**: se elimina `home.name`. Firebase
     nunca tuvo nombre de vivienda y no le hizo falta; con los dos campos el
     gestor escribía la dirección en el nombre.
   - **GPS obligatorio** (16 de 16 lo tenían). El teléfono del hogar queda
     opcional (1 de 16 lo tenía) — el número que sirve es el de la persona, que
     es el que viaja al evento como `activator_phone`.
   - **El titular se carga en el mismo acto que la vivienda**: `POST /homes`
     escribe `app_user` + `home` + `home_member(TITULAR)` en una transacción.
     DNI repetido → 409 que dice **en qué vivienda y barrio** está esa persona.
   - **El DNI vuelve a ser la identidad del vecino** y el email pasa a opcional
     (revierte la decisión v2.1 de email obligatorio: en el alta real hay
     vecinos sin correo y el formulario se trababa ahí). El vecino nace con
     `password_hash` NULL y la ficha lo muestra **"sin activar"**.
   - **Una persona vive en una sola casa**: `uq_user_single_titular` (parcial)
     pasa a `uq_home_member_one_home` UNIQUE(user_id). Sin esto, un vecino en
     dos barrios hacía ambiguo qué barrio despertar.
   - **`community_scope_enabled`**, cupo nuevo del barrio (y del plan): habilita
     `event.scope = COMMUNITY`, o sea disparar TODAS las alarmas del barrio
     desde la app. Era `plan.community_mode_enabled` en Firebase y se había
     perdido en el rediseño. Solo CPS lo escribe, con `audit_log`.
   - `app_user.birth_date`, opcional. Sin parentesco: `home_member.role` sigue
     siendo TITULAR/FAMILIAR y nada más. El usuario `guest` de Firebase no se
     portó.

   **Queda anotado, sin hacer**: (a) la **activación del vecino por DNI** es del
   backend de la app, que todavía no está definido — el panel solo deja la
   cuenta activable; (b) `plan.max_family_members` y `remote_controls_enabled`
   **no se copian al crear un barrio** (nace con los defaults de la base), y
   `community_scope_enabled` hereda el mismo hueco a propósito: arreglarlo toca
   el alta de cliente y es un trabajo aparte.
9. ~~**Puente con el GtD**~~ — **HECHO E INTEGRADO (2026-08-04)**. El contrato
   se cerró el 2026-08-03 y el 2026-08-04 se decidió **liderar el enlace desde
   acá** (los dos repos en la misma máquina): las 8 preguntas del doc 06 del
   GtD se resolvieron como decisiones (tabla en `contrato-gtd-postgres.md`
   §15) y se implementó TODO en los dos repos a la vez — firma v2 de
   `upsert_panel_state` (estado durmiendo/`sleep_until`, `last_seen` del
   servidor, `fw`, reloj declarado `ts_device`+`tsq`), `fetch_pending_macs`
   (el barrido), `mark_config_failed` + estado `failed`, y del lado Python
   `PgRepo`/`PgListener` reales con spool en disco, guarda de 1024 y
   normalización de MAC. **16 casos de integración en verde** contra
   `cps_security_v2` con el rol `cps_alarms` real
   (`gateway-to-device/tests/test_pg_integracion.py`), incluidos los dos
   negativos de permisos. La ficha del equipo muestra "Durmiendo hasta las
   HH:mm". Deploy contra producción: espera el `SALT_MQTT` (PA4).
   Documento: `docs/contrato-gtd-postgres.md`. Una sola base compartida y
   **contrato por funciones** en un esquema `gtd`: el GtD no toca ninguna tabla,
   así un cambio de mapeo es una migración nuestra y no un deploy coordinado.
   - Las **8 funciones de entrada son 1:1 con su `Protocol Repo`**
     (`upsert_panel_state`, `insert_evento`, `confirm_command`,
     `upsert_config_espejo`, `fetch_pending_*`, `mark_*_sent`). Se descartó la
     idea original de una función por tópico MQTT (`ingest_status/tele/up`):
     sus pipelines ya normalizan, y eso los habría obligado a reescribirlos.
   - **4 funciones de salida** nuestras: `enqueue_command`, `publish_config`,
     `cancel_command`, `enqueue_rf_batch`.
   - `panel_state` y `eventos` de ellos **no se importan** (duplicarían
     `device_state` y `event` — rompe la regla 5). Sí se adoptan `commands` y
     `panel_config`, más `config_espejo` y `uplink_raw` nuestras.
   - Migraciones que habilita: `device_state` crece (`vbat`/`vpanel`/`vfuente`,
     `modo_energia`, `alarma_mode`, `cfg_v`, `rf_gen`, `fw`, `last_seen`) y
     `event` crece (`external_id` para el dedup por `eid`, `ts_device`, `tsq`).
   - **Hallazgo grande**: la base RF (qué código pertenece a qué vecino) la carga
     **el servidor** con `cmd t:rf op:batch`. Un código que no está en el panel
     **no dispara nada**. Sin ese flujo, el barrio tiene alarmas que no suenan.
   - Bloqueante que sigue abierto: `SALT_MQTT` de producción (PA4). Hay interín
     con `PANEL_PASSWORD` explícita para probar con una placa.
   - **Para entregarle al equipo del GtD**: `docs/gtd-guia-implementacion.md`
     (cómo escribir `PgRepo`/`PgListener` contra las funciones, con código de
     referencia en asyncpg). El `.md` de diseño y el porqué está en
     `docs/contrato-gtd-postgres.md`.
10. ~~**Configuración por equipo**~~ — **HECHA (2026-08-04)**. Pestaña
    "Configuración" en la ficha de la alarma: redes WiFi, módulos, tiempos, hora,
    auto-off, roaming y mantenimiento. Diseño en
    `docs/superpowers/specs/2026-08-04-configuracion-por-equipo-design.md`,
    detalle de permisos y límites en `backend-nestjs/docs/activos.md`.
    - **Sin tabla de configuración**: el espejo (`gtd.config_espejo`) es la verdad
      de lectura y `gtd.publish_config` el único camino de escritura. Una tabla
      propia sería un tercer lugar donde vive el mismo dato.
    - **La configuración es POR EQUIPO**, sin capa de barrio. Se descartó la
      herencia a propósito: cada panel reporta y se configura individualmente.
      Para el caso "40 postes con el mismo WiFi" queda anotado el atajo de copiar
      la configuración de otro equipo — **no está implementado**.
    - **Confirmación en escalera**: el ack marca `applied`, un `cmd t:refresh`
      encadenado trae el espejo y recién ahí es *verificado*. El `tele` (cada 300 s,
      retenido) reconcilia solo si las dos primeras se pierden. La pantalla nunca
      muestra como vigente algo que el equipo no confirmó.
    - Migración `GtdConfigFunctions`: `gtd.confirm_config` (el ack de una `cfg` no
      trae `cid` y caía en el dead letter) y `gtd.last_scan`.
    - **El scan de redes es a pedido**: interrumpe la máquina de estados del WiFi
      y, mientras dura, el panel no está siendo una alarma.
    - **Hallazgo de seguridad**: el MONITOR podía configurar equipos. El rol dice
      QUÉ y la membresía dice DÓNDE, y solo estaba el segundo eje. Lo agarró el e2e.
    - Tres propuestas nuevas al firmware (F4-F6) en
      `gateway-to-device/docs/08-propuestas-firmware.md`. La F4 es una línea que
      nos deja sacar el `refresh` encadenado de toda la flota.

    **Queda anotado, sin hacer**: copiar configuración de otro equipo; `cmd t:test`
    (probar un SSID puntual, es la herramienta del técnico en la calle); campañas
    masivas sobre N equipos; y el cifrado en reposo (DT2), que sigue abierto y con
    la observación del GtD de que cifrar Postgres no alcanza mientras la `cfg`
    viaje retenida en el broker.
11. **Servicio de alarmas** (programa separado, MQTT → `device_state` + `event` + FCM):
   diseñarlo recién cuando el resto esté estable.
12. Más adelante: 2FA para OWNER, estado ACKNOWLEDGED del evento (pospuesto a
    propósito), alcance del personal de CPS (ver punto 7), tests e2e del modelo v2
    (`sembrar()` de `test/helpers.ts` sigue armando el modelo v1 y su suite está en
    rojo; el e2e de configuración no lo usa, siembra su propio fixture v2).

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
