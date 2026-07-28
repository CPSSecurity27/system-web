# CPS Security — guía para la IA

## Qué es esto

Plataforma de **seguridad comunitaria monitoreada**: alarmas en la vía pública de
barrios, controles remotos por hogar, panel web de administración/monitoreo y una
app de vecinos (futura). Dos carpetas de código:

- `backend-nestjs/` — NestJS + PostgreSQL + TypeORM. **Migrado al modelo v2** (2026-07-16).
- `frontend-angular/` — Angular. **Migrado a la API v2** (2026-07-18, ver
  `frontend-angular/docs/pendientes-y-decisiones.md`).

Además existirá un **servicio de alarmas** como programa separado (MQTT ↔ equipos)
que comparte SOLO la base de datos con la web. Aún no se diseñó: no meterse ahí.

## Leé primero (en este orden)

1. `docs/estado-proyecto.md` — dónde está parado el proyecto y qué sigue.
2. `docs/negocio-redisenado.md` — cómo funciona el negocio.
3. `docs/diseno-relaciones-fase1.md` — el diseño del modelo (decisiones y por qué).
4. `docs/esquema-postgres-v2.sql` — el DDL, fuente de verdad del esquema.
5. `backend-nestjs/docs/` — detalle por módulo del backend.

## Las 5 reglas del dominio (no negociables)

1. **La alarma es del BARRIO** (infraestructura pública), nunca de la vivienda. El
   hogar tiene controles remotos y, a lo sumo, una alarma *preferida*.
2. **El control es del HOGAR**; el portador es un dato aparte y reasignable.
3. **Todo cliente es una ORGANIZATION** (muni MUNICIPAL o consorcio PRIVATE) con un
   **OWNER institucional** (no persona — rotación de personal) y contrato por barrio.
   No existen cuentas HOME ni contratos por vivienda: los vecinos entran por `home_member`.
4. **Los cupos son tarifa y SOLO CPS los modifica** (max_neighborhoods,
   max_monitor_users, max_family_members, remote_controls_enabled), siempre con
   `audit_log`. Se imponen al crear; reducirlos aplica grandfathering. **Los eventos
   son ilimitados.**
5. **Postgres guarda qué ES y qué PASÓ; el estado vivo va en `device_state`** y lo
   escribe únicamente el servicio de alarmas (un solo escritor por tabla).

## Convenciones de trabajo

- **Idioma**: español rioplatense (voseo) en docs, comentarios y mensajes de error.
- **El SQL manda**: migraciones a mano (NO existe `migration:generate`, es a
  propósito — ver `backend-nestjs/docs/migraciones.md`). Las entidades describen.
- **Permisos**: el rol dice QUÉ, la membresía/alcance dice DÓNDE. Todo endpoint con
  `:id` valida alcance además de rol (checklist en `backend-nestjs/docs/seguridad.md`).
- **Sin git**: el usuario decidió no usar versionamiento por ahora. No inicializar.
- **Antes de ejecutar tareas grandes**: proponer enfoque, objetar y acordar con el
  usuario; trabajar por fases con checkpoints.

## Comandos frecuentes (backend)

```bash
cd backend-nestjs
npm run start:dev          # http://localhost:3000/api (Swagger en /api/docs)
npm run migration:run      # aplica InitialSchemaV2 (base NUEVA, sin datos viejos)
npm run auth:bootstrap -- <owner_user> <owner_pass> [admin_user] [admin_pass] [email]
npm run geography:sync     # provincias/departamentos/localidades desde georef
npx tsc --noEmit && npx eslint "src/**/*.ts" && npm test   # verificación
```
