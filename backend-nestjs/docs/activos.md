# Activos — alarmas comunitarias, inventario y controles remotos (v2)

## La distinción que define todo

**La alarma es del BARRIO, no de la vivienda.** Un poste con sirena en la vía
pública, compartido. La vivienda tiene **controles remotos** que disparan las del
barrio (y a lo sumo una alarma *preferida*: `home.default_device_id`, siempre del
mismo barrio).

## Cadena de custodia (v2: HAY inventario)

Igual para alarmas (`device`) y controles (`remote`):

```
FÁBRICA CPS               STOCK DE ORGANIZACIÓN         EN SERVICIO
status = INVENTORY    ->  status = INVENTORY        ->  alarma  -> barrio
organization_id NULL      organization_id = cliente     control -> hogar
```

- **Alta (fabricación): SOLO CPS** (`POST /devices`, `POST /remotes` sin destino).
  El device nace con `serial` + **`claim_code`** (único, de un solo uso).
  El alta de una alarma se hace **desde la MAC** — ver la sección siguiente.
- **Entrega del lote**: CPS mueve stock a una organización (`PATCH` de
  `organizationId`, solo válido en INVENTORY — CHECK de la base).
- **Instalación por reclamo**: `POST /devices/claim { serial, claimCode,
  neighborhoodId }`. Técnicos de CPS reclaman cualquier equipo; los de una
  organización, **solo de SU stock y para SUS barrios**. Así la muni se
  autoinstala sin que CPS pierda el control del stock. Queda en `audit_log`.
- Controles: la entrega física a una vivienda es `POST /remotes/:id/assign
  { homeId }`. Desde ahí la vivienda es dueña y el `homeId` no se toca más.
- Stock visible en `GET /devices/inventory` y `GET /remotes/inventory`
  (CPS ve todo; una organización, lo suyo).

## Alta de fábrica: desde la MAC

En la estación de flasheo se carga el equipo con **dos datos que se LEEN de la
placa** y no se inventan:

| Dato | De dónde sale |
|---|---|
| **MAC** | `esptool read_mac` — la MAC STA del eFuse, única e inmutable |
| **N° de placa** | impreso en la placa por el fabricante: `ALOY0043` |

```jsonc
POST /api/devices    // SOLO CPS
{ "mac": "A8:42:E3:8F:CA:6C", "boardNumber": "ALOY0043" }
```

El **`serial` no se manda**: se deriva como `AV-<12 hex mayúsculas>` y el CHECK
`chk_device_identity` lo impone en la base. Ese string es, a la vez, el usuario
MQTT, el client_id y el `<id>` del tópico (`av/AV-A842E38FCA6C/status`) — de que
sean el mismo string depende que la ACL del broker sea **una** regla
`pattern av/%u/…` para toda la flota en vez de cinco líneas por equipo.

El número de placa entra en **un solo campo**: el modelo va adentro del string
impreso, el backend parte `ALOY0043` en prefijo + número y resuelve el prefijo
contra `board_model`. Un campo menos en una estación donde se carga todo el día
es un error menos. Lo que se guarda es `board_model_id` + `board_seq`; el string
completo se **compone**, nunca se almacena.

**Validaciones de la MAC** (en `src/devices/mac.ts`, con tests propios):
se acepta con o sin `:`/`-` y en cualquier caja; se rechazan la de ceros (es lo
que devuelve `esptool` cuando **falla** la lectura), la de broadcast, y las
multicast (el bit 0 del primer byte prendido: una MAC STA de ESP32 nunca lo
está, así que hay un dígito mal leído).

**Avisos que NO bloquean** (`warnings` en la respuesta): el OUI del chip no
coincide con el de ningún equipo ya cargado, o hay un salto en la numeración de
placas (suele ser una placa fabricada que nunca se registró).

### El bloque `provisioning` — hoy es un log

La respuesta trae qué le falta al equipo para conectarse al broker: usuario
MQTT, los cinco tópicos, y el comando a correr en el server. **Todavía no se
registra la credencial**: la derivación `HMAC-SHA256(SALT_MQTT, MAC)` necesita el
`SALT_MQTT` de producción, que no está del lado servidor (punto abierto PA4 del
GtD). Las columnas `mqtt_provisioned_at/by` nacen vacías para no migrar filas
cuando el salt llegue, y para poder listar los equipos a medio provisionar.

## Etapas de puesta en marcha (hitos)

Entre que un equipo se da de alta y que conecta por primera vez hay pasos que
la fábrica necesita ver. **La etapa no se guarda: se DERIVA del último hito
alcanzado.** Una columna de etapa sería un segundo lugar donde vive el mismo
dato, libre de contradecir a las fechas.

| Etapa | Hito | Quién lo escribe |
|---|---|---|
| CREADO | `created_at` | el alta |
| PROVISIONADO | `mqtt_provisioned_at` | el registro de la credencial en el broker |
| ETIQUETADO | `labeled_at` | CPS, desde la fábrica |
| 1.ª CONEXIÓN | `first_connection_at` | **el servicio de alarmas** (o CPS a mano) |

`deviceStage()` evalúa de atrás para adelante y **no exige** que los anteriores
estén cumplidos: en la práctica un equipo se puede etiquetar antes de
provisionarse, y una etapa que mienta por "saltear" un paso sería peor que una
que informe hasta dónde llegó. El detalle fino lo da `milestones`, que expone
los cuatro por separado.

### Por qué `first_connection_source`

La primera conexión es un hecho **observado** por el broker — regla 5: el
estado vivo lo escribe el servicio de alarmas, no la web. Como el GtD todavía
no escribe, CPS puede marcarla a mano; en ese caso queda
`first_connection_source = 'MANUAL'`, con el autor en `first_connection_by` y
el override en `audit_log`. Un dato medido y uno cargado a dedo no valen lo
mismo, y la pantalla muestra la diferencia (ícono de mano en el badge).

Dos CHECK sostienen esto: la fecha y su origen viajan juntos o no viajan, y un
hito MANUAL siempre tiene autor.

```
PATCH /api/devices/:id/milestones   { labeled?: boolean, connected?: boolean }
```

Solo CPS. `true` sella el hito con la hora **del servidor**, `false` lo borra
(para poder deshacer un equipo cargado por error sin un UPDATE a mano). La
fecha nunca se acepta del cliente: un hito con fecha elegida por quien lo carga
deja de ser evidencia de nada.

## `board_model` — el catálogo de modelos

Una fila por modelo de placa (hoy solo `ALOY`); el `code` es **solo el prefijo**,
sin dígitos. Es catálogo y no enum para que un modelo nuevo sea un INSERT y no
una migración con deploy, y porque tarde o temprano hay que colgarle atributos
del hardware: hoy `remote_code` tiene clavado `position BETWEEN 1 AND 4` con el
comentario "el hardware tiene 4", y el día que un modelo soporte 8 ese CHECK pasa
a ser mentira.

`active = false` **discontinúa** un modelo (no se fabrica más) sin tocar los
equipos ya hechos con él. El `code` no se puede editar: los equipos componen su
número impreso con él.

```
GET   /api/devices/board-models        el desplegable
POST  /api/devices/board-models        solo CPS (OWNER/ADMIN)
PATCH /api/devices/board-models/:id    renombrar o discontinuar
```

## `device` — la alarma

Postgres guarda la **configuración** (serial, tipo, estado administrativo,
ubicación, hardware IMEI/ICCID/MAC, modelo y n° de placa, tested). `device.type`
es extensible (`COMMUNITY_ALARM` hoy; SIREN/REPEATER/SENSOR reservados y
**rechazados con 400** en el alta: una rama que nadie probó es donde se cuelan
los bugs). El `serial` es la identidad física y **no se puede cambiar**.

> Se llama `COMMUNITY_ALARM` y no "panel" a propósito: un panel es la cajita en
> la pared de una casa, que es exactamente lo que la regla 1 dice que esto no es.

El **estado vivo** (`online`, `last_heartbeat`, disparada) vive en **`device_state`**:
una fila por device, UPDATE in place, **la escribe SOLO el servicio de alarmas**
(programa aparte; GRANTs en §13 del SQL v2). La web la lee: `GET /devices/:id/state`.

Bitácora del técnico: `device_maintenance` (la cargan técnicos de CPS o de la
organización; la lee también el gestor del barrio).

## Fábrica de controles (2026-08-05)

Fabricar un control es **un solo acto atómico**: modelo, serial y códigos entran
en la misma transacción. Antes se creaba el control y los códigos se cargaban
después de a uno, así que "control a medio cargar" era un estado normal de la
base — y un control sin códigos es un llavero que no hace nada.

```
GET   /api/remotes/models          el catálogo
POST  /api/remotes/models          uno nuevo (solo CPS)
PATCH /api/remotes/models/:id      renombrar o discontinuar (solo CPS)
POST  /api/remotes/manufacture     fabricar (solo CPS)
GET   /api/remotes/:id/label       los datos de la etiqueta (solo CPS, auditado)
```

### El modelo es la cantidad de botones, y eso choca con el firmware

`remote_model` es un catálogo al molde de `board_model`. Lo que define un modelo
es **cuántos botones tiene**, porque eso decide cuántos códigos se cargan.

Hoy hay **una sola fila, la de 4**, y es la única que el panel aprovecha entera:

| Posición | Botón | Qué hace |
|---|---|---|
| 1 | A | Emergencia |
| 2 | B | Sospechoso |
| 3 | C | Alerta |
| 4 | D | **Apagar** |

Sale de `POS_TO_MODE` en `components/alarma_core/alarma_core.c`, que el firmware
llama "tabla ÚNICA del sistema". Dos consecuencias que no son nuestras:

- **La posición no es el orden de carga: es qué hace el botón.** Un control al
  que le falte la posición 4 es un control con el que el vecino **no puede
  cancelar** una falsa alarma.
- **Más de 4 botones no entran.** `MQTT_RF_CODES_PER_CLI` es 4, el registro del
  panel tiene `code[4]` con máscara de 4 bits y `remote_code.position` va de 1 a
  4. Un modelo de 6 puede existir en el catálogo, pero dos de sus teclas no
  disparan nada. El alta avisa cuántas quedan afuera.

Los modelos de 2 y 6 se agregan como filas cuando se decida qué posiciones lleva
cada uno. No hace falta migración.

### El serial: `CR-000137`

Correlativo, por secuencia. A diferencia del equipo —cuyo serial se DERIVA de la
MAC y por eso no se elige— el control no tiene identidad propia que copiar.

Va **sin el modelo adentro** a propósito: el serial identifica, no describe. Qué
modelo es se pregunta, y así un serial nunca puede mentir.

### Los códigos los elige CPS

Se generan con `randomInt` de `node:crypto` (no `Math.random`: estos números son
la única credencial del control, y un generador predecible sería un control
clonable a partir del serial del vecino de al lado). El rango es el que el panel
guarda: **10.000 a 999.999.999.999** (`EE_CODE_MIN`/`EE_CODE_MAX`).

**`correlativo: true`** sigue la numeración del último código emitido en vez de
sortear, para grabar una tanda en orden y verificarla de un vistazo. Lo lleva la
secuencia `remote_code_seq` y **no** un `MAX(código)`, que sería imposible: los
códigos están cifrados con IV aleatorio y su HMAC es opaco, así que averiguar el
último obligaría a descifrar la tabla entera en cada fabricación.

El correlativo **saltea** los números ya tomados (hasta 500 seguidos). El tope es
mucho más alto que los 5 reintentos del sorteo por una razón concreta: al azar
una colisión en 10^12 valores es un accidente, pero en correlativo los ocupados
están **todos juntos** y alcanzar la tanda de ayer es lo normal.

El apodo **no se pide en la fábrica**: acá se trabaja por número de serie, y el
nombre lo pone la familia cuando el control llega a una casa. El `POST` rechaza
un `name` en vez de ignorarlo, para que quien lo mande se entere.

Los códigos también se pueden cargar a mano por API —o van los cuatro, o
ninguno— para el caso en que el hardware no se deje programar. No tiene pantalla:
es la salida de emergencia, no el camino.

### `code_hmac`: el duplicado que era invisible

`code_encrypted` es AES-256-GCM **con IV aleatorio**, así que el mismo código
guardado dos veces da bytes distintos: sobre esa columna **no hay índice único
posible**. Hasta 2026-08-05 nada impedía cargar dos veces el mismo código.

No es cosmético: el panel resuelve el `dni` buscando el código en su base local,
y ese `dni` es el que cargamos nosotros. Dos controles con el mismo código es una
alarma atribuida a la casa equivocada, con el monitoreo llamando a un vecino que
no apretó nada.

La solución es una segunda columna con un **HMAC-SHA256 determinístico** y un
UNIQUE. Con clave (`REMOTE_CODES_KEY`, la misma que cifra) y **no un hash
pelado**: el espacio de entrada son 5 a 12 dígitos y un SHA-256 sin clave sobre
eso se invierte con un diccionario, lo que convertiría la columna del índice en
una filtración de los códigos.

Los dos caminos de carga lo escriben —`manufacture` y `POST /:id/codes`—: si uno
solo lo hiciera, el duplicado entraría por el otro.

### Fabricar no es estar listo

`remote.ready_at` es el mismo peldaño que el del equipo, y existe por lo mismo:
entre fabricar y poder entregar hay un rato en la mesa —grabar los códigos en el
control, pegarle la etiqueta, probar que transmita— y durante ese rato el
control existe pero no puede salir.

**`status` no podía decir esto.** Uno recién fabricado ya está en `INVENTORY`,
porque `chk_remote_custody` lo exige mientras no tenga vivienda. Son dos
preguntas distintas: `status` dice dónde está en su ciclo de vida, `ready_at`
dice si pasó por el visto bueno. Sin el hito, un control aparecía en el stock
apenas se le asignaba un serial —o sea antes de tener los códigos grabados— y
alguien podía entregarle a un vecino un llavero que todavía no era nada.

`GET /remotes/inventory` filtra por `ready_at IS NOT NULL`. `POST
/remotes/:id/ready` marca y **desmarca** (`{ listo: false }`): el error más común
es marcar de más, y obligar a borrar el control para corregirlo sería peor que
el error. Las dos direcciones quedan en `audit_log`.

`GET /remotes/manufactured` es el registro de la fábrica: todo lo que tiene
serial, lo último arriba, **sin códigos**.

### Papelera y borrado definitivo

Espejo del equipo: `POST /remotes/:id/remove` (a la papelera, desvincula de la
vivienda y vuelve a INVENTORY), `POST /remotes/:id/restore` y `DELETE
/remotes/:id` (solo OWNER, solo desde la papelera). `GET /remotes/removed` los
lista. Los removidos salen del registro de fábrica y del stock.

**Restaurar devuelve el control SIN el visto bueno**, aunque lo tuviera. Pasó por
la papelera: alguien tiene que mirarlo otra vez —que los códigos sigan grabados,
que la etiqueta esté legible— antes de que se lo pueda entregar. Es el mismo
criterio que el claim code nuevo del equipo restaurado.

**Al borrar, los códigos vuelven a quedar disponibles.** No hay código que lo
haga: la reserva vive en el índice único sobre `code_hmac`, así que cuando el
CASCADE se lleva las filas de `remote_code` se va la reserva con ellas y otro
control puede recibir esos números. Removerlo NO los libera —un control en la
papelera puede volver, y liberarlos sería poder restaurarlo con los códigos de
otro—. Los dos casos tienen su e2e.

Un control con EVENTOS no se puede borrar: `event.remote_id` es ON DELETE
RESTRICT. El error lo dice en castellano en vez de mostrar una violación de FK
(ojo: Postgres usa DOS códigos para eso, `23503` y `23001` — ver
`src/common/db-errors.ts`).

> **Lo que la papelera NO hace: dejar el control sin efecto.** Sus códigos siguen
> grabados en la EEPROM de cada panel y la web todavía no los sincroniza. En el
> equipo, remover revoca la credencial del broker y eso alcanza; acá el
> equivalente es un `cmd t:rf op:del` a cada panel del barrio, que no existe. La
> pantalla de removidos lo dice con todas las letras en vez de dejar que alguien
> suponga que removerlo alcanza.

### Buscar por serial o por código

`GET /remotes/search?q=`, solo CPS. Por serial es un `ILIKE`; **por código es un
regalo del HMAC**: como la huella es determinística, un código conocido se
convierte en la misma huella y se encuentra con un índice **sin descifrar nada**.
Sobre la columna cifrada sería imposible — con IV aleatorio, el mismo código
guardado dos veces no se parece ni a sí mismo.

Dos propiedades que salen de eso y conviene tener escritas:

- **Solo encuentra con el número completo.** No hay prefijos ni rangos, así que
  no se puede enumerar la flota probando: quien busca ya tiene el número.
- **La respuesta nunca trae códigos**, solo qué POSICIÓN coincidió. Devolverlos
  sería un camino de lectura sin auditar justo al lado del que sí lo está.

Un texto todo dígitos se busca por las dos puntas —puede ser un código o el
número de un serial— porque adivinar cuál quiso decir el operario sale peor que
mostrarle los dos.

### La etiqueta: 40 × 20 mm, con los códigos en el QR

El QR lleva `CPS-CR|<serial>|<modelo>|<c1,c2,c3,c4>`. Formato propio y corto: en
14 mm de lado cada carácter son más módulos, y JSON habría gastado un tercio del
espacio en llaves. Nivel de corrección **Q** y no M —al revés que la del equipo—
porque un llavero se raya y se moja mucho más que un gabinete.

**Los códigos van en claro, por decisión explícita (2026-08-05)**, con el costo
sobre la mesa: el panel no valida nada más que el número de 64 bits, así que una
foto de la etiqueta alcanza para clonar el control y —con la posición 4— para
apagar la alarma del barrio. Como el riesgo se aceptó, lo que queda es la
trazabilidad: pedir los datos de la etiqueta es solo-CPS y deja
`remote.label_print` en `audit_log`.

Los códigos van además **escritos** abajo del QR: son lo que hay que grabar en el
control, y si el QR no lee el operario tiene que poder tipearlos.

## Custodia del control: stock → cliente → vivienda (2026-08-05)

Espejo de la alarma, con los dos caminos de entrada al stock y uno de salida:

```
POST /api/remotes/deliver      lote CPS -> stock de un cliente (solo CPS)
POST /api/remotes/adopt        serial + código: la bolsa que ya está en la mano
POST /api/remotes/:id/assign   stock -> vivienda, CON portador
POST /api/remotes/:id/return   vivienda -> stock (la familia lo devolvió)
```

**El portador es OBLIGATORIO al asignar.** El modelo admite un control "en el
cajón de la casa" (`assignedToUserId` NULL) y así queda si después se lo sacan,
pero al ENTREGAR se exige nombre: el `dni` del portador es lo que viaja en la
alarma cuando alguien aprieta el botón, así que un control entregado sin nombre
es un evento que después no se le puede atribuir a nadie. Tiene que ser miembro
de ESA vivienda.

**CPS puede asignar directo desde su stock**, sin escala en el municipio
(decisión del 2026-08-05). El costo asumido: el inventario del cliente no ve
pasar ese control.

**Devolver** deja el control en el stock de quien opera el barrio —no en el de
fábrica— y sin portador. Desde ahí se lo puede dar a otra casa; sin esto, un
llavero devuelto solo se podía tirar a la papelera. Un control ya entregado NO se
puede mandar directo a otra casa: hay que devolverlo primero, y el error lo dice.

> **Lo que ninguna de estas operaciones hace: tocar los paneles.** Asignar no
> carga los códigos en las alarmas del barrio y devolver no los borra. Mientras
> no exista la sincronización de la base RF, el vecino se lleva un llavero que
> los paneles no conocen —y no dispara nada— y el devuelto sigue abriendo la
> alarma de esa gente. Las tres pantallas lo dicen explícito.

### El código de reclamo

`remote.claim_code`, 6 caracteres del mismo alfabeto que el de la alarma (sin
`0/O` ni `1/I`, porque se dicta por teléfono). Lo genera la fábrica y va impreso
en la etiqueta, escrito y en el QR.

El serial no alcanzaría para adoptar: está impreso a la vista y viaja en cada
listado, así que cualquiera que vea una etiqueta podría pasar el control a su
stock. El código es lo que demuestra que lo tenés en la mano. Al restaurar desde
la papelera se regenera — el anterior quedó impreso en una etiqueta que puede
andar dando vueltas.

El error de un código equivocado es el MISMO que el de un serial inexistente: si
se distinguieran, el endpoint sería una forma de averiguar qué seriales existen.

### El listado de entregados: filtrado y paginado (2026-08-05)

`GET /api/remotes` devuelve **una página, no un array**:

```
{ items, total, limit, offset }     limit por defecto 50, tope 200
```

Filtros, todos opcionales: `organizationId` (el CLIENTE dueño del barrio),
`neighborhoodId`, `homeId`, `defaultDeviceId`, `status` y `q`.

**Por qué dejó de ser un array.** Una alarma lleva de 10 a 120 controles, un
barrio tiene ~10 alarmas y una municipal ~10 barrios: son ~12.000 llaveros. El
listado los traía TODOS, y el front encima se bajaba todas las viviendas para
traducir `homeId → dirección`. Ahora cada fila viaja con su vivienda, barrio,
cliente y portador —solo esas columnas, con joins— y el front no pide nada más.

**`defaultDeviceId` es la alarma PREFERIDA del hogar** (`home.default_device_id`,
la que suena en un evento SINGLE), no `remote.device_id` (dónde están grabados
sus códigos). Son dos preguntas distintas; la del operador es la primera.

**`q` es un solo buscador** para las cuatro formas de nombrar un control: serial,
apodo, dirección de la vivienda, y nombre o DNI del portador. El DNI se compara
sin puntos —en la base va limpio y el que busca lo escribe como se lo dictaron—.

Dos cosas que el listado **no** muestra: el **stock** (tiene su pantalla, y sus
filas no tienen barrio, cliente ni portador, o sea nada de lo que se filtra) y
los **removidos** (`removed_at` los saca de todas las listas; hasta acá esta se
lo salteaba).

**Los filtros INTERSECTAN el alcance, nunca lo ensanchan.** Pedir el barrio de
otro cliente devuelve una página vacía y no un 403: decir "existe pero no lo
ves" ya es contar algo.

## Sincronización de la base RF (2026-08-05) — cimientos

Asignar un control es un acto administrativo: **el panel no lo conoce**, y un
código que el panel no tiene no dispara nada. Esto es lo que va a cargarlo de
verdad. La migración `RemoteSync` puso la base; el flujo se construye encima.

### Lo que impone el firmware (leído, no supuesto)

| Hecho | Dónde | Consecuencia |
|---|---|---|
| La base se indexa por **DNI**, un registro por persona, hasta 4 códigos | `eeprom_store.h` (`ee_client_t`) | **Una persona, un control** — regla nueva del dominio |
| ~126 registros (AT24C32) | `EE_MAX_CAPACITY` / geometría | Ese es el techo real de controles por alarma |
| `modulos.eeprom.kb` viene en **KILOBYTES** (`size_bytes / 1024`) | `mqtt_payload.c` | Un AT24C32 reporta **4**, no 32 — el ejemplo `"kb":32` de `mqtt_design.md` contradice al código del panel |
| 5 DNIs por comando, ~2,25 s cada lote | `EE_SAVE_BATCH_MAX` | 120 controles = 24 comandos ≈ 1 minuto |
| `op:batch` es **alta pura** y aborta en el primero que falla | `ee_store_save_one` → `EE_DUP` | Actualizar = `del` y después `batch`; **las bajas van primero** |
| `op:batch` llena las posiciones **en orden desde 0** | `mqtt_parse.c` | Un control con hueco de posición no se puede expresar: se saltea |
| `op:del` borra la **persona entera** | `EE_OP_DEL_CLIENT` | Cambiar de portador es baja + alta |
| `op:"sync"` (snapshot masivo) **no existe** | eliminado en `portal_design §1.10` | Solo deltas + auditoría |
| El panel recuerda los últimos **8 `cid`** | `MQTT_CID_RING_N` | Publicar 24 lotes en ráfaga rompe su dedup |
| `gen` ausente vale **0** sin error | `get_u32` | Un comando sin `gen` deja al panel reportando "vengo de fábrica" |

`ee_status` en el `det` del ack: `1` no existe · `2` **base llena** · `6`
duplicado · `8` la cola EEPROM no respondió.

### El modelo

`remote.synced_device_id / _dni / _hash / _at` guardan **lo que quedó cargado**.
No es un flag "sincronizado" —eso hay que acordarse de bajarlo—: "pendiente" se
deduce comparándolo con lo que debería estar (alarma preferida del hogar + DNI
del portador + hash de sus códigos), así cambiar el portador, editar un código o
devolver el control lo desincronizan solos. `synced_dni` no es redundante: al
volver al stock el control pierde el portador y sin ese dato no sabríamos qué
borrar. `synced_hash` usa el **mismo FNV-1a que `rf_client_hash`**, para poder
comparar contra `op:audit` sin descifrar ningún código.

### La cola encadenada

`gtd.enqueue_rf_sync(device_id, pasos, user_id)` encola la tanda entera pero solo
el primer paso nace `pending`; el resto queda en el estado nuevo `queued`, que el
GtD no ve. `gtd.confirm_command` destraba el siguiente con cada ack, cancela los
que quedan si uno falla, y le saca los códigos al payload cumplido. Un `del` que
vuelve con `ee_status 1` cuenta como éxito: es el caso normal al reintentar.

`device.rf_gen` es la generación que asignamos, **+1 por comando**: el panel
persiste la del último que le salió bien, así el número que reporta dice hasta
dónde llegó la tanda.

### El plan, y quién escribe el estado

`RfSyncService` compara lo que DEBERÍA estar contra lo que está y arma los pasos.
Los códigos se descifran ahí —la clave AES no está en la base y así tiene que
seguir— y el hash FNV-1a se calcula sobre el claro.

Un control se **saltea, diciendo por qué**: sin portador (la base es por DNI),
DNI que no entra en 8 dígitos, sin códigos, con **hueco de posición** (el panel
llena los botones en orden desde el primero: un hueco correría los demás y el
botón de emergencia pasaría a ser otro) o porque no hay lugar en el chip.

Y el estado no lo escribe el servicio: lo escribe **`gtd.confirm_command` con el
ack en la mano**, leyendo de `gtd.commands.meta` qué controles cubría el paso.
Cuando el panel contesta, del lado de Node no corre nadie.

```
GET  /api/devices/:id/rf        qué está cargado, qué falta, qué sobra
POST /api/devices/:id/rf/sync   arma el plan y lo encola (CONFIGURAN_EQUIPOS)
```

El GET solo pide VER el equipo —entender por qué un control no dispara es parte
de mirarlo— y trae `puedeSincronizar` + `impedimento`, calculados con la misma
lista que usa el guard del POST.

### Lo que falta (fases 3 y 4)

El bloque en la pantalla de Configuración del equipo, y el fix del GtD:
`TeleMsg.rf_gen` lee una clave de primer nivel que el firmware no manda (viene en
`rf.gen`), así que `device_state.rf_gen` es siempre 0. Queda para más adelante
usar `op:audit` para detectar deriva real contra el panel.

## `remote` — el control

**DUEÑO ≠ PORTADOR**:

| campo | qué es |
|---|---|
| `homeId` (no se cambia una vez asignado) | la **vivienda es dueña** |
| `assignedToUserId` (nullable) | quién lo **lleva encima**; NULL = "en el cajón" |

Reglas que impone el código:

- **El cupo manda**: sin `neighborhood.remote_controls_enabled`, no hay altas.
- El portador debe ser **miembro del hogar** (`home_member` — ya no cuentas).
- La alarma del control (`deviceId`) debe ser **del mismo barrio** que la vivienda.

El titular puede reasignar el portador dentro de su casa y reportar el control
perdido (PATCH sin guard de cuenta: su permiso es la membresía de hogar).

## `remote_code` — SENSIBLE

Son los códigos RF que **ABREN LA ALARMA**. **4 por control** (M2: el hardware
tiene 4), impuesto por el esquema (`UNIQUE (remote_id, position)` + `position
BETWEEN 1 AND 4`).

- Cifrados con **AES-256-GCM** en NestJS antes de insertar (`iv (12) || authTag
  (16) || ciphertext`, IV random SIEMPRE). La base nunca ve un código en claro.
- `select: false`; nunca se loguea el valor.
- GCM es autenticado: si alguien altera un byte en la base, el descifrado FALLA
  con error de integridad (con CBC habría devuelto basura en silencio).
- La clave `REMOTE_CODES_KEY` (32 bytes base64) vive en el `.env`, no en la base.
  Si se pierde, los códigos son irrecuperables: se reprograman los controles.
  Se valida al arrancar.

### Quién ve los códigos

| | `GET /codes` (posiciones) | `GET /codes/:id/reveal` (en claro) |
|---|---|---|
| CPS (OWNER/ADMIN/TECH) | ✅ | ✅ **único que puede** |
| Gestor del barrio | ✅ | ❌ 403 |
| Titular | ✅ (los de su control) | ❌ 403 |

Cada `reveal` queda en el log (WARN) **y en `audit_log`** (quién, cuándo, qué
control y posición).

## Endpoints

```
GET    /api/devices?neighborhoodId=          instaladas, por alcance
GET    /api/devices/inventory                stock (CPS todo; org el suyo)
GET    /api/devices/:id/state                estado vivo (solo lectura)
GET    /api/devices/board-models             modelos de placa (desplegable)
POST   /api/devices/board-models             solo CPS (OWNER/ADMIN)
PATCH  /api/devices/board-models/:id         renombrar / discontinuar
POST   /api/devices                          SOLO CPS — alta desde MAC + n° de placa
POST   /api/devices/claim                    técnicos CPS/org: serial + código
PATCH  /api/devices/:id                      solo CPS; serial inmutable
PATCH  /api/devices/:id/milestones           solo CPS; etiquetado / 1.ª conexión
GET|POST|PATCH /api/devices/:id/maintenances bitácora

GET    /api/remotes?...                      ENTREGADOS, filtrado y paginado
GET    /api/remotes/inventory                stock
POST   /api/remotes                          CPS/gestor (con homeId) · CPS (stock)
POST   /api/remotes/:id/assign               entrega: stock -> vivienda
PATCH  /api/remotes/:id                      + titular (portador de SU casa)
GET    /api/remotes/:id/codes                posiciones, NUNCA el código
POST   /api/remotes/:id/codes                solo CPS; se cifra antes de insertar
GET    /api/remotes/:id/codes/:cid/reveal    solo CPS; auditado
DELETE /api/remotes/:id/codes/:cid           solo CPS
```

## Configuración del equipo (2026-08-04)

**No hay tabla de configuración.** `gtd.config_espejo` (lo que el panel DICE que
corre, después de los clamps silenciosos del firmware) es la verdad de lectura, y
`gtd.publish_config` el único camino de escritura. Una tabla propia sería un
tercer lugar donde vive el mismo dato, libre de contradecir al espejo y a la cola.

Diseño completo y el porqué de cada decisión:
`docs/superpowers/specs/2026-08-04-configuracion-por-equipo-design.md`.

### Quién puede qué

| Rol | Ver | Configurar | Ver passwords WiFi |
|---|---|---|---|
| CPS (OWNER/ADMIN/TECHNICIAN) | sí | sí | sí (auditado) |
| ORGANIZATION, barrio con `managed_by = ORGANIZATION` | sí | sí | no |
| ORGANIZATION, barrio con `managed_by = CPS` | sí | **no** | no |
| MONITOR (cualquiera) | sí | **no** | no |

**Los dos ejes son obligatorios y se validan por separado.** El ROL va en
`@RequireMembership(...CONFIGURAN_EQUIPOS)` del controller; el ALCANCE, en
`assertManagesNeighborhood` dentro del servicio. Con solo el segundo, un MONITOR
de la organización pasaba: tiene el barrio en su alcance y `managesNeighborhood`
responde por la CUENTA, no por el usuario. Lo agarró el e2e.

**Y la MISMA pregunta la responde el `GET`, no solo el `PUT`.** El campo
`puedeEditar` empezó mirando únicamente el alcance, así que al MONITOR le
llegaba el formulario habilitado y el 403 recién al apretar Guardar: la mitad
del bug original había sobrevivido en la respuesta de lectura. Ahora los dos
usan `cumpleMembresia(user.memberships, CONFIGURAN_EQUIPOS)`, que es la misma
función que corre `MembershipGuard` — dos implementaciones de esto se separan
sin que nadie lo note. `puedeVerPasswords` funciona igual con
`VEN_PASSWORDS_WIFI`. Las dos listas viven en `src/devices/device-permissions.ts`
porque las necesitan el controller y el servicio, y en el controller el import
iría en círculo.

### Los límites son del firmware

Viven en `src/devices/device-config.limits.ts`, cada uno con su archivo y línea de
origen. Se validan de nuestro lado **aunque el firmware clampe**, porque el
firmware clampa en silencio y ackea `ok`: sin esto, alguien pide 5 s de telemetría,
la pantalla dice "aplicado" y el equipo quedó en 30.

| Campo | Límite | Qué hace el panel si te pasás |
|---|---|---|
| `redes` | 5 (`WIFI_MAX_PROFILES`) | ignora las que sobran |
| `redes[].ssid` | 31 caracteres | **trunca** (y el equipo no conecta) |
| `redes[].psw` | 63 caracteres | **trunca** (y el equipo no conecta) |
| `redes[].prio` | 1 … 5 | reasigna por orden en el array |
| `tiempos.send_tele_s` | 30 … 86400 | clampa |
| `hora.tz_offset_s` | −50400 … +50400 | **descarta la cfg ENTERA, sin ack** |
| `alarma.autooff.<modo>` | 120 … 1800, por cada uno de los 7 | clampa |
| `modulos.eeprom_slot` | 0 … 1 | lo toma con `& 1` |
| `red_avanzada.roam_rssi` | −90 … −50 | clampa |
| `red_avanzada.roam_delta` | 5 … 30 | clampa |
| `red_avanzada.roam_cooldown_s` | 60 … 3600 | clampa |
| `red_avanzada` | los tres, o ninguno | **descarta la cfg ENTERA, sin ack** |
| payload mergeado | 1024 B (`MQTT_IN_PAYLOAD_MAX`) | no entra en el buffer |

**Los dos "descarta la cfg entera" son peores que los clamps** y por eso están
marcados: no hay recorte silencioso, hay silencio a secas. El panel no manda ack
ni de error, así que la pantalla se queda en "esperando confirmación" para
siempre y no hay forma de distinguirlo de un equipo dormido. Son los únicos
casos donde la validación del lado servidor no mejora el mensaje: lo crea.

El `0` de `alarma.autooff` significa "no tocar este modo" en el protocolo, y aun
así se rechaza: la pantalla manda siempre los siete valores tomados del espejo,
así que un 0 solo puede ser un tipeo.

El de 1024 se mide sobre el payload **ya mergeado** (el patch solo no dice nada: el
merge le suma las secciones completas) y todo corre en una TRANSACCIÓN. Si no
entra, se revierte: como `pg_notify` es transaccional, el GtD nunca se entera del
intento y el `cfg_v` no se quema. Es el único límite que la validación por campo
no puede anticipar: cinco redes cada una válida pueden no entrar juntas.

### Las passwords no salen

El `GET` nunca las devuelve — cada red viaja con `tienePassword`. Al guardar, una
red **sin** `psw` conserva la del espejo: el servidor la repone antes de llamar a
`publish_config` (`rehidratarPasswords`).

Eso último no es una comodidad: `publish_config` reemplaza el ARRAY ENTERO de
redes (`COALESCE(patch->'redes', base->'redes')`, no un merge red por red). Sin la
rehidratación, guardar cualquier cambio de WiFi habría borrado las contraseñas de
todo el barrio.

El único camino de lectura es `POST /devices/:id/config/reveal-wifi`, solo CPS y
siempre en `audit_log`.

### Endpoints

```
GET  /api/devices/:id/config                 espejo + estado de la cola + último scan
PUT  /api/devices/:id/config                 publica un patch (gestores y técnicos)
POST /api/devices/:id/config/scan            que el equipo busque redes
POST /api/devices/:id/config/refresh         pedirle su cfg actual (desbloquea "sin espejo")
POST /api/devices/:id/config/reveal-wifi     solo CPS; auditado
```

El **scan es a pedido, nunca automático**: interrumpe la máquina de estados del
WiFi y, mientras dura, el panel no está siendo una alarma.

`GET /config/sources` lista los otros equipos **del mismo barrio** que ya
reportaron su configuración, para **copiar de otro poste**. Precarga el
formulario y nada más: son copias independientes, no queda vínculo, y cambiar el
original no toca a las copias. Existe porque no hay configuración por barrio
(decisión §2.1 del spec) y cargar 40 postes con el mismo WiFi municipal es
cargarlo 40 veces. Se limita al mismo barrio porque copiar de otro sería copiar
redes WiFi que ahí no existen; y **no copia `central`** —el alias y la ubicación
son de cada poste— ni las contraseñas, que no se leen por ningún lado.

### Qué se edita y qué no

Editable: redes WiFi (SSID, clave, prioridad) · módulos (`ds3231`, `eeprom`,
`supervisor`, `rf`, `eeprom_slot`) · `tiempos.send_tele_s` · `hora.tz_offset_s`
· auto-apagado de los 7 modos · roaming · `mante.on`.

Solo lectura, con su razón:

- **`central`** (alias, ubicación, grupo) — se GENERA en `publish_config` desde
  el nombre del equipo y el `code` del barrio. Si se pudiera tipear, en seis
  meses el poste se llamaría distinto en la web y en el equipo y no habría forma
  de saber cuál miente. (Y el firmware no lo espeja en el `cfg_full`, así que
  tampoco se podría verificar.)
- **`rf`** (`total_codigos`, `gen`) y **`cal`** — el `cfg` de bajada no los
  acepta: se tocan con `cmd t:rf` y `cmd t:cal`. Se muestran igual, porque
  `rf.gen` es lo único que dice si la base de códigos del panel está al día.
- **`id.fw`** — identidad.

`publish_config` los saca del payload de bajada (`v_base - 'id' - 'rf' - 'cal'`):
mandarlos de vuelta sería ruido contra los 1024 bytes.

**Una red puede llegar con `bloqueada: true`** (`bl_perm` del `cfg_full`): el
panel la puso en su lista negra permanente y no la va a usar aunque el SSID y la
clave estén bien. Se muestra porque, sin eso, una red correctamente cargada
simplemente no conecta y no hay nada en pantalla que lo explique. Limpiarla
necesita `cmd t:red op:bl_clear`, que todavía no está expuesto.

### El estado `DESACTUALIZADA`

Tras un `factory` el panel vuelve a `cfg_v = 0` y corre defaults de fábrica, pero
`upsert_config_espejo` no se deja pisar por una versión más vieja: **el espejo
sigue mostrando la configuración anterior**. `upsert_panel_state` marca la cola en
`stale` y el `GET` lo traduce a `DESACTUALIZADA`, que se evalúa ANTES de comparar
versiones — si no, `espejo.cfg_v >= cola.cfg_v` daba `VERIFICADO` sobre un equipo
reseteado y la pantalla afirmaba estar mostrando lo que el equipo tiene.

Es el único estado en el que lo que se ve no es lo que corre, y la pantalla lo
dice con todas las letras. Se puede publicar igual: es la forma de devolverle su
configuración.

## Comandos al panel (2026-08-05)

Un comando **no es una configuración**: no tiene versión, no se mergea contra
nada y no se reintenta solo. Se encola en `gtd.commands`, el GtD lo publica en
`av/<id>/cmd` y el panel contesta con un `up t:ack` que trae el mismo `cid`.

```
GET  /api/devices/:id/commands              la cola + los dos permisos resueltos
POST /api/devices/:id/commands              encola uno (gestores y técnicos)
POST /api/devices/:id/commands/:cid/cancel  sacarlo de la cola (solo si sigue pending)
POST /api/devices/:id/alarm                 disparar o apagar (el MONITOR también)
```

### Por qué el disparo va por otra ruta

Es la única acción sobre el equipo que suma al MONITOR (`DISPARAN_ALARMA`), y no
por excepción sino porque **no es infraestructura**: es la operación. El monitor
es quien está mirando el tablero cuando entra un evento y tiene que poder hacer
sonar el barrio —o callarlo— sin buscar a un técnico. Reiniciar un poste, en
cambio, sigue siendo del que lo mantiene.

Sigue valiendo el otro eje: `assertManagesNeighborhood`. Un monitor de una
organización cuyo barrio lo opera CPS mira y no dispara.

**El resultado del disparo no vuelve por el ack.** El ack dice "acepté"; lo que
pasó llega después como `up t:alarma` con `origin: "mqtt"` y termina en un
`event` igual que si lo hubiera apretado un vecino. Un disparo remoto no es un
evento de otra especie.

### La cola devuelve permisos, no solo filas

`GET /commands` responde `{ comandos, puedeOperar, puedeDisparar }`. Son dos
matrices distintas y las dos dependen del barrio: si el front las dedujera de la
sesión, estaría reescribiendo en el navegador una regla que ya vive acá — que es
exactamente el bug que tuvo `puedeEditar`.

### Qué se puede mandar, y qué NO

| Tipo | Qué hace | Fricción |
|---|---|---|
| `estado` | publica presencia + telemetría ya | — |
| `hora` | fuerza sync NTP | — |
| `i2c_scan` | re-detecta los módulos del bus | — |
| `red` | destraba un SSID de la lista negra del panel | pide el SSID |
| `scan` / `refresh` | ya existían, con su ruta en configuración | — |
| `restart` | reinicia | confirmación |
| `ota` | actualiza el firmware | confirmación |
| `factory` | **vuelve a fábrica** | confirmación + escribir el serial |

Afuera, cada uno con su razón: **`rf`** (la base de códigos, se define aparte),
**`cal`** (calibrar tensiones — cambia lo que SIGNIFICAN los voltajes y con eso
las alertas de batería; necesita un tester al lado del poste) y **`test`**
(probar un SSID puntual, misma razón).

### Qué borra exactamente un `factory` — verificado en el firmware

`ADMIN_SYS_FACTORY` es **`shutdown + nvs_erase + restart`**. NVS es la flash
interna, y de ahí salen la configuración y **las credenciales WiFi**. La base de
códigos RF vive en la **EEPROM externa (I2C)**, otro chip: **los controles
remotos NO se borran.**

Dos consecuencias que la pantalla dice antes de dejar apretar:

1. **El equipo se queda sin redes y por lo tanto incomunicado.** No se lo puede
   recuperar por MQTT: hay que ir hasta el poste y reconfigurarlo por su portal
   local. Es lo más destructivo que se puede hacer desde la web, y por eso pide
   escribir el serial.
2. **`rf_gen` vuelve a 0** aunque los códigos sigan ahí: el contador de
   generación sí vive en NVS (`eeprom_nvs.c`). Cuando se implemente la
   sincronización de la base RF, **un `gen = 0` no significa "libreta vacía"** —
   significa "perdió la cuenta". Confundir las dos cosas es remandar la base
   entera al pedo, o peor, creerla al día.

El firmware exige que el `confirm` traiga el ID del equipo (`AV-<MAC>`, que es
nuestro serial). El backend lo completa solo, pero igual **exige que la persona
lo haya tipeado**: la fricción sirve del lado del humano, no del protocolo.

### El OTA — resuelto el 2026-08-06

Hasta esa fecha estaba a medias a propósito: el firmware sabía bajar e instalar,
el backend sabía mandar `cmd t:ota`, y en el medio no había NADA. La URL se
escribía a mano y el origen automático apuntaba a un 404 —verificado contra el
servidor real.

Ahora hay catálogo (`firmware_release` + `firmware_channel`) y una sección propia
en la web, `/actualizaciones`. El detalle completo está en `docs/ota.md`; lo que
importa acá, en la ficha del equipo:

- **`ota` es SOLO CPS.** Antes entraba por `CONFIGURAN_EQUIPOS`, así que un
  técnico de una organización podía mandar un OTA **con la URL que quisiera** a
  sus postes. La cola devuelve un tercer flag, `puedeActualizar`, y la pantalla
  deshabilita el botón con eso. `restart` y `factory` NO cambiaron: son
  mantenimiento del que opera el barrio.
- **El campo de URL sigue existiendo**, pero ya no es el camino normal: vacío
  baja lo publicado en `/new/`. La URL a mano sirve para mandar una versión
  puntual, y se copia del catálogo.
- **El progreso vuelve.** `gtd.last_ota` lee el `up t:ota` que el panel ya
  mandaba y nadie leía. Es distinto del estado del comando: el ack dice "acepté",
  y entre eso y tener el firmware corriendo hay 1,2 MB de descarga, un sha256 y
  un reinicio.

## Credencial del broker (2026-08-04)

Sin credencial en Mosquitto, un equipo **no puede conectarse** por más que esté
instalado y con corriente. La web no la registra: **encola** y un proceso aparte
—el provisioner, en el repo del GtD— hace el trabajo.

Diseño: `docs/superpowers/specs/2026-08-04-provisioner-broker-design.md`.

### El flujo

```
POST /devices  →  gtd.provisioning_queue (pending)  →  NOTIFY gtd_provisioning
                                                              ↓
                                            provisioner (proceso privilegiado)
                                            deriva HMAC → mosquitto_passwd → reload
                                                              ↓
                            gtd.confirm_provisioning → device.mqtt_provisioned_at
```

**El alta de fábrica encola sola**, en la misma transacción que crea el equipo:
no puede quedar un equipo fabricado sin pedido de credencial. Es lo que hace
posible fabricar una tanda sin correr un comando por equipo.

### Por qué el provisioner es un proceso aparte del GtD

El GtD está encerrado a propósito (`NoNewPrivileges`, `ProtectSystem=strict`)
porque recibe payloads de cada panel por MQTT. Registrar en el broker necesita lo
contrario: escribir `/etc/mosquitto/gtd.passwd` y recargar el servicio. Meterlo
adentro sería desarmar ese encierro en el proceso más expuesto del sistema.

Comparten el repo —la derivación HMAC tiene que coincidir byte a byte con el
firmware— pero no el proceso.

### El `SALT_MQTT` no vive acá

La password se **deriva**, no se guarda: quien tiene el salt puede calcular la
credencial de cualquier panel de la flota. Vive **solo** en el entorno del
provisioner. La web nunca lo ve — solo dice "registrá esta MAC".

Por eso `gtd.provisioning_queue` no guarda ninguna password.

### Endpoints

```
POST /api/devices/:id/provision           solo CPS; reintentar o registrar uno viejo
POST /api/devices/:id/revoke-credential   solo CPS; SIEMPRE manual
```

**La baja nunca es automática.** Ningún cambio de estado del equipo revoca nada,
ni `RETIRED` ni `OUT_OF_SERVICE` (decisión de negocio). Como el olvido sería
invisible, la ficha **avisa** cuando un equipo dado de baja conserva su
credencial.

### Un fallo no mueve el hito

`confirm_provisioning` con un resultado distinto de `ok` marca la fila `failed`
con el detalle y **no toca `device`**. El hito `mqtt_provisioned_at` solo se
mueve cuando el broker aceptó de verdad. Y no se reintenta solo: los tres modos
de falla —salt equivocado, broker roto, equipo inválido— piden una persona.
