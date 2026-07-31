# Rediseño del frontend — diseño acordado

> **Fecha:** 2026-07-31
> **Alcance:** panel de operador (CPS + organizaciones). El vecino queda afuera.
> **Eje:** estructura e información primero; los colores, al final.

---

## 1. Por qué

El frontend está migrado a la API v2 y funciona, pero acumula tres problemas que
el usuario identificó como los que duelen (en este orden):

1. **No se encuentran las cosas** — la navegación no acompaña cómo se trabaja.
2. **Se ve viejo** — cara de Bootstrap por defecto, sin identidad.
3. **Es lento de operar** — demasiados clics para llegar a lo frecuente.

Se ataca (1) primero porque condiciona a las otras dos: no se puede decidir
densidad visual ni atajos de flujo sin saber qué pantallas van a existir.

### Auditoría — lo que se encontró

28 pantallas en 13 features y **un solo componente compartido** (`map`).

| Problema | Evidencia |
|---|---|
| Casi no hay capa compartida | 26 spinners, 21 estados vacíos, 19 campos de formulario, 17 badges, 11 tablas, 5 paginaciones — todo copiado a mano |
| Alerts inconsistentes | 37 instancias con **8 combinaciones de clase** distintas para 3 estados semánticos |
| Templates mezclados | 20 externos, 8 inline; `account-form.ts` 599 líneas, `plan-list.ts` 366 |
| Dos marcas | sidebar "Sistema de Monitoreo" vs navbar "Alarmas Comunitarias" |
| Menú desbalanceado | 6 secciones, 4 de ellas solo-CPS |
| Rutas provisorias | `/alarmas/stock` e `/inventario/controles`, declaradas así en el propio código |
| "Alarmas" duplicada | Territorio (instaladas) vs Inventario (fábrica) |

---

## 2. Decisiones tomadas

### 2.1 Alcance: solo el operador

El rediseño abarca CPS y organizaciones. El vecino queda como está y se resuelve
después, probablemente en la app de vecinos. Motivo: operador y vecino tienen
necesidades opuestas (tablas densas y filtros vs. consulta ocasional), y hoy
comparten un shell pensado para el operador.

### 2.2 Estructura: corte Operar / Administrar

Se descartaron dos alternativas:

- **Refinar lo actual** — hereda el problema de fondo: un menú para cuatro roles.
- **Espacios de trabajo por rol** — resuelve un problema que todavía no existe;
  requiere saber cuánta gente usa dos sombreros, y eso no está definido.

Se eligió el corte por **frecuencia de uso**, que es el criterio que el propio
código ya venía aplicando como excepción (`shell.html:214` explica que Inventario
no se metió en Mi Empresa porque es tarea diaria). El rediseño lo convierte en
regla.

### 2.3 Ciclo de vida de la alarma

Ya existe en la base; el front no lo refleja. Son **dos ejes independientes**.

**Eje 1 — Estado administrativo** (`device_status`):

| Estado | Significa | Custodia |
|---|---|---|
| `INVENTORY` | Existe, no está instalada | Fábrica CPS (`organization_id` NULL) **o** stock de una organización |
| `OPERATIONAL` | En servicio | Barrio |
| `MAINTENANCE` | En reparación | Barrio |
| `OUT_OF_SERVICE` | Baja temporal | Barrio |
| `RETIRED` | Baja definitiva | Barrio |

Los CHECK de `esquema-postgres-v2.sql:483-491` ya garantizan que `INVENTORY` ⟺
sin barrio, y que el stock organizacional solo existe en `INVENTORY`.

**Eje 2 — Hitos de puesta en marcha** (dentro de fábrica): creada →
provisionada (MQTT) → etiquetada → primera conexión. La etapa **se deriva del
último hito**; no hay ni habrá columna de etapa (`esquema-postgres-v2.sql:456-459`).

**`INSTALLED` se elimina.** Decisión del usuario: es lo mismo que `OPERATIONAL`.
Se confirmó que el backend **ya nunca lo escribe** — al fabricar con barrio y al
reclamar va directo a `OPERATIONAL` (`devices.service.ts:224` y `:309`). Solo
sobrevive en tres `@case` de templates que nunca se cumplen.

**Devolver stock a CPS: no.** Una organización no devuelve equipos. El CHECK lo
permitiría, pero no habrá pantalla ni endpoint.

**`RETIRED` y la reutilización de MAC: sin definir a propósito.** Será una tarea
exclusiva de CPS y se define más adelante. No se diseña nada al respecto ahora.

### 2.4 Reglas de dominio que el diseño debe preservar

- La alarma es del **barrio**, nunca de la vivienda. "Inventario de la
  municipalidad" es **custodia**, no propiedad.
- `OPERATIONAL` **no** significa "está andando ahora". El estado vivo
  (online/offline, última señal) vive en `device_state` y lo escribe únicamente
  el servicio de alarmas. La UI los muestra separados.
- Los cupos solo los modifica CPS, con `audit_log`.

---

## 3. El mapa de navegación

```
OPERAR                        el día a día — todos, recortado por alcance
  Eventos                     tablero del monitoreo
  Barrios                     (singular si la organización es COMMUNITY)
  Viviendas
  Alarmas                     las que están en servicio
  Controles

INVENTARIO                    equipos que todavía no están en servicio
  Alarmas                     stock, con filtro por custodia y estado
  Fábrica                     alta desde MAC + hitos                 · solo CPS
  Entregas                    lotes a organizaciones                 · solo CPS
  Controles                   alta y stock

ADMINISTRAR                   de vez en cuando — comercial
  Clientes                                                           · solo CPS
  Contratos                                                          · manager
  Usuarios                                                           · solo CPS

MI EMPRESA                    el negocio de CPS                      · solo CPS
  Personal
  Planes
```

**"Alarmas" deja de estar duplicada.** El corte pasa a ser *en servicio* vs *no
en servicio*, que es el CHECK real de la base (`INVENTORY` ⟺ sin barrio). La
navegación refleja una invariante, no una convención.

**Inventario existe para los dos**, recortado por alcance en el backend: CPS ve
todo el stock, la organización ve el suyo. Fábrica y Entregas son sub-pestañas
solo-CPS.

**Se resuelven las rutas provisorias.** `/alarmas/stock` se parte: la **entrega
de lotes** va a Inventario/Entregas; la **instalación por reclamo** va al detalle
del barrio, que es donde está parado el técnico cuando instala.
`/inventario/controles` deja de ser un formulario suelto y gana listado propio,
al molde del de alarmas.

**Los links viejos siguen andando** con redirects, extendiendo el patrón que ya
existe en `app.routes.ts` para `/cuentas`.

**Una sola marca:** "CPS Security".

---

## 4. La capa compartida

**Se extrae al rediseñar, no antes.** Construir una librería por adelantado
produciría abstracciones inventadas para pantallas que todavía no rediseñamos.
La capa compartida es un subproducto de las primeras fases.

### Candidatos, por evidencia

| Componente | Qué resuelve | Evidencia | Cuándo |
|---|---|---|---|
| `cps-page` | Encabezado: título, acciones, volver | las 28 lo arman a mano | Fase 2 |
| `cps-async` | Carga / vacío / error en un bloque | 26 + 21 | Fase 2 |
| `cps-alert` | 3 variantes semánticas | 37 instancias, 8 variantes | Fase 2 |
| `cps-status` | estado → etiqueta + color, en un solo lugar | 17 archivos | Fase 2 |
| `cps-field` | label + control + error | 19 archivos | Fase 5 |
| `cps-table` | markup de tabla | 11 archivos | **condicional** |
| `cps-paginator` | paginación | 5 archivos | Fase 2 |

`cps-table` es condicional a propósito: las columnas varían mucho entre
pantallas y una tabla genérica mal abstraída es peor que 11 tablas honestas. Se
decide con dos casos reales en la mano, en la Fase 2.

### El único que se diseña por adelantado

`cps-device-status` — muestra **los dos ejes juntos**, visualmente separados: el
estado administrativo y el estado vivo de `device_state`. Hace evidente el caso
que hoy no se ve: *alarma `OPERATIONAL` que lleva tres días sin conectarse*.

Va por adelantado porque implementa la regla 5 del dominio: si cada pantalla lo
resuelve a su manera, la regla se pierde.

### Archivos a partir

`account-form.ts` (599 líneas) y `plan-list.ts` (366) pasan a `templateUrl`
**como parte de su rediseño**, no como refactor suelto. Los otros seis inline
(`user-form`, `account-list`, `remote-form`, `user-list`, `home-form`,
`contract-list`, 130-220 líneas) se convierten cuando les toque el turno.

---

## 5. Fases

El orden es por **cuánto destraba cada fase la siguiente**, no por importancia.

> **Una fase, un plan.** Este spec cubre el rediseño completo, pero es demasiado
> grande para un solo plan de implementación. Cada fase recibe su propio plan
> cuando le llega el turno, escrito con lo aprendido en la anterior. El plan que
> sigue a este documento cubre **solo la Fase 1**.

### Fase 1 — Shell y rutas

Solo `shell.html`, `shell.ts` y `app.routes.ts`. Se implementa el mapa de la
§3 con los redirects. Ninguna pantalla cambia por dentro: sale navegable en un
paso y permite *ver* la estructura antes de invertir en pantallas. Se unifica la
marca.

### Fase 2 — Eventos

`event-list` es la primera pantalla rediseñada de verdad: es la más rica (tabla,
paginación, filtros, filas expandibles, acciones) y donde el monitor vive todo el
día. De acá salen `cps-page`, `cps-async`, `cps-alert`, `cps-status` y
`cps-paginator`, y se decide con evidencia si `cps-table` vale la pena.

### Fase 3 — Alarmas en servicio

`device-list` + `device-detail`. Aterriza `cps-device-status` con los dos ejes.

**Toca la base**: migración que saca `INSTALLED` del enum `device_status`.
Postgres no tiene `DROP VALUE`, así que se recrea el tipo (`CREATE TYPE ..._new`
→ `ALTER TABLE ... USING` → drop → rename), a mano, siguiendo
`backend-nestjs/docs/migraciones.md`. Se actualizan los tres lados: migración,
entidad y `docs/esquema-postgres-v2.sql`. También `common/enums.ts`,
`api.models.ts` y los tres `@case` muertos.

Va sola, con verificación completa de backend y frontend antes de seguir.

### Fase 4 — Inventario

La sección nueva: Alarmas (stock), Fábrica, Entregas, Controles. Es la más
pesada: se parte `/alarmas/stock` en dos y Controles gana listado propio.

**Cambia de audiencia**: Inventario pasa de `cpsGuard` a ser visible por
organizaciones con su stock. Antes de darla por buena, `permisos-check` y el
barrido de ataques cruzados — una organización no puede ver el stock de otra ni
el de fábrica.

### Fase 5 — El resto, en tandas

Barrios, Viviendas, **Controles de Operar** (`remote-list` — los de la vivienda,
distintos de Inventario/Controles de la Fase 4), Clientes, Contratos, Usuarios,
Personal, Planes, Perfil, Dashboard y las de auth. La capa compartida ya existe,
así que cada pantalla es rápida. Acá se parten los dos archivos gordos.

### Fase 6 — Los colores

Recién acá se fija la paleta y la identidad visual. Hasta entonces todo se hace
con lo que hay y los colores que aparezcan son descartables.

---

## 6. Fuera de alcance

- **El vecino** — se resuelve después, probablemente en la app de vecinos.
- **`RETIRED` y la reutilización de MAC** — decisión abierta de CPS.
- **Devolución de stock a CPS** — decidido que no existe.
- **El servicio de alarmas** (`gateway-to-device`) — otro repo, no se toca.
- **Migrar de Bootstrap** — no hay motivo.
- **El interceptor de refresh y `AuthService`** — funcionan, no son parte del
  rediseño.
- Cualquier refactor que no esté en la ruta del rediseño.

---

## 7. Verificación

Por fase, en frontend:

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build && npm test -- --watch=false
```

Más `webapp-testing` (Playwright) para ver la pantalla andando, no solo
compilando.

En la Fase 3, además, backend completo:

```bash
cd backend-nestjs
npx tsc --noEmit && npx eslint "src/**/*.ts" && npm test
```

En la Fase 4, el barrido de ataques cruzados de
`backend-nestjs/docs/seguridad.md`.

No se declara una fase terminada sin haber corrido estos comandos y visto la
salida.
