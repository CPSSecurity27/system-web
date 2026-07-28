# CPS Security — Backend (NestJS + PostgreSQL)

API del sistema de seguridad comunitaria de CPS: organizaciones (municipalidades y
consorcios), barrios, hogares y vecinos, alarmas comunitarias con inventario y
claim, controles remotos con códigos RF cifrados, contratos con cupos, eventos y
auditoría. **Modelo v2** (2026-07-16).

- Contexto y diseño: [`../docs/estado-proyecto.md`](../docs/estado-proyecto.md) y
  [`../CLAUDE.md`](../CLAUDE.md)
- Detalle por módulo: [`docs/`](docs/) — empezar por
  [`docs/modelo-datos-backend.md`](docs/modelo-datos-backend.md)
- Contrato para el front: [`docs/frontend-handoff.md`](docs/frontend-handoff.md)

## Requisitos

- Node 22/24 · PostgreSQL 15+
- Un `.env` a partir de `.env.example` (JWT_SECRET, REMOTE_CODES_KEY, DB_*, SMTP opcional)

## Arranque (base NUEVA)

```bash
npm install
npm run migration:run        # crea todo el esquema v2 (una sola migración)
npm run auth:bootstrap -- cps_root <clave_fuerte> ale_copa <clave> mail@cps.com
npm run geography:sync       # provincias/departamentos/localidades (georef)
npm run start:dev            # http://localhost:3000/api — Swagger en /api/docs
```

## Scripts

| comando | qué hace |
|---|---|
| `npm run start:dev` | servidor en watch |
| `npm run build` / `npm test` | build / tests |
| `npm run migration:run` / `migration:revert` | migraciones (a mano — NO existe `migration:generate`, ver `docs/migraciones.md`) |
| `npm run auth:bootstrap -- <owner> <pass> [admin] [pass] [email]` | cuenta CPS + OWNER institucional (+ ADMIN) |
| `npm run geography:sync` | sincroniza geografía desde georef |

## Reglas de la casa

1. **El SQL manda**: las invariantes viven en la migración (FK compuestas, CHECKs,
   índices únicos parciales); las entidades solo describen.
2. **El rol dice QUÉ; el alcance dice DÓNDE**: todo endpoint con `:id` valida
   alcance además de rol (`docs/seguridad.md`).
3. **Los cupos son tarifa**: solo CPS los toca y todo cambio queda en `audit_log`.
4. **`device_state` no se escribe desde acá**: es del servicio de alarmas (programa
   aparte que comparte solo la base).
