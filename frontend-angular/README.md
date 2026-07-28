# CPS Security — Frontend (Angular)

Panel web del sistema CPS: eventos (tablero de monitoreo), barrios, viviendas y
sus miembros, alarmas (fábrica/stock/claim), controles, cuentas con cupos,
contratos y usuarios, con mapa (Leaflet) y sesión JWT con refresh rotativo.

> ✅ **Estado (2026-07-18): MIGRADO a la API v2.** Qué cambió y qué queda
> pendiente: [`docs/pendientes-y-decisiones.md`](docs/pendientes-y-decisiones.md).
> El contrato v2 de la API: [`../backend-nestjs/docs/frontend-handoff.md`](../backend-nestjs/docs/frontend-handoff.md).

## Correr en local

```bash
npm install
ng serve          # http://localhost:4200 (el backend debe correr en :3000)
```

Node 22 o 24 (los impares dan warning de Angular y rompen jsdom en los tests).

## Notas de la base de código

- Estilos: [`docs/angular-ui-styles-spec.md`](docs/angular-ui-styles-spec.md).
- Leaflet va declarado en `allowedCommonJsDependencies` y los íconos se dibujan
  con `divIcon` propio (el ícono de la librería se rompe con el bundler).
- `TokenStorage` es la única costura que toca `localStorage` (los tests usan una
  implementación en memoria).
- El interceptor mantiene **una sola promesa de refresh** (el refresh rota; cinco
  401 en paralelo no deben disparar cinco refresh).
