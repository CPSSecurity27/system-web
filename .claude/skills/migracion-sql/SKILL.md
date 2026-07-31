---
name: migracion-sql
description: Use when changing the CPS Security database schema — adding or altering a column, table, enum, index, constraint, or trigger — and when tempted to reach for TypeORM's migration:generate.
---

# Migraciones a mano (CPS Security)

## `migration:generate` NO existe. Es a propósito.

El script fue **eliminado de `package.json`**. Si lo volvés a agregar, vas a
destruir las invariantes del modelo sin darte cuenta.

TypeORM no sabe expresar **FK de dos columnas** ni **índices únicos parciales**.
Como no los ve declarados en las entidades, asume que sobran y genera
`DROP CONSTRAINT` para:

- `fk_neighborhood_org` y `fk_contract_account` — las FK compuestas que hacen que
  una COMPANY no pueda ser dueña de barrios ni contratar
- `fk_sa_membership` / `fk_sa_neighborhood` — impiden asignar barrios de otra organización
- los únicos parciales: una sola COMPANY, un OWNER por cuenta, un TITULAR por
  hogar, un contrato ACTIVE por barrio, un `user_device` ACTIVE por persona

**Esas reglas SON el modelo.** El archivo generado *parece* inocente.

`synchronize` está en `false` y no se enciende nunca, por lo mismo.

## Cómo se hace

```bash
cd backend-nestjs
npm run migration:create -- src/database/migrations/LoQueSea
npm run migration:run
npm run migration:revert     # deshace la última
```

El SQL se escribe **explícito, a mano**, con `up` y `down`.

## Los tres lados que hay que tocar

Un cambio de esquema toca **tres** lugares, siempre a mano:

1. **La migración** — el SQL real. Es la fuente de verdad.
2. **La entidad TypeORM** — *describe* la tabla, no la genera.
3. **`docs/esquema-postgres-v2.sql`** — transcripción legible del esquema.

Olvidarte del 3 es el error silencioso más común: el DDL de referencia queda
mintiendo y la próxima persona diseña contra un esquema que ya no existe.

## Qué deben respetar las entidades

- Columnas con `@Column({ name: 'snake_case' })`
- FK con su nombre real: `@JoinColumn({ foreignKeyConstraintName: '...' })`
- Índices con su nombre real: `@Index('idx_...', [...])`
- Donde la FK real es **compuesta** (`neighborhood.organization`,
  `staff_assignment.*`), la relación va con `createForeignKeyConstraints: false`
  — es solo para cargar datos; la FK de verdad vive en la migración
- `service_contract` **no declara** `@ManyToOne` a `Account`

## Permisos: la app no puede hacer DDL

La app corre como **`cps_web`** (`DB_USER`), que **no tiene DDL**. El CLI de
TypeORM usa `DB_MIGRATIONS_USER` / `DB_MIGRATIONS_PASSWORD` del `.env` (si
faltan, cae a `DB_USER` y falla).

**Si tu migración crea una tabla sensible** (estado vivo o append-only),
tenés que **REVOCAR a mano** como hace `docs/roles-conexion-v2.sql`: los
privilegios por defecto le dan a `cps_web` el DML completo de toda tabla nueva.

Reglas vigentes de un-solo-escritor:
- la web **no escribe** `device_state` (solo el servicio de alarmas)
- el servicio de alarmas **no resuelve** eventos
- `audit_log` y `event_response` **no aceptan UPDATE/DELETE de nadie**

## Base nueva desde cero

```bash
npm run migration:run                                    # con el usuario admin
psql -f docs/roles-conexion-v2.sql                        # después, los roles
npm run auth:bootstrap -- <owner_user> <owner_pass> ...
npm run geography:sync
```

No hay migración de datos desde v1: las tres migraciones viejas
(`InitialSchema`, `EmailVerification`, `UnaccentSearch`) fueron eliminadas.
Si hay una base vieja, **no se migra**: se crea una nueva.

## Antes de darla por buena

```bash
npx tsc --noEmit && npx eslint "src/**/*.ts" && npm test
```

Y probá el `down`: una migración que no revierte es una migración a medias.

## Referencias

- `backend-nestjs/docs/migraciones.md` — detalle y tabla de migraciones aplicadas
- `docs/esquema-postgres-v2.sql` — el DDL completo (§13 = GRANTs)
- `docs/roles-conexion-v2.sql` — script idempotente de roles
