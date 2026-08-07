# Migraciones — el SQL manda, las entidades describen (v2)

## NO existe `migration:generate`. Es a propósito.

El script fue **eliminado de package.json**. Si lo volvés a agregar, vas a
destruir las invariantes del modelo sin darte cuenta.

**Por qué.** TypeORM no sabe expresar una **FK de dos columnas** ni los **índices
únicos parciales**. Como no los ve declarados en las entidades, asume que sobran y
genera `DROP CONSTRAINT` para:

- `fk_neighborhood_org` y `fk_contract_account` — las FK compuestas que hacen que
  una COMPANY no pueda ser dueña de barrios ni contratar;
- `fk_sa_membership` / `fk_sa_neighborhood` — las dos FK de `staff_assignment`
  que impiden asignar barrios de otra organización;
- los únicos parciales: una sola COMPANY, un OWNER por cuenta, un TITULAR por
  hogar, un contrato ACTIVE por barrio, un `user_device` ACTIVE por persona.

Esas reglas SON el modelo. El archivo generado *parece* inocente.

## Entonces, ¿cómo se hace una migración?

A mano, con el SQL explícito:

```bash
npm run migration:create -- src/database/migrations/LoQueSea
npm run migration:run
npm run migration:revert     # deshace la última
```

**Regla:** el esquema es la fuente de verdad y vive en las migraciones (y en
`../../docs/esquema-postgres-v2.sql`, que es su transcripción legible). Las
entidades de TypeORM **describen** las tablas; no las generan. Una columna nueva
va en una migración *y* en la entidad, a mano, en los dos lados.

`synchronize` está en `false` y no se enciende nunca, por lo mismo.

## Qué SÍ deben respetar las entidades

- Nombres de columna con `@Column({ name: 'snake_case' })`.
- Nombres de FK reales con `@JoinColumn({ foreignKeyConstraintName: '...' })`.
- Índices con su nombre real: `@Index('idx_...', [...])`.
- Donde la FK real es compuesta (`neighborhood.organization`,
  `staff_assignment.*`), la relación se declara con
  `createForeignKeyConstraints: false` — es solo para cargar datos; la FK de
  verdad vive en la migración. `service_contract` directamente **no declara**
  `@ManyToOne` a `Account`.

## Migraciones aplicadas (v2 — base nueva)

| # | qué hace |
|---|---|
| `1785000000000-InitialSchemaV2` | TODO el esquema v2: 23 tablas, 19 enums, triggers de `updated_at`, FK compuestas, CHECKs de custodia, índices únicos parciales, unaccent + pg_trgm para la búsqueda de localidades |
| `1785100000000-VecinoEmailLogin` | El vecino deja el DNI+OTP (caro, sin proveedor) y pasa a registrarse con email + activación por mail, login con email o DNI + contraseña. `chk_user_login_identity` suma `OR email IS NOT NULL`; corrige también el `COMMENT` de `password_hash` que en InitialSchemaV2 decía "DNI + OTP" |
| `1785200000000-SingleAccountMembership` | Una persona pertenece a UNA sola cuenta: `uq_account_user` (account_id, user_id) se reemplaza por `uq_account_user_single_account` UNIQUE(user_id); `idx_account_user_user` se borra por redundante |
| `1785300000000-MustChangePassword` | `app_user.must_change_password` (default false): el OWNER institucional nace con clave TEMPORAL generada por el sistema (no la elige el admin de CPS) y tiene que cambiarla en su primer login |
| `1785400000000-DeviceMacIdentity` | El `serial` se DERIVA de la MAC (`AV-<12 hex>`) en vez de elegirse — el mismo string es usuario MQTT, client_id y `<id>` del tópico. Rename `ALARM_PANEL` → `COMMUNITY_ALARM`, tabla `board_model` y `device.board_seq` |
| `1785500000000-DeviceFactoryMilestones` | Hitos de puesta en marcha del equipo (`labeled_at`, `first_connection_at`): la etapa se DERIVA del último hito alcanzado, no es una columna de estado |
| `1785600000000-AccountPlansAndRoleQuotas` | Rename `PRIVATE` → `COMMUNITY` (el subtipo dice la ESCALA, no quién opera), cupos por rol (`max_admin_users`, `max_technician_users`) y tabla `plan` como PLANTILLA que se copia al vender |
| `1785700000000-AccountJurisdictionAndAccountContracts` | Jurisdicción de la cuenta (nivel LOCALITY o DEPARTMENT: hasta dónde puede crear barrios) y el contrato pasa a ser DE LA CUENTA, no del barrio |
| `1785800000000-DeviceInstallationData` | Datos de instalación del equipo (poste, altura, esquina, punto de energía, notas), todos opcionales. Se elimina el estado `INSTALLED`, que era idéntico a `OPERATIONAL` y nadie escribía |
| `1785900000000-HomeAddressAndNeighborResident` | Viviendas y vecinos: se va `home.name` (la DIRECCIÓN identifica la vivienda) y el GPS pasa a obligatorio; `uq_user_single_titular` (parcial) se reemplaza por `uq_home_member_one_home` UNIQUE(user_id) — **una persona vive en una sola casa**; `app_user.birth_date`; y el cupo `community_scope_enabled` en `neighborhood` y `plan` (disparar TODAS las alarmas del barrio desde la app) |
| `1786000000000-MandatoryCoordinates` | Coordenadas obligatorias en cliente y barrio: el tablero es un mapa, y un pin opcional lo deja ilegible |
| `1786100000000-AccountNeighborhoodQuotas` | Los cupos DE BARRIO (`max_family_members`, `community_scope_enabled`) pasan a definirse en la CUENTA: se copian del plan al vender y de la cuenta al crear cada barrio — cierra el hueco de barrios que nacían con defaults |
| `1786200000000-DropRemoteControlsQuota` | Se elimina `remote_controls_enabled` (cuenta, barrio y plan): los controles dejan de habilitarse por barrio, el producto los tiene y punto |
| `1786300000000-GtdBridgeSchema` | Puente con el GtD, el esquema: `neighborhood.code` (≤15, es lo que viaja al equipo como `central.grupo`), `device_state` crece (`vbat`/`vpanel`/`vfuente`, `power_mode`, `cfg_v`, `rf_gen`, `fw`, `last_seen`, `sleep_until`, `ts_device`, `tsq`), `event` crece (`external_id` = el `eid` del panel y su único parcial que ES el dedup, `ts_device`, `tsq`), y el esquema `gtd` con `commands`, `panel_config` (con estado `failed` + `detalle`), `config_espejo` y `uplink_raw`. v2 (2026-08-04): renumerada detrás de las de main — los timestamps chocaban |
| `1786400000000-GtdBridgeFunctions` | Puente con el GtD, el contrato: 8 funciones de entrada 1:1 con su `Protocol Repo` + 4 de salida + `fetch_pending_macs` y `mark_config_failed`, todas SECURITY DEFINER, y los triggers de `NOTIFY`. A `cps_alarms` se le REVOCA el INSERT/UPDATE directo sobre `device_state` y `event`: el contrato lo impone el motor. v2 (2026-08-04): `upsert_panel_state` con estado durmiendo, `last_seen` del servidor y `fw` en la firma — respuestas al doc 06 del GtD. Ver `docs/contrato-gtd-postgres.md` |

| `1786500000000-GtdConfigFunctions` | Configuración por equipo: `gtd.confirm_config` (el ack de una `cfg` no trae `cid` y caía en el dead letter; ahora marca `applied` y encola solo el `cmd t:refresh` que trae el espejo de vuelta, con `cid` determinístico para que un ack reentregado no encole dos) y `gtd.last_scan` (último `up t:scan` del equipo, leído de `uplink_raw` — sin tabla nueva). Ver `docs/superpowers/specs/2026-08-04-configuracion-por-equipo-design.md` |

| `1786600000000-ProvisioningQueue` | Alta y baja de equipos en el broker: tabla `gtd.provisioning_queue` (histórica, una fila por operación, **sin passwords** — se derivan del `SALT_MQTT`), `enqueue_provisioning` / `fetch_pending_provisioning` / `confirm_provisioning`, canal `gtd_provisioning` y el rol `cps_provisioner` (solo lee la cola y confirma; no puede encolar ni tocar las funciones del GtD). Un `confirm` con error NO toca `device`: el hito solo se mueve cuando el broker aceptó de verdad |

| `1786700000000-DevicePortalCredentials` | Fabricación atómica: las credenciales del PORTAL local (`admin` y `cps`, djb2_xor sobre la MAC SoftAP) se guardan **cifradas** con AES-256-GCM —las cifra el provisioner antes de escribirlas, nunca viajan en claro por la cola— y la op `manufacture` hace alta y registro en un solo viaje: la web espera UNA confirmación y, si falla, borra el equipo. Ojo con la otra credencial: la de MQTT NO se guarda, se deriva |
| `1786800000000-DeviceTestedAndReady` | La escalera de puesta en marcha pasa a cuatro peldaños: FABRICADO → CONECTADO → TESTEADO → LISTO. `tested BOOLEAN` (un tilde de fábrica, antes de que el equipo se conectara a nada) se reemplaza por `tested_at` + `tested_by`: sin fecha no se puede ordenar contra los otros hitos |
| `1786900000000-DeviceRemoved` | Papelera: `removed_at`. NO es un `status` más — `chk_device_custody` exige barrio para todo lo que no está en INVENTORY, así que un equipo de fábrica no podría removerse; y son dos preguntas distintas (en qué punto del ciclo está / si alguien lo sacó de circulación) |
| `1787000000000-DeviceGpsMandatory` | Coordenadas obligatorias al instalar. CHECK y no NOT NULL: un equipo en la caja no tiene ubicación que declarar. Cierra la última incoherencia — la vivienda y el barrio ya las exigían, y la alarma, que es la que dispara el evento, no |
| `1787100000000-DeviceStateNetwork` | `device_state` guarda todo lo que el panel reporta: COLUMNAS para lo que se pregunta sobre la flota (`ssid`, `ip`, `rssi`, `recon`, `ping_fail`) y JSONB `tele` para el resto del snapshot. `upsert_panel_state` suma `p_red` y `p_tele` — la firma cambia, así que la vieja se DROPea (un `CREATE OR REPLACE` con otra firma crea una sobrecarga, no reemplaza) y hay que rehacer el GRANT |
| `1787200000000-RestoreConfigReconcile` | Restituye en `upsert_panel_state` el bloque de reconciliación de `cfg_v` que la migración anterior perdió al reescribir la función. Ese bloque marca `panel_config` en `applied` cuando el panel reporta la versión (el `tele` es retenido: la única señal que sobrevive a un GtD caído) y en `stale` cuando vuelve de fábrica con `cfg_v = 0`. Sin él, una configuración bien aplicada se quedaba en "esperando confirmación" para siempre y un `factory` pasaba desapercibido |

| `1787300000000-RemoteFactory` | Fábrica de controles: catálogo `remote_model` (lo que define un modelo es cuántos botones tiene; nace con la de 4, la única que el panel aprovecha entera), `remote.serial` correlativo `CR-000137` por secuencia, `model_id` y los hitos de fabricación. `remote.name` deja de ser obligatorio —lo que identifica es el serial—. Y `remote_code.code_hmac` con UNIQUE: el cifrado usa IV aleatorio, así que el mismo código guardado dos veces daba bytes distintos y **nada detectaba un duplicado** — que en este dominio es una alarma atribuida a la casa equivocada. Va con clave y no un hash pelado: 12 dígitos se invierten por fuerza bruta |

| `1787400000000-RemoteCodeSequence` | Secuencia `remote_code_seq` para la numeración CORRELATIVA de códigos RF (opcional; el default sigue siendo al azar). Es una secuencia y no un `MAX(código)` porque **no se puede consultar**: los códigos están cifrados con IV aleatorio y su HMAC es opaco, así que el máximo obligaría a descifrar la tabla entera en cada fabricación. Arranca en 100000 —seis dígitos— para no vecindar con los códigos bajos de los controles genéricos sin programar. Puede quedar atrás sin consecuencias: el generador saltea los tomados y el UNIQUE del HMAC es la garantía |

| `1787500000000-RemoteReady` | `remote.ready_at`/`ready_by`: el visto bueno de fábrica del control, mismo peldaño que el del equipo. **`status` no podía decir esto** — uno recién fabricado ya está en INVENTORY porque `chk_remote_custody` lo exige mientras no tenga vivienda, así que sin el hito aparecía en el stock antes de tener los códigos grabados. Los dos campos o ninguno (CHECK): una fecha sin autor no audita nada. Los controles que ya existían se dan por listos, para que la migración no los saque del stock de golpe |

| `1787600000000-RemoteRemoved` | Papelera de controles: `removed_at`/`removed_by` + índice parcial. No es un `status` más — `LOST` y `REPLACED` dicen qué le pasó al control en la vida real, esto dice si alguien lo sacó del sistema; y `chk_remote_custody` impide usar el estado para eso. **Removerlo no lo deja sin efecto**: los códigos siguen en la EEPROM del panel y todavía no se sincronizan |

| `1787700000000-RemoteClaimCode` | `remote.claim_code` con único parcial: el código de un solo uso con el que un cliente suma un control a su stock, mismo mecanismo que la alarma. El serial no alcanzaría —está impreso a la vista y viaja en los listados—, el código es lo que demuestra que el control está en tus manos. Consecuencia asumida: entra en la etiqueta de 40×20 mm que ya estaba cerrada |
| `1787800000000-RemoteSync` | Cimientos de la sincronización de la base RF con la EEPROM del panel. **Una persona, un control** (`uq_remote_one_per_carrier`, parcial sobre los vivos): no es una preferencia nuestra, la base del equipo se indexa por DNI y el segundo control del mismo portador nunca podría cargarse. `remote.synced_device_id/_dni/_hash/_at` guardan lo que QUEDÓ CARGADO —no un flag "sincronizado", que hay que acordarse de bajar— y "pendiente" se deduce comparándolo con lo que debería estar. `device.rf_gen` es la generación que asignamos, de a uno por comando. En `gtd.commands`, estado `queued` + `batch_id`/`seq`: la tanda entra entera pero solo el primer paso sale, y `confirm_command` destraba el siguiente con cada ack (el panel recuerda 8 cid; publicar 24 lotes en ráfaga desborda su dedup). `enqueue_rf_batch` → `enqueue_rf_sync` |
| `1787900000000-RfSyncOnAck` | El ack marca los controles cargados. `gtd.commands.meta` (JSONB que **no se publica**: el GtD manda `payload` y nada más) dice qué controles cubre cada paso, y `confirm_command` escribe `remote.synced_*` cuando el equipo confirma. Pasa en la base porque cuando llega el ack, del lado de Node no corre nadie — mismo criterio que `confirm_provisioning`. Va aparte de `RemoteSync` y no adentro: editar una migración aplicada deja atrás a toda base que ya la corrió, y se comprobó en el acto (la base de tests se quedó sin la columna y falló el e2e entero) |

| `1788000000000-CidDe23` | El `cid` pasa de 24 a 23 caracteres. `MQTT_CID_MAXLEN` (24) es el TAMAÑO DEL BUFFER, no el largo máximo: entran 23 y el NUL, así que un cid de 24 le llegaba truncado al panel, que ackeaba con ESE y la fila nunca matcheaba. Los comandos quedaban en `sent` para siempre aunque el equipo los hubiera ejecutado |
| `1788100000000-RemoteFactoryBackfill` | **Backfill de datos, no de esquema.** Los controles anteriores a la fábrica (los 46 migrados de Firebase) entran al registro de fábrica: `serial` de `remote_serial_seq` —la misma secuencia que `manufacture()`—, `model_id` DEDUCIDO de cuántos códigos tiene cada uno contra `remote_model.buttons`, `claim_code` con el alfabeto de `generarClaimCode()`, y `manufactured_*`/`ready_*` = `created_*`, que es lo único cierto que se sabe de ellos. Solo toca `serial IS NULL`, así que es idempotente. Cada fila deja un `audit_log` `remote.factory_backfill` — es un cambio de datos sobre controles que están en la calle, y es lo que hace que el `down()` sepa exactamente qué tocó |
| `1788200000000-FirmwareCatalog` | El catálogo de firmwares que le faltaba al OTA: `firmware_release` (la ficha del `.bin` — el binario vive en disco, servido por nginx desde el APEX, que es el único host que la allowlist del equipo acepta) y `firmware_channel`, el puntero de dos ranuras. La ranura es la PK, así que publicar es un UPSERT. **Las dos ranuras no son lo mismo**: `new` es la última a desplegar; `emergency` es el ÚLTIMO BUENO CONOCIDO que el equipo baja SOLO al entrar en `emergency_mode`, y publicar ahí la versión rota de la que trata de escapar anula el mecanismo. `release_id` es RESTRICT: borrar una versión publicada falla y lo dice, en vez de dejar la carpeta apuntando a un 404 |
| `1788300000000-OtaProgress` | `gtd.last_ota(device_id)`: el progreso del OTA deja de tirarse a la basura. El panel YA lo informaba (`up t:ota` con `estado` y `resultado`) y el GtD ya lo guardaba en `uplink_raw` por el `else` de su dispatcher — nadie lo leía, así que apretabas "actualizar" y la pantalla no cambiaba por minutos. Va como FUNCIÓN y no como `GRANT SELECT` sobre `uplink_raw`: ahí viven también los `cfg_full`, **con las passwords WiFi en claro**, y hay una decisión explícita de que eso solo se lee por el endpoint auditado de reveal. Devuelve los enums como números: los traduce el backend, porque quien manda es `ota_types.h` y no una tabla nuestra que se desincronizaría |
| `1788400000000-LegacyAppBridge` | **Temporal.** La puerta de la app VIEJA de vecinos, que no se puede actualizar (APK ya distribuido). `device.legacy_marker` es el alias por el que esa app conoce a cada alarma (`CENTRALVECINAL05`) y define QUIÉN es legacy: un hogar es alcanzable si su alarma preferida tiene marcador. Va en `device` y no en `home` porque en Firebase colgaba del cliente (`ClientesID/<DNI>/Marcador`) y copiarlo así violaría la regla 1. `gtd.legacy_mode_map` traduce `cps00X` ⇄ slug del firmware, biyectiva (el UNIQUE sobre `trigger_mode` es lo que hace bien definida la vuelta que necesita la proyección a Firebase); es tabla y no un CASE para poder corregir un mapeo con un UPDATE. `gtd.legacy_activation` guarda el DNI y el GPS contra el `cid` **porque el firmware manda `dni` SOLO cuando `origin='rf'`**: una activación de la app legacy vuelve con `origin='mqtt'` y lo único que la identifica es el `cid`. Por eso `insert_evento` se reescribe para resolver el activador ANTES de insertar y no con un UPDATE posterior — `event` es append-only y una segunda pasada dejaría al monitoreo viendo una emergencia sin dueño. `gtd.enqueue_legacy_alarm` es la única capacidad del rol `cps_legacy`: **no acepta destino**, siempre es la alarma preferida del hogar del DNI, porque su entrada es el listener 1883 anónimo y la app vieja no autentica a nadie. `gtd.close_legacy_events` cierra el evento con el cps999 ("Desactivar"), que si no lo dejaba OPEN para siempre: un `mode:off` no crea evento, cae en el dead letter como `desarme`. Cierra **cualquier evento abierto del equipo sin exigir que lo cierre quien lo abrió** — en una alarma de barrio el que la apaga casi nunca es el que la disparó—, y al RECIBIR el reporte del panel y no al encolar, para no marcar "resuelto" con la sirena sonando. Es una excepción acotada y explícita a *el servicio de alarmas no resuelve eventos*: no se le concede EXECUTE a nadie (la llama insert_evento como dueño), cps_alarms no gana UPDATE sobre `event`, y solo aplica a la puerta vieja |
| `1788500000000-ResolveOnDisarm` | **Bug de producción (2026-08-07).** Apagar la alarma con el **botón D del control remoto** no cerraba el evento: el tablero mostraba una emergencia en curso con la sirena apagada y, desde que existe la proyección, la app de los vecinos decía 'Activada' para siempre. La causa: `LegacyAppBridge` condicionaba el cierre a `v_cid IS NOT NULL`, y **el firmware solo manda `cid` cuando `origin='mqtt'`** — un desarme por RF trae `dni`, no `cid`. Evidencia en `gtd.uplink_raw`: dos filas del mismo hecho, la `mqtt` cerró y la `rf` no. La corrección es más ancha que el bug a propósito: cerrar el evento cuando el equipo avisa que lo desarmaron **no es un asunto del legado sino una regla del dominio**, y el "apagar" del panel web tampoco funcionaba (tiene `cid`, pero no fila en `legacy_activation`). `close_legacy_events` se reemplaza por `gtd.resolve_on_disarm`, que no sabe nada del legado. **El origen `auto` NO cierra**: el panel apaga la sirena solo al vencer `alarma.autooff`, y cerrar ahí sería decir que la emergencia terminó porque se acabó un temporizador. Solo cierra lo que hizo una persona (`rf`/`mqtt`/`portal`), y el responsable sale del `dni`, de `legacy_activation` o de `commands.requested_by` |

> La tabla estuvo desactualizada entre la 4 y la 9: se completó el 2026-08-02
> leyendo cada migración. Volvió a atrasarse cinco filas (de la 17 a la 22) y se
> completó el 2026-08-05. Si agregás una, agregá su fila — la 22 existe
> justamente porque nadie revisó qué se perdía al reescribir una función.

Las tres migraciones del modelo v1 (`InitialSchema`, `EmailVerification`,
`UnaccentSearch`) **fueron eliminadas**: se decidió base limpia, sin migración de
datos (no había producción). Si tenés una base vieja, no se migra: se crea una
nueva y se corre `migration:run` + `auth:bootstrap` + `geography:sync`.

## Roles de conexión (aplicados 2026-07-18)

Los roles `cps_web` / `cps_alarms` con los GRANTs de un-solo-escritor (§13 de
`esquema-postgres-v2.sql`) están aplicados en `cps_security_v2` con el script
idempotente `../../docs/roles-conexion-v2.sql`: la web no escribe
`device_state`, el servicio de alarmas no resuelve eventos, y `audit_log` /
`event_response` no aceptan UPDATE/DELETE de nadie.

Consecuencia para las migraciones: **la app corre como `cps_web`** (DB_USER),
que no puede hacer DDL. El CLI de TypeORM usa las credenciales admin
`DB_MIGRATIONS_USER` / `DB_MIGRATIONS_PASSWORD` del `.env` (si faltan, cae a
DB_USER). Al crear una base nueva: `migration:run` con el admin y después el
script de roles. **Si una migración crea una tabla sensible** (estado vivo o
append-only), tiene que REVOCAR a mano como hace el script: los privilegios
por defecto le dan a `cps_web` el DML completo de toda tabla nueva.
