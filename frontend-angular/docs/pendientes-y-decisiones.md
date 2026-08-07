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

> **Revertido en parte el 2026-08-02** (ver §5): el **DNI volvió a ser
> obligatorio** y es la identidad del vecino; el email quedó opcional. Lo que
> sigue vigente de esta sección es el mecanismo de activación por mail, que
> ahora es un atajo y no el único camino.

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

## 5. Viviendas, vecinos y ubicación del barrio (2026-08-02)

Diseño completo en `../../docs/superpowers/specs/2026-08-02-viviendas-y-vecinos-design.md`.

- **`/viviendas/nueva` cambió de forma**: se fue el campo Nombre (la
  **dirección** identifica la vivienda), el **GPS pasó a obligatorio** —el
  botón queda deshabilitado hasta marcar el mapa— y entró la sección
  **Titular** (nombre y DNI visibles, teléfono / nacimiento / correo plegados).
  Es **una sola llamada**: el backend crea vivienda, persona y titularidad en
  una transacción.
- **Alarma preferida sugerida por cercanía**: al marcar la casa, el combo se
  precarga con la alarma del barrio más cercana y muestra la distancia. El
  cálculo es un haversine local (`metrosEntre` en `home-form.ts`), sin
  librería nueva.
- **Miembros del hogar**: el alta pide **nombre + DNI** (el DNI es el login del
  vecino) y usa `addPerson` — una llamada en vez de las dos de antes, que
  podían dejar un vecino suelto en el padrón si fallaba la segunda. Badge
  **"Sin activar"** por miembro sin contraseña (`activated`, que el backend
  deriva de `password_hash IS NOT NULL`).
- **Listas**: la columna Nombre pasó a Dirección en `/viviendas`, en la ficha
  del hogar, en el detalle del barrio y en los combos de controles.
- **Cupos del barrio**: switch nuevo **"Puede activar todo el barrio"**
  (`communityScopeEnabled`), al lado del de controles remotos. Solo CPS, como
  el resto de los cupos. Ídem en el formulario de planes.
- **Ubicación del barrio editable**: tarjeta nueva en el detalle del barrio con
  mapa clickeable y botón "Guardar ubicación" (`PATCH /neighborhoods/:id`, que
  ya existía en el backend pero no tenía UI ni método en el servicio del
  front). La ve **CPS siempre**, y el OWNER/ADMIN de la organización **solo si
  `managedBy === 'ORGANIZATION'`**: en un barrio vendido llave en mano el
  cliente lo ve pero no lo mueve, y el backend devuelve 403 igual.
- **Ubicación de la ALARMA editable**: el mapa del detalle del equipo pasó a ser
  clickeable (`PATCH /devices/:id`, ídem: existía sin UI). Acá el permiso es más
  ancho a propósito — **gestores y TÉCNICOS**, de CPS o de la organización: el
  que subió a la escalera tiene que poder corregir el punto. Un equipo en
  INVENTORY no se puede ubicar (no está en ningún lado todavía). Si la alarma no
  tiene coordenadas, el mapa igual se muestra clickeable y **abre centrado en su
  barrio** (una llamada extra a `/neighborhoods/:id`, que si falla no rompe
  nada: cae al default).
- **`app-map` distingue qué es cada punto**: `MapMarker.variant` opcional —
  `device` (verde), `home` (azul), `center` (naranja, más chico y translúcido).
  Antes todo era del mismo verde y una alarma y una casa eran indistinguibles.
  El default sigue siendo `device`, así que los usos viejos no cambian.

## 6. Notas de entorno (siguen vigentes)

- Node 22/24 (los impares: warning de Angular + `localStorage` experimental
  rompe jsdom en tests — por eso el `InMemoryTokenStorage`).
- Leaflet: `allowedCommonJsDependencies` + `divIcon` propio.
- Datos de prueba: la base `cps_security_v2` quedó sembrada por el E2E del
  backend; credenciales en `../../docs/estado-proyecto.md` §3.1.
- Verificación: `npx tsc --noEmit && npx ng build && npm test -- --watch=false`
  (no hay eslint en este proyecto; formato con `npx prettier --write`).


## Navegación de Inventario (2026-08-05)

Quedó así, y el porqué de cada corte:

| Menú | Ruta | Qué es |
|---|---|---|
| Alarmas | `/inventario/alarmas` | **stock** de alarmas |
| Controles | `/inventario/controles` | **stock** de controles |
| Fábrica (solo CPS) | `/inventario/fabrica` | el ingreso al sistema, con pestañas Alarmas / Controles |

**Lo que estaba mal.** El menú decía *Alarmas · Fábrica · Controles*, pero
"Fábrica" era **solo** la de alarmas y "Controles" apuntaba a la **fábrica** de
controles, no a su stock. Encima el shell de Inventario tenía sus propias
pestañas Alarmas/Controles que saltaban a las dos fábricas: estabas mirando
stock y el menú te ofrecía fabricar.

**La regla que ordena esto.** La FÁBRICA es el único lugar donde las dos
familias comparten pestañas, y ahí sí corresponde: fabricar es el mismo trabajo
para las dos —una estación, una tanda, una etiqueta— y quien está en la mesa
pasa de una a la otra. En INVENTARIO no: ahí las preguntas son distintas (a qué
barrio va una alarma, a qué vivienda va un control) y mezclarlas obligaba a
saltar entre pestañas que no tenían nada que ver con lo que se estaba mirando.

Las papeleras cuelgan de su fábrica (`/inventario/fabrica/alarmas/removidos` y
`.../controles/removidos`), así las pestañas siguen a la vista.

Los links viejos redirigen. **Ojo con uno**: `/inventario/controles` cambió de
significado —era la fábrica de controles, ahora es su stock—, así que
`controles/nuevo` apunta explícito a `/inventario/controles/alta`.


## `/controles`: de tarjetas a tabla paginada (2026-08-05)

La pantalla de controles entregados era una grilla de tarjetas de dos columnas,
cada una con el portador, la devolución y un panel de códigos RF adentro. Se
rehízo como **tabla con filtros y paginación del servidor**, espejo de Eventos.

**El número que decidió todo:** una alarma lleva de 10 a 120 controles, un barrio
tiene ~10 alarmas y una municipal ~10 barrios → **~12.000 llaveros**. Con eso:

- Un acordeón por vivienda quedaba descartado: sirve para "qué tiene la familia
  X" y falla justo en la pregunta que se hace todos los días, "dónde está el
  control del DNI 30.111.222".
- Achicar la tarjeta tampoco: 12.000 tarjetas chicas siguen siendo 12.000.

**Lo que cambió del lado del dato.** `GET /remotes` devolvía un array con TODO el
alcance, y encima la pantalla se bajaba todas las viviendas para traducir
`homeId → dirección`. Ahora devuelve `{ items, total, limit, offset }` y cada
fila viaja con vivienda, barrio, cliente y portador ya resueltos.

**El orden lo pone el backend**: barrio → dirección → serial. Los controles de
una misma casa caen juntos, así que se lee agrupado sin pagar el acordeón.

**Los filtros**: cliente → barrio → alarma preferida (en cascada; la alarma se
habilita recién con un barrio elegido, porque las alarmas se listan por barrio),
más estado y un único buscador por DNI, serial, dirección o portador, con
debounce de 400 ms. El selector de cliente aparece solo si hay más de uno.

**`?homeId=` sigue funcionando** (viene de la ficha del hogar) pero ahora se
muestra como chip: la lista recortada tiene que decir por qué lo está.

**Se fue el botón de códigos RF.** Los códigos se graban al fabricar y se
revelan en Fábrica, las dos cosas solo CPS. El operador que busca un llavero no
necesita el número que tiene grabado adentro, y tenerlo acá era una superficie
de exposición sin uso.

**Sin filtros la pantalla muestra la página 1 con el total real** ("1–50 de
11.842") en vez de exigir elegir un cliente antes de ver nada: los filtros están
ahí arriba y esconder la lista no ayudaba a nadie.


## La base de controles, en la pestaña de Configuración (2026-08-05)

El bloque que carga los códigos de los controles en la memoria del equipo vive
en `Configuración`, pero es un **componente aparte** (`app-device-rf`) y no un
campo más del formulario.

**Por qué aparte.** La base RF no es configuración: no tiene `cfg_v`, no se
mergea, no es retained y no entra en el diff de "vas a cambiar". Es una cola de
comandos con su ack. Adentro de `DeviceConfigTab` parecería un campo más, y el
día que alguien apriete "Descartar cambios" esperaría que también descartara
esto. Va **arriba** de la configuración: decide si un llavero dispara o no, y eso
pesa más que un huso horario.

**Lo que muestra, y por qué así.** Los que ya están cargados son un **número**,
no una lista: lo que pide una decisión es lo que falta. Los que no se pueden
cargar vienen con la explicación **escrita por el backend** — la regla es del
firmware (la base se indexa por DNI, los botones se llenan en orden desde el
primero) y no se reescribe en dos idiomas. El conteo va contra la capacidad REAL
del chip que reporta el equipo, no contra un número fijo.

**Dos honestidades que la pantalla sostiene**: los lotes salen de a uno y esperan
la respuesta del equipo, así que con el panel dormido esto avanza cuando
despierte; y no se puede apurar, porque cada alta le hace barrer la memoria
entera (~2,25 s por lote de 5). Las dos cosas se dicen antes de apretar, para
que nadie crea que se colgó.


## Corregir dónde está una casa (2026-08-06)

Faltaba: el GPS de la vivienda se carga al darla de alta y **no había forma de
corregirlo**. Un pin mal puesto quedaba mal para siempre, y no es un dato
decorativo — sale en el mapa del monitoreo y viaja en el `gps` de cada evento,
así que un error manda al móvil a otra cuadra.

El backend ya lo aceptaba (`PATCH /homes/:id` con `latitude`/`longitude`): era
un agujero solo del front.

**Dónde vive**: una tarjeta "Dónde está" al pie de la ficha de la vivienda
(`/viviendas/:id`), calcada de la pestaña Instalación de la alarma, que resuelve
exactamente lo mismo. Se hace click en el mapa, **se ve el punto nuevo antes de
guardar** y recién ahí se confirma: que mover el pin sin querer se guardara solo
sería peor que no poder moverlo.

**El botón que faltaba** está en la lista de viviendas y dice "Ubicación". Va a
la misma ficha que "Miembros", pero con su propia etiqueta y ancla: nadie iba a
buscar el pin de una casa detrás de un botón que dice "Miembros".

**Quién puede**: el que gestiona el barrio y el **TITULAR de esa casa** — el
mismo conjunto que acepta el backend. Ojo con `auth.isTitular()` a secas: dice
que sos titular de ALGUNA casa, no de esta, y usarlo acá le daría el botón al
titular de la casa de enfrente. Hay un test para eso.

**Lo que a propósito NO se toca desde acá**: el barrio. Mudar una casa arrastra
sus miembros, sus controles ya sincronizados y su alarma preferida — no es una
corrección, y el backend además exige gestionar el barrio destino. Tampoco se
recalcula la alarma preferida: mover el pin unos metros no cambia nada, pero
corregir una casa cargada en la otra punta del barrio puede dejarla apuntando a
un poste lejano. La pantalla lo avisa; no decide por el gestor.
