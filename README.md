# CPS Security

Plataforma de **seguridad comunitaria monitoreada**: alarmas comunitarias en la vía
pública de barrios, controles remotos por hogar, panel de administración y monitoreo,
y app de vecinos. Se vende en dos esquemas: **público** (municipalidades que se
autogestionan) y **privado** (comunidades que gestiona CPS).

## Estructura del repo

```
CPS/
├── CLAUDE.md                  ← guía para trabajar con la IA (leer primero)
├── docs/                      ← diseño y estado del proyecto
│   ├── estado-proyecto.md     ← DÓNDE ESTAMOS y qué sigue (empezar por acá)
│   ├── negocio-redisenado.md  ← cómo funciona el negocio
│   ├── diseno-relaciones-fase1.md ← diseño del modelo (decisiones y por qué)
│   ├── esquema-postgres-v2.sql    ← DDL, fuente de verdad del esquema
│   └── relevamiento-fase0.md  ← histórico: el análisis que originó el rediseño
├── backend-nestjs/            ← API (NestJS + PostgreSQL) — modelo v2 ✅
│   └── docs/                  ← detalle por módulo
└── frontend-angular/          ← panel web (Angular) — pendiente de migrar a v2 ⚠️
    └── docs/
```

## Estado (2026-07-16)

- **Diseño v2 cerrado** (todas las decisiones tomadas y documentadas).
- **Backend migrado a v2**: compila, lint y tests en verde. Falta probarlo contra
  una base PostgreSQL nueva.
- **Frontend desalineado**: habla la API v1; su migración es el próximo gran paso.
- **Servicio de alarmas** (MQTT, programa separado): se diseña a futuro.

El detalle completo, con los pendientes ordenados: [docs/estado-proyecto.md](docs/estado-proyecto.md).

## Levantar el backend

```bash
cd backend-nestjs
npm install
# crear una base PostgreSQL NUEVA y apuntar el .env a ella
npm run migration:run
npm run auth:bootstrap -- cps_root <clave_fuerte> ale_copa <clave> mail@cps.com
npm run geography:sync
npm run start:dev        # http://localhost:3000/api — Swagger en /api/docs
```
