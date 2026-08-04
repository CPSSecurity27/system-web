# Provisioner — alta y baja de equipos en el broker (2026-08-04)

> El alta la dispara la web al fabricar; la MAC viaja por una cola en Postgres y
> un proceso aparte registra la credencial en Mosquitto. **No hay túnel HTTP y el
> GtD no toca el broker** — las dos cosas a propósito.

---

## 1. El problema

Hoy un equipo fabricado desde la web **no puede conectarse al broker**. La ficha
muestra el bloque `provisioning` como un LOG: dice qué falta y da el comando para
correr a mano en el servidor. `device.mqtt_provisioned_at` existe desde la
migración `DeviceMacIdentity` y **nadie la escribe**.

Con un equipo por vez es incómodo. Con una tanda de fábrica es inviable: es
justamente el "alta masiva por derivación" que el punto abierto **PA4** viene
trabando.

## 2. Lo que ya existe y no se reescribe

`gateway-to-device/deploy/provision-panel.sh` hace el trabajo pesado y está
probado contra una placa real:

- **Deriva en Python**, con los 6 bytes crudos de la MAC (no el string hex) —
  el error clásico de esta clase de HMAC.
- **Valida el salt contra un vector de verificación conocido** antes de derivar
  nada: MAC `A842E38FCA6C` → `4EA453D76DD9E1C81A0D141B`. Si el salt no lo
  reproduce, **aborta sin registrar**. Sin esto, un salt equivocado carga
  credenciales que parecen válidas y fallan recién cuando el panel intenta
  conectar — el peor momento para enterarse.
- Normaliza la MAC y la valida contra `^[0-9A-F]{12}$`.
- Soporta el interín `PANEL_PASSWORD` explícita (builds de laboratorio, no
  necesita el salt).
- Es **idempotente**: re-registrar el mismo panel recalcula lo mismo.
- **No toca la ACL**: `deploy/gtd.acl` tiene una regla `pattern av/%u/…` que
  cubre a toda la flota. El usuario ES el `<id>` del tópico, así que el panel
  queda encerrado en los suyos solo. Un archivo que no crece con la flota es un
  archivo que no se desincroniza.

**Decisión: el provisioner invoca este script, no reimplementa la derivación.**
Dos copias del HMAC en dos lenguajes es cómo se desincroniza del firmware, y la
divergencia se manifiesta como "el panel no conecta", que no dice nada.

## 3. Arquitectura

### 3.1 Un proceso nuevo, no una función más del GtD

```
gateway-to-device/
├── src/gtd/
│   ├── __main__.py              python -m gtd              (puente, endurecido)
│   └── provisioner/
│       ├── __main__.py          python -m gtd.provisioner  (nuevo, privilegiado)
│       ├── queue.py             LISTEN + drenaje de la cola
│       └── broker.py            invoca provision-panel.sh
└── deploy/
    ├── gateway-to-device.service    el de siempre — NO se toca
    ├── cps-provisioner.service      nuevo, con sus permisos
    └── provision-panel.sh           existe; se le agregan flags (§5)
```

**Mismo repo y mismo paquete** porque comparten la derivación, que tiene que
coincidir byte a byte con el firmware. **Procesos, units y privilegios
distintos** porque no comparten el riesgo.

### 3.2 Por qué no adentro del GtD

`gateway-to-device.service` está deliberadamente encerrado:

```ini
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/servidorcps/SistemaCPS/gateway-to-device
```

Y `provision-panel.sh` necesita exactamente lo contrario: escribir
`/etc/mosquitto/gtd.passwd` (root:mosquitto, 0640) y recargar el broker.

Meterlo adentro obliga a **desarmar ese endurecimiento en el único proceso
expuesto a cada panel por MQTT**. Un compromiso del GtD pasaría de "puede
escribir en la base por funciones acotadas" a "puede acuñar credenciales del
broker para toda la flota". El provisioner, en cambio, no tiene superficie MQTT:
su única entrada son filas de una base **local** (Postgres escucha solo en
`127.0.0.1`, verificado en la Raspberry), y la MAC que recibe ya viene validada
por el CHECK de la base y revalidada por el script.

### 3.3 Dónde corre

En la Raspberry, junto al broker y a Postgres. La conexión a la base es por
`localhost` y nunca sale de la máquina.

## 4. La cola y el contrato

### 4.1 `gtd.provisioning_queue`

| columna | tipo | nota |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `mac` | TEXT NOT NULL | 12 hex mayúsculas |
| `device_id` | INT NOT NULL → `device(id)` ON DELETE CASCADE | |
| `op` | TEXT NOT NULL | `provision` \| `revoke` |
| `estado` | TEXT NOT NULL DEFAULT `'pending'` | `pending` \| `done` \| `failed` |
| `detalle` | TEXT | por qué falló |
| `requested_by` | INT → `app_user(id)` ON DELETE SET NULL | NULL = automático |
| `created_at` / `done_at` | TIMESTAMPTZ | |

Índice parcial `WHERE estado = 'pending'`, igual que `gtd.commands`.

**La cola no guarda ninguna password.** La credencial se deriva en el momento;
nada sensible queda en la base.

**Es un histórico, no una fila por equipo**: cada alta y cada baja dejan su fila.
Saber que un equipo se revocó en marzo y se volvió a registrar en julio es
información operativa, y un `UPDATE` in place la borraría.

### 4.2 Las tres funciones

Mismo patrón que el resto del contrato: `SECURITY DEFINER`, permisos por rol.

```sql
gtd.enqueue_provisioning(p_device_id INT, p_op TEXT, p_user_id INT DEFAULT NULL)
RETURNS BIGINT          -- id de la fila; la llama cps_web
```
Valida que el equipo exista y tenga MAC. Si ya hay un `pending` con la misma
`op`, devuelve el id existente en vez de encolar dos.

```sql
gtd.fetch_pending_provisioning()
RETURNS TABLE (id BIGINT, mac TEXT, op TEXT)     -- la llama cps_provisioner
```

```sql
gtd.confirm_provisioning(p_id BIGINT, p_res TEXT, p_det TEXT DEFAULT NULL)
RETURNS TEXT            -- 'ok' | 'noop'; la llama cps_provisioner
```
Con `p_res = 'ok'`: marca `done` y escribe en `device` — `mqtt_provisioned_at =
now()` si fue `provision`, o `NULL` si fue `revoke`. Cualquier otra cosa: marca
`failed` con el detalle y **no toca** `device`. Siempre deja `audit_log`.

### 4.3 Un rol nuevo de conexión

`cps_provisioner`, con `EXECUTE` solo sobre `fetch_pending_provisioning` y
`confirm_provisioning`. **No** puede encolar (eso es de la web) ni tocar ninguna
de las funciones del GtD. Va en `docs/roles-conexion-v2.sql`.

### 4.4 El canal

`NOTIFY gtd_provisioning` por trigger sobre la cola, con la MAC de payload.
El provisioner además **barre al arrancar y al reconectar**: un `NOTIFY` emitido
mientras estaba caído no vuelve nunca. Es la misma lección de `fetch_pending_macs`
(P0-1) y no hay razón para reaprenderla.

## 5. Cambios al script

Tres agregados, todos compatibles hacia atrás (el uso manual de hoy no cambia):

| flag | por qué |
|---|---|
| `--no-reload` | El provisioner drena la cola y recarga **una vez** al final. Doscientos `systemctl reload mosquitto` seguidos sobre la Pi es una mala tarde |
| `--no-probe` | Apaga la publicación de verificación. Ver abajo |
| `revoke <MAC>` | Subcomando nuevo: borra el usuario de `gtd.passwd`. Hoy no existe forma de dar de baja una credencial |

**El `--no-probe` no es cosmético.** Hoy el script termina publicando un `status`
de prueba contra el broker real:

```json
{"v":1,"estado":"online","modo":"PROVISION_TEST","ts":0}
```

Con un equipo suelto eso es una función: verifica el camino completo. Con 200 en
lote, el GtD recibe 200 `status` y llama `upsert_panel_state(estado='online')`
para cada uno — **marcando toda la tanda como conectada y escribiéndoles
`first_connection_at`** con los paneles todavía en la caja. El hito de primera
conexión es un hecho observado; ensuciarlo con una prueba de laboratorio lo
vuelve inútil.

En modo lote la verificación se hace una vez, sobre el último equipo.

## 6. Cuándo se dispara

**Alta — automática.** `POST /devices` encola el `provision` en la misma
transacción que crea el equipo. Es lo que hace posible el alta masiva.

**Baja — solo por botón.** Decisión del usuario (2026-08-04): ningún cambio de
estado revoca nada. Ni `RETIRED`, ni `OUT_OF_SERVICE`. Siempre lo decide una
persona con el botón "Revocar credencial".

> **Mitigación acordada**: como nada revoca solo, el olvido es invisible. La
> ficha **avisa** cuando un equipo en `RETIRED` todavía tiene
> `mqtt_provisioned_at` cargado. No dispara nada; solo lo hace visible.

**Re-provisionar** — el mismo botón. Sirve para los equipos que ya existen sin
registrar: no hace falta un backfill aparte.

## 7. Errores y reintentos

| Situación | Qué pasa |
|---|---|
| Salt que no reproduce el vector | El script aborta **sin registrar**; la fila queda `failed` con el motivo |
| El equipo no existe o no tiene MAC | `enqueue_provisioning` tira excepción → 409 en la web |
| Mosquitto no queda activo tras el reload | `failed` con el detalle; el provisioner sigue vivo |
| Postgres caído | El provisioner reintenta con backoff. Las filas `pending` sobreviven |
| El provisioner estaba caído | Las filas quedan `pending` y se toman en el barrido de arranque |

**Un `failed` no se reintenta solo.** Los tres modos de falla —salt equivocado,
broker roto, equipo inválido— se arreglan con intervención humana; reintentar en
loop solo llena el log y esconde el problema. Espera el botón.

## 8. Qué ve el usuario

El bloque `provisioning` de la ficha deja de ser un log y pasa a tener estado:

- *En cola para registrar…*
- *Registrada en el broker el 4/8/2026*
- *No se pudo registrar: {detalle}* + botón **Reintentar**
- *Sin registrar* + botón **Registrar en el broker**
- Y el aviso: *equipo dado de baja con credencial activa* (§6)

El comando manual sigue visible como fallback, para el caso en que el provisioner
no esté corriendo.

## 9. Qué se prueba

**Las tres funciones SQL**, contra la base real y con los roles de verdad:
encolar dos veces la misma op no duplica; `confirm_provisioning('ok')` escribe
`mqtt_provisioned_at`; con `revoke` lo pone en NULL; con error deja `failed` sin
tocar `device`; `cps_provisioner` **no** puede encolar; `cps_web` **no** puede
confirmar.

**El provisioner**, con el script mockeado: drena la cola en orden, hace **un
solo** reload por tanda, confirma cada fila, y un fallo en una no aborta las
demás.

**El script**, en seco: `--no-reload` y `--no-probe` no rompen el camino manual;
`revoke` saca el usuario del archivo; el vector de verificación sigue abortando
con un salt equivocado.

**Backend**: `POST /devices` encola; el botón encola; permisos (solo CPS);
`audit_log`.

## 10. Fuera de alcance

- **El despliegue.** Decisión del usuario (2026-08-04): no se sube nada todavía.
  Cuando llegue el momento, la base de producción se llama **`cpssecurityarg`**
  — el mismo nombre del proyecto de Firebase que se auditó para el rediseño, así
  que la identidad queda igual en todos los sistemas. Se descartaron
  `_monitoring` (miente: el monitoreo es una parte de lo que hace) y `_v2`
  (envejece: ya pasamos 16 migraciones desde ese número). Hoy la Raspberry tiene
  `cps_security_monitoring` con el esquema v2 congelado en la migración 4 de 16 y
  sin datos que valgan (0 equipos, 0 eventos, 0 hogares).
- **El `SALT_MQTT` de producción (PA4).** Sigue bloqueado y es acción humana. El
  flujo se construye y se prueba igual con un salt de desarrollo y una placa
  flasheada con el mismo; el valor real después es un cambio de configuración, no
  de código.
- **Rotación de credenciales** de un equipo en servicio (revocar + re-provisionar
  es el camino manual por ahora).
- **Alta masiva desde una pantalla** (importar un CSV de MACs). El alta de a una
  ya alimenta la cola; si aparece el caso real, se agrega arriba de esto.

## 11. Nota de infraestructura, fuera de este diseño

La Raspberry corre **Postgres 17.10**; acá desarrollamos en **18**. Nada del
esquema necesita 18, y actualizar una máquina de producción para alinear un
número es al revés de como conviene. La verificación correcta —correr las 16
migraciones contra un Postgres 17 real— es el primer paso del despliegue, no de
este plan.

También quedó anotado que el GtD desplegado está en `6c5d600`, o sea **antes del
plan 1**: sin `PgRepo`, corriendo con `StubRepo` y con `GTD_PG_DSN` vacío. Hay
una placa real (`AV-A842E38FCA6C`, `fw=new_0_6_0`) publicando `status`, `tele` y
`cfg_full` **que hoy se descartan**. Conectar eso probablemente valga más que
este provisioner, y es una decisión de prioridad del usuario.
