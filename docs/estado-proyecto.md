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

    **Segunda pasada (2026-08-05): se auditó la pantalla y se cerró lo que
    faltaba de la `cfg`.** La primera versión cubría 8 de las 10 secciones que el
    panel acepta y validaba 4 de los 12 límites. Ahora está completa:
    - **Auto-apagado por modo** (`alarma.autooff`, los 7) y **`modulos.eeprom_slot`**:
      estaban en el spec como editables y no se habían implementado. Los valores
      no se perdían —el merge los repone del espejo— pero no había forma de
      cambiarlos.
    - **`hora.tz_offset_s` se validaba en ningún lado y es el peor de todos**:
      fuera de ±14 h el firmware descarta la cfg ENTERA y **no manda ack**, así
      que un huso mal tipeado dejaba la pantalla en "esperando confirmación" para
      siempre. Ídem `red_avanzada` incompleto. Además el campo pasó a editarse en
      HORAS: en segundos, escribir `-3` pensando en horas es un valor que entra
      en rango y rompe el reloj del equipo sin que nada avise.
    - **Largos de `ssid` (31) y `psw` (63) y `prio` (1..5)**: el firmware trunca
      en silencio y ackea `ok` — una clave larga dejaba el poste sin conectar con
      la pantalla diciendo "aplicado".
    - **`puedeEditar` no miraba el rol.** El hallazgo del MONITOR de la primera
      pasada había sobrevivido en el `GET`: el formulario le llegaba habilitado y
      el 403 recién al guardar. Ahora el `GET` y el `PUT` responden con la misma
      función (`cumpleMembresia`, la del guard).
    - **`reveal-wifi` era código muerto en el front**: el endpoint, el
      `audit_log` y su e2e existían, pero no había ningún botón que lo llamara.
    - **Redes bloqueadas por el panel** (`bl_perm`): una red bien cargada que el
      equipo puso en su lista negra no conectaba y nada lo explicaba.
    - **Estado `DESACTUALIZADA`**: tras un `factory` el espejo conserva la config
      vieja (no se deja pisar por `cfg_v = 0`) y la pantalla decía "verificado
      contra el equipo" sobre un panel con defaults de fábrica.
    - **Regresión de fondo, migración `RestoreConfigReconcile`**: `DeviceStateNetwork`
      (2026-08-05) reescribió `gtd.upsert_panel_state` para sumarle `p_red`/`p_tele`
      y **perdió el bloque que reconcilia `cfg_v`**. Con eso se había roto la red
      silenciosa de la escalera de confirmación —el `tele` es la única señal
      retenida, o sea la única que sobrevive a un GtD caído— y la detección del
      `factory`. Restituido y probado en los dos sentidos.
    - 31 casos e2e contra la base real (eran 19), 24 unitarios de límites (eran
      13) y 96 del front (eran 83).

    **Tercera pasada (2026-08-05): comandos, copiar configuración y la cola a la
    vista.** Con esto la pestaña queda cerrada salvo lo que se decidió no hacer.
    - **Pestaña "Acciones"** en la ficha del equipo, con los comandos agrupados
      por riesgo y `POST /devices/:id/commands`. Diagnóstico (`estado`, `hora`,
      `i2c_scan`) van derecho; `restart`, `ota` y `factory` muestran primero qué
      le pasa al equipo. `red bl_clear` destraba un SSID que el panel bloqueó —
      cerraba el agujero de la pasada anterior, donde la pantalla te decía que
      una red estaba bloqueada y no te dejaba hacer nada.
    - **`factory`: leído en el firmware, no supuesto.** Es `nvs_erase`, así que
      borra configuración y **credenciales WiFi** —el equipo queda incomunicado
      y hay que ir al poste— pero la base RF vive en la EEPROM externa y **los
      controles NO se borran**. Sí se pierde `rf_gen` (vive en NVS): cuando
      hagamos la base RF, un `gen = 0` significa "perdió la cuenta", no "libreta
      vacía". Pide escribir el serial: el firmware exige el `confirm` con el ID
      del equipo y el backend lo completa solo, pero la fricción es para el
      humano.
    - **Disparo remoto** (`POST /devices/:id/alarm`), la única acción sobre el
      equipo que suma al **MONITOR** — no es infraestructura, es la operación.
      Lo que pasó vuelve por el camino normal (`up t:alarma` → `event`), no por
      el ack.
    - **La cola de comandos a la vista**, con cancelar mientras siga `pending`.
      Sin ella, un comando esperando porque el equipo duerme era indistinguible
      de uno que nunca salió. `gtd.cancel_command` existía sin llamador.
    - **Copiar configuración de otro poste** del mismo barrio (`GET
      /config/sources`). No copia `central` (el alias es de cada equipo) ni las
      contraseñas, que no se leen por ningún lado.
    - **Los permisos los dice el backend**: la cola devuelve `puedeOperar` y
      `puedeDisparar` ya resueltos. Son dos matrices distintas y las dos
      dependen del barrio; deducirlas en el navegador era repetir el bug de
      `puedeEditar`.
    - 45 casos e2e (eran 31), 115 unitarios de backend y 116 del front.

    **Descartado (no reabrir)**: campañas masivas sobre N equipos.

    **Queda anotado, sin hacer**: `cmd t:cal` (calibrar tensiones — cambia lo que
    significan los voltajes y necesita un tester al lado del poste) y `cmd t:test`
    (probar un SSID puntual), las dos herramientas de campo; y el cifrado en
    reposo (DT2), con la observación del GtD de que cifrar Postgres no alcanza
    mientras la `cfg` viaje retenida en el broker.
    *(El catálogo de firmwares que figuraba acá se hizo el 2026-08-06 — punto 12.)*

    **Y lo más urgente sigue siendo la BASE RF** (punto 9), que está congelada a
    pedido hasta definirla: `gtd.enqueue_rf_batch` existe y **nadie la llama**,
    así que un control remoto cargado en la web no está en el panel y no dispara
    nada. Dos cosas anotadas para cuando se retome: la función **no manda `gen`**
    y el firmware lo exige (ausente vale 0, y el panel escribiría `rf_gen = 0`
    después de cada lote); y hay dos decisiones de negocio abiertas — qué DNI se
    graba (el control es del hogar, el portador es reasignable) y en qué postes
    del barrio se graba cada control.
11. ~~**Alta de equipos en el broker**~~ — **HECHA (2026-08-04)**. Fabricar un
    equipo desde la web ahora pide su credencial MQTT sola. Diseño en
    `docs/superpowers/specs/2026-08-04-provisioner-broker-design.md`.
    - **Sin túnel HTTP**: la web encola en `gtd.provisioning_queue` y un proceso
      aparte drena la cola. Web y GtD siguen compartiendo solo la base.
    - **El provisioner es un proceso APARTE del GtD** (`python -m gtd.provisioner`,
      su propio systemd unit). El GtD está encerrado a propósito
      (`NoNewPrivileges`, `ProtectSystem=strict`) porque recibe payloads de cada
      panel; registrar en el broker necesita escribir `/etc/mosquitto` y recargar
      el servicio. Comparten el repo —la derivación HMAC tiene que coincidir con
      el firmware— pero no el proceso.
    - **No reimplementa el HMAC**: invoca `deploy/provision-panel.sh`, que ya
      valida el salt contra un vector de verificación conocido y aborta sin
      registrar si no coincide.
    - **El `SALT_MQTT` vive solo en el provisioner.** La web nunca lo ve, y la
      cola no guarda ninguna password: se derivan.
    - Al script se le agregaron `revoke`, `--no-reload` y `--no-probe`. Los dos
      flags no son cosméticos: con 200 equipos serían 200 reloads, y la prueba de
      verificación publicaría 200 `status` falsos que el GtD tomaría como
      conexiones reales, ensuciando `first_connection_at` de toda la tanda.
    - **La baja es SIEMPRE manual**: ningún cambio de estado revoca nada
      (decisión de negocio). Como el olvido sería invisible, la ficha avisa
      cuando un equipo en `RETIRED` conserva su credencial.
    - Un `confirm` con error NO toca `device`: el hito solo se mueve cuando el
      broker aceptó de verdad.

    **Queda pendiente**: el `SALT_MQTT` de producción (PA4, acción humana — el
    flujo se prueba igual con un salt de desarrollo y una placa flasheada con el
    mismo), y **el despliegue**, que no se hizo. Cuando llegue: la Raspberry ya
    tiene PostgreSQL 17.10 corriendo (el `deploy/README.md` del GtD decía lo
    contrario y se corrigió), la base de producción se va a llamar
    **`cpssecurityarg`**, y hay que verificar las 16 migraciones contra 17 —acá
    se desarrolla en 18—. El GtD desplegado está en `6c5d600`, o sea antes del
    plan 1, corriendo con `StubRepo` y `GTD_PG_DSN` vacío.
12. **Controles remotos: el flujo completo** — EN CURSO (2026-08-05).
    Se paró el trabajo de alarmas para definir esto de punta a punta:
    fabricación → etiquetado → inventario → asignación a hogar y familia.

    **Fase 1, FABRICACIÓN Y ETIQUETA: HECHA.** Migración `RemoteFactory`.
    - **Catálogo `remote_model`** (al molde de `board_model`): lo que define un
      modelo es **cuántos botones tiene**. Nace con una sola fila, la de 4.
    - **El choque que apareció al leer el firmware**: la POSICIÓN del código
      decide qué hace el botón (1 emergencia, 2 sospechoso, 3 alerta, **4
      apagar**), y el panel guarda **4 por vecino y nada más**. O sea: un control
      al que le falte la posición 4 no puede cancelar una falsa alarma, y de un
      modelo de 6 botones dos teclas no disparan nada. Por eso los modelos de 2 y
      6 **se postergaron**: agregarlos es una fila, pero antes hay que decidir
      qué posiciones lleva cada uno.
    - **Serial `CR-000137`**, correlativo por secuencia. Sin el modelo adentro: el
      serial identifica, no describe, y así nunca puede mentir.
    - **Los códigos los elige CPS** y se graban en el control (decisión del
      2026-08-05, revierte el "los tipeamos a mano"). Se generan con
      `randomInt` de `node:crypto` en el rango del panel (10.000 a
      999.999.999.999).
    - **Tres caminos para el código, elegibles en la pantalla** (2026-08-06):
      *al azar* (el default, y el único en que un código no se puede adivinar),
      *correlativos* y *a mano*. El manual existía en la API desde el principio y
      ahora tiene pantalla: es para el control que ya trae sus códigos de fábrica
      y no se deja regrabar. Van los 4 o ninguno —mezclar tipeados con generados
      mostraría números que nadie sabe si están grabados— y el front valida rango,
      dígitos y repetidos antes de mandar, aunque el backend lo revalide igual.
    - **Numeración correlativa** (migración `RemoteCodeSequence`): sigue
      el último código emitido en vez de sortear, para grabar una tanda en orden.
      Va por secuencia y no por `MAX(código)`, que es imposible: los códigos
      están cifrados con IV aleatorio. Saltea los ya tomados — en correlativo los
      ocupados están todos juntos, así que chocar con la tanda anterior es lo
      normal, no la excepción.
    - **En la fábrica no hay apodo**: se trabaja por número de serie. El nombre lo
      pone la familia cuando el control llega a una casa.
    - **Buscador por serial o por código** (`GET /remotes/search`). Por código
      funciona gracias al HMAC de la unicidad: es determinístico, así que
      encuentra con un índice **sin descifrar nada**. Solo con el número
      completo —no se puede enumerar— y la respuesta trae qué BOTÓN coincidió,
      nunca los códigos.
    - **`code_hmac` con UNIQUE**: el cifrado usa IV aleatorio, así que hasta hoy
      **nada detectaba un código duplicado** — y como el `dni` que vuelve en la
      alarma es el que cargamos nosotros, un repetido es el monitoreo llamando a
      la casa equivocada. HMAC con clave, no un hash pelado: 12 dígitos se
      invierten con un diccionario.
    - **Etiqueta de 40 × 20 mm** (la del equipo son 90 × 45 y no entra en un
      llavero), con el serial escrito y un QR `CPS-CR|serial|modelo|4 códigos`.
      **Los códigos van en claro por decisión explícita**, con el costo asumido:
      una foto alcanza para clonar el control y para apagar la alarma del barrio.
      Lo que queda es trazabilidad — imprimir es solo-CPS y deja `audit_log`.
    - **Botón "Listo"** (migración `RemoteReady`), igual que en alarmas:
      fabricar no es estar listo, y hasta el visto bueno el control **no entra
      al stock**. `status` no podía decirlo — uno recién fabricado ya está en
      INVENTORY porque el CHECK de custodia lo exige. Se puede revertir.
    - La pantalla quedó al molde de la de alarmas: la tabla muestra **solo el
      número de serie y las acciones** (ver códigos, imprimir, listo), lista
      TODO lo fabricado —no solo la tanda de la sesión— y la etiqueta se imprime
      con `window.print()` sobre un bloque invisible, sin vista previa aparte.
    - **Papelera y borrado definitivo** (migración `RemoteRemoved`), espejo del
      equipo: remover / dar de alta / borrar, con `/inventario/controles/removidos`.
      Restaurar devuelve el control **sin el visto bueno**. Al borrar, **sus
      códigos vuelven a quedar disponibles** — sale solo del diseño: la reserva
      vive en el índice del HMAC y se va con el CASCADE. Removerlo NO los libera.
      Un control con eventos no se puede borrar.
    - **Aviso que hay que sostener**: remover un control **no lo deja sin
      efecto**. Sus códigos siguen grabados en cada panel y la web no los
      sincroniza. En el equipo ese hueco se cierra revocando la credencial del
      broker; acá el equivalente es `cmd t:rf op:del`, que es parte del flujo RF
      congelado. La pantalla lo dice explícito.
    - Pantalla `/inventario/controles`, solo CPS. 48 e2e contra la base real, 11
      unitarios del generador y 29 del front.

    **Fase 2, CUSTODIA COMPLETA: HECHA (2026-08-05).** Migración `RemoteClaimCode`.
    El recorrido entero, espejo del de la alarma:
    fábrica → stock CPS → **entrega de lote** o **adopción por código** → stock
    del cliente → **asignación** (municipio → barrio → casa → vecino) →
    **devolución** al stock.
    - **Código de reclamo** en el control (`claim_code`), con su consecuencia
      asumida: entra en la etiqueta de 40×20 mm que ya estaba cerrada. El serial
      no alcanzaba —está impreso a la vista y viaja en los listados—; el código
      es lo que demuestra que el control está en la mano.
    - **El portador es OBLIGATORIO al asignar** (decisión del usuario). El `dni`
      del portador es lo que viaja en la alarma, así que un control entregado sin
      nombre es un evento que después no se le puede atribuir a nadie. Cambiarlo
      después sigue siendo libre.
    - **CPS puede asignar directo** desde su stock, sin escala en el municipio.
      Costo asumido: el inventario del cliente no ve pasar ese control.
    - **Devolver al stock** (`POST /remotes/:id/return`): la familia lo entrega y
      el control queda listo para otra casa. Antes lo único posible era tirarlo a
      la papelera. Un control entregado NO se manda directo a otra casa: hay que
      devolverlo primero.
    - **Se eliminó el alta manual de controles** (`remote-form`): creaba
      controles sin serial, sin modelo y sin códigos — o sea que no podían
      funcionar. Todo control nace en la fábrica. El endpoint `POST /remotes`
      quedó sin pantalla: sacarlo es un pendiente chico.
    - Pantallas: inventario con **entrega de lote** y **adopción**, y
      `/controles/asignar` con el recorrido de cuatro pasos. La asignación NO se
      hace desde una fila: son cuatro decisiones encadenadas y la lista de
      controles disponibles depende del destino.
    - 17 e2e del flujo + 48 de la fábrica, y 164 tests del front.

    **Las tres pantallas avisan lo mismo, y hay que sostenerlo**: asignar no
    carga los códigos en los paneles y devolver no los borra. Hasta que exista la
    sincronización de la base RF, el vecino se lleva un llavero que las alarmas
    no conocen.

    **Fase 3, LA LISTA DE OPERAR: HECHA (2026-08-05).** `/controles` dejó de ser
    una grilla de tarjetas y pasó a **tabla con filtros y paginación del
    servidor** (espejo de Eventos). El número que lo decidió: una alarma lleva de
    10 a 120 controles, un barrio ~10 alarmas y una municipal ~10 barrios →
    **~12.000 llaveros**. `GET /remotes` devuelve `{items,total,limit,offset}` y
    cada fila viaja con vivienda, barrio, cliente y portador ya resueltos: antes
    traía todo y el front se bajaba además todas las viviendas para traducir
    `homeId → dirección`. Filtros en cascada cliente → barrio → alarma preferida,
    más estado y un buscador por DNI / serial / dirección / portador. Los códigos
    RF salieron de esa pantalla: se graban al fabricar y se revelan en Fábrica.

    **Fase 4, LA BASE RF EN EL PANEL: HECHA (2026-08-05).** Es lo que hace que el
    control efectivamente dispare. Migraciones `RemoteSync` + `RfSyncOnAck`.

    - **Regla de dominio nueva: una persona lleva UN control**
      (`uq_remote_one_per_carrier`). No es preferencia nuestra: la base del panel
      se indexa por **DNI** y guarda un registro por persona con hasta 4 códigos
      (`ee_client_t`), así que el segundo control del mismo portador nunca podría
      cargarse — el equipo lo rechaza con `EE_DUP`.
    - **Qué controles le tocan a un equipo**: los de las viviendas que lo tienen
      como **alarma preferida** (`home.default_device_id`). No todos los del
      barrio: en el chip entran ~126 vecinos.
    - **El estado no es un flag**: `remote.synced_device_id/_dni/_hash/_at`
      guardan lo que QUEDÓ CARGADO, y "pendiente" se deduce comparándolo con lo
      que debería estar. Cambiar el portador, editar un código, devolver el
      control o reportarlo perdido lo desincronizan solos.
    - **La cadena**: la tanda se encola entera pero solo el primer paso nace
      `pending`; el resto queda `queued` (estado nuevo que el GtD no ve) y
      `gtd.confirm_command` libera el siguiente con cada ack. El panel recuerda 8
      `cid` y bloquea ~2,25 s por lote: publicar 24 en ráfaga desbordaba su dedup
      y le tapaba la cola.
    - **El ack escribe el dominio**, en la base: cuando el panel contesta, del
      lado de Node no corre nadie. Mismo criterio que `confirm_provisioning`.
    - **Reportar un llavero perdido ahora lo saca del panel.** Era el agujero más
      grande que quedaba: hasta acá era un acto administrativo y el control
      seguía abriendo la alarma de esa gente.
    - Pantalla: bloque propio en la pestaña **Configuración** del equipo, con el
      conteo contra la capacidad real del chip y el motivo de cada control que no
      se puede cargar (sin portador, DNI de más de 8 dígitos, hueco de posición).
    - Se corrigió de paso un bug del GtD: `TeleMsg.rf_gen` leía una clave de
      primer nivel que el firmware no manda (viene en `rf.gen`), así que
      `device_state.rf_gen` era 0 para todos los paneles y la detección de
      desincronización comparaba contra un cero fijo.

    **Falta de este punto**: usar `op:"audit"` —los hashes por DNI que el panel ya
    sabe mandar— para detectar deriva REAL contra su memoria, y un "poner al día
    el barrio" que recorra todas sus alarmas. Con lo que hay, "sincronizado"
    significa *el panel ackeó que lo guardó*.
13. ~~**OTA: catálogo de firmwares y gestor de actualizaciones**~~ — **HECHO
    (2026-08-06)**. Detalle completo en `docs/ota.md`. Migraciones
    `FirmwareCatalog` y `OtaProgress`.

    **Lo que faltaba no era el firmware.** Al leerlo apareció que el OTA por MQTT
    y la carga local por el portal **ya estaban implementados** —el
    `ota_design.md §0` de allá dice que están pendientes y está desactualizado—.
    Lo que no existía era el otro extremo: de dónde salen los `.bin`. El origen
    automático apuntaba a un 404, verificado contra el servidor real.

    - **Son DOS OTA y no son lo mismo.** `new` es la última a desplegar;
      `emergency` es el **último bueno conocido**, que el equipo baja SOLO cuando
      se detecta roto. Publicar ahí la versión de la que trata de escapar anula
      el mecanismo, así que son dos acciones distintas y la pantalla avisa cuando
      apuntan al mismo release.
    - **El host tiene que ser el APEX.** `ota_url_is_allowed()` compara contra
      `cpssecurity.com.ar` EXACTO: servir los `.bin` desde `system.` los haría
      rechazar sin bajar un byte. Los dos dominios están en la misma Raspberry;
      falta pegar el `location /firmware/` del sitio institucional
      (`deploy/apex-firmware.conf`), que es el único paso con sudo.
    - **Del `.bin` se lee todo menos la versión.** `project_name`, tamaño y
      sha256 salen del `esp_app_desc_t`. La versión se tipea porque el
      `CMakeLists.txt` del firmware no define `PROJECT_VER` y la imagen declara
      su `git describe` (`f1a0459-dirty`). Propuesta F-OTA-1.
    - **`cmd t:ota` pasó a ser SOLO CPS.** Antes entraba por `CONFIGURAN_EQUIPOS`
      y un técnico de una organización podía mandar un OTA **con la URL que
      quisiera**; el contrato con el GtD ya pedía que fuera solo-CPS y nunca se
      había implementado en ningún lado. `restart` y `factory` no se tocaron.
      La cola devuelve un tercer flag, `puedeActualizar`.
    - **El progreso dejó de tirarse.** El panel ya mandaba `up t:ota` y el GtD ya
      lo guardaba en `uplink_raw`: nadie lo leía. `gtd.last_ota` lo expone como
      función y no como GRANT, porque `uplink_raw` tiene también los `cfg_full`
      con las passwords WiFi en claro.
    - **La selección múltiple NO es una campaña**: cada equipo recibe su comando
      y su `cid`, por la misma puerta que desde su ficha. Sin broadcast (el
      firmware lo prohíbe) y con el resultado equipo por equipo — va a haber
      rebotes, porque el panel rechaza el OTA fuera del modo de energía activo.
    - 30 unitarios de backend nuevos y 27 del front (235 en total).

    **Descartado (sigue sin reabrirse)**: campañas masivas automáticas.

    **Queda anotado, sin hacer**: el **mecanismo de actualizaciones pendientes**.
    Hoy un OTA a un equipo fuera de modo activo **se pierde** —el firmware
    contesta error y se termina ahí—, así que actualizar de noche una flota solar
    no actualiza nada. La idea es una cola nuestra que reintente cuando el equipo
    reporte modo activo; sigue decidiendo una persona qué equipos. Ojo con dos
    cosas: el `cmd t:ota` no tiene expiración (F-OTA-4) y el equipo no compara
    versiones, así que el reintento tiene que verificar que siga haciendo falta.

14. **Servicio de alarmas** (programa separado, MQTT → `device_state` + `event` + FCM):
   diseñarlo recién cuando el resto esté estable.
15. Más adelante: 2FA para OWNER, estado ACKNOWLEDGED del evento (pospuesto a
    propósito), alcance del personal de CPS (ver punto 7), tests e2e del modelo v2
    (`sembrar()` de `test/helpers.ts` sigue armando el modelo v1 y su suite está en
    rojo; los e2e de configuración y de provisioning no lo usan, siembran su
    propio fixture v2).

## 4. Mapa de documentación

| Documento | Qué es | Estado |
|---|---|---|
| `CLAUDE.md` (raíz) | Guía para la IA: reglas del dominio y convenciones | vigente |
| `README.md` (raíz) | Vista general y cómo levantar | vigente |
| `docs/estado-proyecto.md` | este archivo | vigente |
| `docs/negocio-redisenado.md` | el negocio en lenguaje de negocio | vigente |
| `docs/diseno-relaciones-fase1.md` | diseño del modelo con el porqué de cada decisión | vigente (implementado) |
| `docs/esquema-postgres-v2.sql` | DDL, fuente de verdad del esquema | vigente |
| `docs/ota.md` | actualización de firmware: las dos OTA, el catálogo y qué falta | vigente |
| `docs/propuestas-firmware-ota.md` | lo que le pedimos al repo del firmware (no se edita desde acá) | vigente |
| `docs/relevamiento-fase0.md` | análisis de las 3 fuentes que originó el rediseño | **histórico** |
| `backend-nestjs/docs/*` | detalle por módulo (modelo, negocio, activos, auth, seguridad, geografía, migraciones, handoff al front) | vigentes (v2) |
| `frontend-angular/docs/pendientes-y-decisiones.md` | estado del front (migrado a v2) + pendientes | vigente |
| `frontend-angular/docs/angular-ui-styles-spec.md` | especificación de estilos UI | vigente |

También existe un **esquema visual** del modelo publicado como Artifact (diagrama
ER por bloques): pedirle el link a la IA o regenerarlo desde `esquema-postgres-v2.sql`.
