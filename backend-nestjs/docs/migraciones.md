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
