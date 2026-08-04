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

> La tabla estuvo desactualizada entre la 4 y la 9: se completó el 2026-08-02
> leyendo cada migración. Si agregás una, agregá su fila.

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
