# Geografía — sync desde georef

`province → department → locality`. Read-only: no se administran desde el panel,
se sincronizan desde la API de georef (`apis.datos.gob.ar/georef/api`).

## Cómo se corre

```bash
npm run geography:sync              # CLI
POST /api/geography/sync            # HTTP, solo ADMIN de la cuenta COMPANY
```

**Manual, no hay cron.** Las dos vías llaman al MISMO `GeographySyncService`.
El endpoint pide el par `(COMPANY, ADMIN)` y no "rol ADMIN" a secas: un ADMIN de
una organización no debe poder reescribir la geografía de todo el sistema.

## Endpoints (`/api/geography`)

Lectura: cualquier usuario logueado. **No hay POST/PATCH/DELETE**: la geografía no se
administra a mano, entra solo por el sync.

| método | ruta | para qué |
|---|---|---|
| GET | `/provinces` | combo de provincias |
| GET | `/provinces/:id/departments` | cascada |
| GET | `/departments/:id/localities` | cascada |
| GET | `/localities/search?search=&limit=` | autocomplete (mín. 2 caracteres) |
| GET | `/localities/:id` | localidad + su departamento y provincia |
| POST | `/sync` | dispara la sincronización (COMPANY/ADMIN) |

Un id inexistente da **404**, no una lista vacía: si no, el front no puede distinguir
"no hay" de "te equivocaste de id".

### El buscador ignora acentos (a propósito)

`ILIKE` ignora mayúsculas pero **no acentos**: "cordoba" no encontraba "Córdoba" ni
"rio cuarto" a "Río Cuarto", y nadie escribe tildes en el teclado del celular.

Se resuelve con la extensión `unaccent` + un wrapper `immutable_unaccent()` (unaccent es
STABLE y Postgres no deja indexar eso) y un índice **GIN/pg_trgm** — un btree no sirve
para `%texto%`. La consulta usa **la misma expresión** que el índice; si no coinciden
exacto, Postgres lo ignora y hace seq scan.

El buscador devuelve el árbol completo (departamento + provincia) porque hace falta para
desambiguar: hay 3 "Villa María" en el país.

## Reglas

- **Upsert por `georef_id`, nunca DELETE + INSERT.** Es idempotente: correrlo N veces
  da lo mismo que correrlo una. El `id` interno nunca cambia, así que un `neighborhood`
  sigue apuntando a su localidad después de re-sincronizar.
- **`georef_id` es TEXT, no INT.** Los códigos llevan ceros a la izquierda (`"06"`).
- **Nunca borra.** Si algo desaparece de georef, se loguea como huérfano y sigue: puede
  haber un barrio colgando y el FK es `ON DELETE RESTRICT`. Borrar es decisión humana.
- **Una transacción.** Si georef se corta a mitad, no quedan departamentos sin provincia.
- Se descarga todo antes de abrir la transacción (no se espera a la red con una abierta).

## Fuente de datos

| tabla | endpoint | filas |
|---|---|---|
| `province` | `/provincias` | 24 |
| `department` | `/departamentos` | 529 |
| `locality` | `/localidades-censales` | 4027 (entran 4026) |

`locality` usa **`/localidades-censales`** (la ciudad real: "Córdoba") y **no**
`/localidades`, que devuelve sub-unidades *dentro* de la ciudad ("La Floresta") y se
solaparía con nuestro `neighborhood`.

El `max` de la API es 5000, así que hoy es 1 request por endpoint. El cliente pagina
igual por si crece.

## Caso conocido: CABA

Georef devuelve la Ciudad Autónoma de Buenos Aires como localidad censal con
`departamento: {id: null}` (CABA tiene comunas, no departamentos). Como
`locality.department_id` es NOT NULL, el sync la **descarta y avisa por WARN**.

Consecuencia: **no se puede crear un barrio en CABA**. Para CPS (Córdoba) no molesta.
Si hiciera falta, se carga esa localidad a mano contra la comuna que corresponda.

## Archivos

- `georef.client.ts` — HTTP contra georef, paginación.
- `geography-sync.service.ts` — upsert transaccional, resolución de padres, huérfanos.
- `geography-sync.cli.ts` — entrypoint de `npm run geography:sync`.
- `entities/` — `Province`, `Department`, `Locality`.
