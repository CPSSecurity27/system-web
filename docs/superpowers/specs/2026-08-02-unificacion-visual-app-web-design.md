# Unificación visual app ↔ panel web — diseño acordado

> **Fecha:** 2026-08-02
> **Alcance:** panel de operador (`frontend-angular/`). El vecino y la app quedan afuera.
> **Origen:** el relevamiento que mandó el equipo de la app (`inventario-diseno-app.md`,
> repo `App_Alarma`, commit `f679662`).
> **Relación con el rediseño en curso:** esto **es** la Fase 6 del
> `2026-07-31-rediseno-frontend-design.md`, adelantada. Ver §6.

---

## 1. Por qué

El panel y la app tienen que verse como el mismo producto. Hoy no se parecen en
nada: distinto color de marca, distinta tipografía, distinto basemap, distinto
set de íconos. Pero el motivo real para hacer esto ahora no es la coherencia
entre productos — es un problema del panel por sí solo.

### El problema de fondo: el rojo no significa nada

En [`styles.scss:22-37`](../../../frontend-angular/src/styles.scss#L22-L37):

```scss
$primary: $brand,   // #d32f2f
$danger:  $brand,   // #d32f2f  ← el mismo color
```

**`primary` y `danger` son el mismo rojo.** El botón "Guardar" de un alta de
vivienda sale del mismo color que el badge de "Emergencia abierta". En un panel
de monitoreo eso es la peor falla posible: cuando entra un evento real no
resalta, porque la pantalla ya venía gritando.

La app resolvió exactamente esto y su decisión es la pieza más valiosa del
relevamiento, más que la paleta en sí:

> **Azul `#2563EB` es la marca. El rojo `#DC2626` es EXCLUSIVO de emergencia.**

### Lo secundario, pero real

- El panel guarda `event.trigger_mode` y **no lo muestra en ninguna pantalla**
  (§3.3). El monitor no ve si el evento es incendio, médica o ladrón.
- Los dos productos usan basemaps distintos: el mismo barrio se ve de dos
  colores según desde dónde lo mires.
- Con sala de monitoreo confirmada como contexto de uso (§2.3), el **modo
  oscuro pasa de capricho a requisito**, y hoy la arquitectura de tokens del
  panel no lo permite: son variables SCSS compiladas, no custom properties.

---

## 2. Decisiones tomadas

### 2.1 Azul de marca, rojo de emergencia — CONFIRMADO

Se adopta el principio de la app. El rojo deja de ser identidad y pasa a ser
semántica de una sola cosa: emergencia, error y acción destructiva.

**Se descartó** unificar solo el tono de rojo (barato pero no arregla el
problema de fondo, y el panel seguiría sin parecerse a la app) y mantener el
rojo actual (deja el panel gritando).

### 2.2 Íconos: se migra a Lucide — CONFIRMADO

El panel pasa de `bootstrap-icons` a `lucide-angular`. Verificado:
`lucide-angular@1.0.0` declara `@angular/core: 13.x - 21.x`, compatible con el
Angular 21.2 del proyecto.

> **Objeción registrada, decisión mantenida.** Recomendé quedarnos con Bootstrap
> Icons y copiar solo el CATÁLOGO (qué ícono significa qué): son **261 usos de
> 80 íconos distintos** y es el ítem más caro de la migración, el que menos se
> nota al lado del cambio de rojo, y `lucide-angular` está en un `1.0.0` recién
> salido. El usuario decidió migrar igual, por unificación completa con la app.
> Se ejecuta como **barrido único** (§6, Fase F), nunca de a pantallas: la
> convivencia de dos sets es justo la deuda que la app ya tiene.

**Cómo terminó implementándose (2026-08-02).** No se usa `lucide-angular` (los
componentes SVG) sino la **fuente** de `lucide-static`, subseteada. Dos motivos,
los dos aparecieron al hacerlo:

1. **El mapa arma sus marcadores con `L.divIcon()`**, que recibe HTML crudo
   fuera del árbol de Angular. Un componente no se puede renderizar ahí; una
   clase CSS sí. Con SVG habría que mantener los íconos del mapa en otro
   sistema — la convivencia de dos sets que queríamos evitar.
2. Sumar `lucide.css` al array `styles[]` de `angular.json` **funciona en
   `ng build` pero el dev server lo descarta en silencio** (leaflet, que va
   después en la misma lista, sí entra).

La salida es `scripts/generar-iconos.py`: barre el código, saca los codepoints
de los íconos realmente usados, subsetea la fuente y emite `src/styles/_icons.scss`.
Resultado: **71 íconos, la fuente de 269 KB a 13,5 KB**, y el mismo
comportamiento en dev y en prod porque es código nuestro. `iconos.spec.ts`
falla si alguien agrega un `icon-*` y no vuelve a correr el script.

### 2.3 Contextos de uso: los cuatro — CONFIRMADO

El panel se opera desde **notebook/PC, pantalla grande de sala de monitoreo,
tablet y celular del técnico en la calle**.

Esto expande el alcance respecto de lo que suponía el rediseño original:

| Contexto | Qué obliga |
|---|---|
| Notebook / PC | El caso base. Es lo único que el panel contempla hoy. |
| Sala de monitoreo | **Modo oscuro es requisito.** Densidad y tipografía legibles a distancia. |
| Celular del técnico | Responsive real en detalle de equipo y mapa clickeable, usable con una mano. |
| Tablet | Punto intermedio; sale casi gratis si los otros dos están. |

**La app no aporta precedente para ninguno de los tres contextos nuevos:** es
sólo móvil, tiene **un único breakpoint** (700dp) y **no tiene modo oscuro**.
El modo oscuro del panel hay que **diseñarlo**, no copiarlo.

### 2.4 Tipografía: el panel no cambia

El panel ya carga **Inter** ([`index.html:13`](../../../frontend-angular/src/index.html#L13)).
La app no carga ninguna fuente y usa la del sistema. La divergencia se cierra
**del lado de la app**, no del nuestro. No es una decisión conjunta: es un
pendiente de ellos.

Único ajuste nuestro: Inter hoy entra por CDN de Google Fonts. Con sala de
monitoreo en juego, una pantalla que depende de que Google esté accesible es
frágil. **Se pasa a self-hosted** en la Fase A (es un paquete npm y dos líneas
de `angular.json`).

### 2.5 Arquitectura de tokens: custom properties, semánticas

Se abandonan las variables SCSS como fuente de verdad y se pasa a CSS custom
properties con **nombres semánticos** (`--surface`, `--text`, `--brand`), nunca
literales (`--gris-100`, `--azul`). Es condición necesaria para el modo oscuro,
y deja el white-label por cliente a costo casi cero si algún día se pide.

---

## 3. La paleta acordada

Valores tomados del anexo del relevamiento de la app, **con dos correcciones
propias** (§3.2).

### 3.1 Tokens — tema claro

```css
:root {
  /* Superficies */
  --surface-bg:   #F4F6FB;   /* fondo de la app */
  --surface:      #FFFFFF;   /* cards, barras */
  --surface-alt:  #EFF3F9;   /* hover, fondo de chip */
  --border:       #E3E8F2;   /* borde de card, divisores */

  /* Marca */
  --brand:        #2563EB;
  --brand-dark:   #1D4ED8;

  /* Estados */
  --danger:       #DC2626;   /* RELLENO, con texto blanco encima */
  --danger-text:  #B91C1C;   /* TEXTO e ÍCONOS rojos sobre fondo claro */
  --success:      #16A34A;
  --warning:      #F59E0B;   /* NUNCA como texto — ver §3.2 */

  /* Texto */
  --text:         #0F1B2D;
  --text-dim:     #5B6B85;

  /* Espaciado y radios */
  --sp-xs: 4px; --sp-sm: 8px; --sp-md: 12px;
  --sp-lg: 16px; --sp-xl: 24px; --sp-xxl: 32px;
  --r-card: 16px; --r-tile: 20px; --r-button: 14px; --r-pill: 999px;
}
```

### 3.2 Correcciones a los valores de la app

**a) El rojo va en par, no solo.** El relevamiento afirma que *"ambos rojos
fallan WCAG AA sobre fondo gris claro"*. Verifiqué los ratios y **no es así**:

| Color | vs `#FFFFFF` | vs `#F4F6FB` |
|---|---|---|
| `#d32f2f` (panel hoy) | 4.98 ✅ | **4.58 ✅ pasa** |
| `#DC2626` (app) | 4.83 ✅ | **4.44 ❌ falla** |
| `#B91C1C` | 7.06 ✅ | 5.95 ✅ |

El rojo actual del panel es *más* accesible que el de la app. Adoptar `#DC2626`
**junto con** el fondo `#F4F6FB` introduciría una falla de contraste que hoy no
tenemos. Por eso el par: `--danger` `#DC2626` para rellenos (blanco encima da
4.83 ✅) y `--danger-text` `#B91C1C` para texto e íconos rojos sobre claro.

**b) `--text-faint` no se adopta.** El `#909CB3` de la app da **2.77** sobre
blanco: falla AA y en la app se usa para texto real. En un panel con tablas
densas y una pantalla de sala mirada a distancia, eso no entra. Si hace falta un
tercer nivel de texto, **se genera y se mide en la Fase A**; no se copia un
valor que ya sabemos que falla.

**c) `--warning` `#F59E0B` da 2.15 sobre blanco.** Se adopta el color pero con
la regla de composición de la app: **relleno teñido + texto en `--text`**, nunca
ámbar como color de texto o de ícono chico.

### 3.3 El catálogo de los 8 modos

La base ya lo guarda: `event.trigger_mode TEXT` con el catálogo del hardware
([`esquema-postgres-v2.sql:706`](../../esquema-postgres-v2.sql#L706)), y el
panel ya lo tipa (`triggerMode: string | null`,
[`api.models.ts:377`](../../../frontend-angular/src/app/core/models/api.models.ts#L377)).
**No se muestra en ninguna pantalla.** El tablero de eventos pinta `origin`
("APP", "REMOTE") como badge gris.

Se porta el catálogo de la app tal cual, a `core/alarm-modes.ts`:

| Código | Etiqueta | Ícono (Lucide) | Token de color |
|---|---|---|---|
| `cps001` | Activar Alarma | `siren` | `--danger` `#DC2626` |
| `cps002` | Sospechoso | `eye` | `--warning` `#F59E0B` |
| `cps003` | Ladrón | `footprints` | `--mode-ladron` `#8B5CF6` |
| `cps004` | Policía | `shield` | `--brand` `#2563EB` |
| `cps005` | Silenciosa | `bell-off` | `--mode-silenciosa` `#64748B` |
| `cps006` | Incendio | `flame` | `--mode-incendio` `#F97316` |
| `cps007` | Médica | `heart-pulse` | `--mode-medica` `#EC4899` |
| `cps999` | Desactivar | `power` | `--mode-desactivar` `#0EA5A5` |

**Son 8, no 6:** Médica y Desactivar están hardcodeados dentro de un `switch` en
la app y no tienen token allá. Acá nacen como tokens desde el día uno.

Reglas: los códigos **no se tocan** (viajan por MQTT y quedan escritos en la
base); etiqueta, ícono y color sí son nuestros. Un código desconocido se muestra
crudo, nunca rompe la pantalla — mismo criterio que
[`lookOf()`](../../../frontend-angular/src/app/shared/ui/status/status-map.ts#L54).

### 3.4 Reglas de composición

Esto es lo que hace que los colores funcionen a pesar del contraste bajo. Se
copian de la app porque están validadas en uso:

- **Ícono en cuadrado teñido:** fondo = color al **14–16%** de alpha, ícono al
  100%, contenedor de 32/46/48px con radio 9/14. Es el patrón más reconocible
  de la app.
- **Tarjeta de estado:** fondo = color al **7–8%**, borde = color al **30–35%**,
  **texto siempre en `--text`**, nunca en el color de estado.
- **Cards sin sombra:** borde `1px var(--border)` + radio 16. La app no usa
  sombra para separar; usa borde.
- **Botones:** alto 52px, radio 14, texto `15px/700-800`.
- **Encabezado de sección:** `12px/800`, `letter-spacing 0.6px`, MAYÚSCULAS.
- **AppBar/navbar plano:** sin sombra, fondo = fondo de la app.

---

## 4. Qué NO se copia

De la deuda que el propio relevamiento marca:

| De la app | Por qué no |
|---|---|
| 135 `fontSize` sueltos, sin escala | El panel tiene **13** ocurrencias y usa la escala de Bootstrap. Acá vamos mejor. |
| 38 hex hardcodeados | El panel tiene **9**, y 3 son la leyenda del mapa (se eliminan en Fase E). |
| Excepciones crudas en pantalla (`'No se pudo enviar: $e'`) | El panel muestra los 400/409 estructurados del backend a propósito. |
| Cero `Semantics` / a11y | El panel está igual de mal (**2 `aria-label`**), pero eso se arregla (Fase J), no se copia. |
| No respetar `prefers-reduced-motion` | El panel **sí** lo respeta ([`styles.scss:114`](../../../frontend-angular/src/styles.scss#L114)). No se toca. |
| Formato de fechas a mano en 5 lugares | Se centraliza (Fase J). |

### Lo que el panel ya tiene mejor y no se regresa

- **9 archivos de test que pasan**, contra 1 test roto en la app.
- **`status-map.ts`** ya implementa "estado → look en un solo lugar", justo lo
  que a la app le falta para todo lo que no sean modos.
- Capa `shared/ui` con 5 componentes y el porqué documentado.

### La expectativa que hay que bajar

**La app no tiene ni una tabla, ni paginación, ni filtros, ni formularios
densos.** Para más de la mitad de la superficie del panel no hay precedente que
copiar. Lo que se unifica es: tokens, iconografía, mapa y reglas de composición.
La UI de datos sigue siendo decisión nuestra.

---

## 5. Estado real del panel (medido hoy)

Números del relevamiento propio, para dimensionar cada fase:

| Qué | Cuánto |
|---|---|
| Líneas en `src/app` | 12.874 |
| `text-brand` | 74 |
| `bg-brand-soft` | 44 |
| `btn-brand` | 37 |
| `btn-outline-brand` | 11 |
| `btn-primary` / `text-primary` / `bg-primary` | **0** — nunca se usaron las de Bootstrap |
| Íconos `bi-*` | 261 usos, 80 distintos |
| Hex hardcodeados | 9, en 3 archivos |
| `spinner-border` vs `cps-async` | **81** vs **8** |
| `class="badge"` vs `cps-status` | **67** vs **6** |
| `aria-label` | 2 |
| Templates inline vs `templateUrl` | 12 vs 22 |

**Dos lecturas que ordenan el plan:**

1. **Todo el rojo pasa por 4 clases propias.** No hay que barrer utilidades de
   Bootstrap por el código. Pero esas clases están **semánticamente
   sobrecargadas**: `text-brand` significa a la vez identidad (ícono de
   encabezado, marca del navbar) y peligro (alerta de error en
   [`alert.ts:10`](../../../frontend-angular/src/app/shared/ui/alert/alert.ts#L10),
   evento OPEN y equipo OUT_OF_SERVICE en
   [`status-map.ts`](../../../frontend-angular/src/app/shared/ui/status/status-map.ts#L22)).
   El trabajo real es **separar los dos significados en ~166 usos**, no
   reemplazar un hex.

2. **La capa compartida existe pero está poco adoptada.** Se creó en la Fase 2 y
   las pantallas viejas nunca se convirtieron: 81 spinners contra 8 `cps-async`.
   La migración es la oportunidad de cerrar esa brecha sin tocar nada dos veces.

---

## 6. Las fases

> **Una fase, un plan.** Este spec cubre la migración completa; cada fase recibe
> su plan de implementación cuando le toca, escrito con lo aprendido en la
> anterior.

**Relación con el rediseño en curso:** las Fases 1 a 4 del
`2026-07-31-rediseno-frontend-design.md` están hechas (shell, eventos, alarmas,
inventario). Quedaban la 5 (el resto de las pantallas) y la 6 (los colores).
**Se invierte el orden: los colores van primero.** Rediseñar Barrios, Viviendas,
Clientes, Usuarios, Planes y Perfil con el rojo viejo y repintarlas después
significa tocarlas dos veces. La vieja Fase 5 se absorbe acá como Fase I.

### Bloque 1 — Fundaciones (no se ve nada)

**Fase A — Tokens.** `styles.scss` pasa de variables SCSS a custom properties
`:root{}` con nombres semánticos, **conservando los valores rojos actuales**. Se
separa `$primary` de `$danger` en el `@use` de Bootstrap. Se define y mide el
tercer nivel de texto (§3.2b). Inter pasa a self-hosted.
→ *Criterio de éxito: la pantalla se ve **exactamente igual** que antes.*

**Fase B — El split semántico.** Clasificar los ~166 usos de las 4 clases de
marca en IDENTIDAD vs PELIGRO y repuntar cada uno. Repuntar `alert.ts`
(variante error) y `status-map.ts` (OPEN, OUT_OF_SERVICE) a tokens de peligro.
→ *Criterio de éxito: sigue todo rojo, la pantalla **no cambia**.*
→ *Es la fase con más riesgo de error humano: se revisa pantalla por pantalla.*

### Bloque 2 — La identidad nueva

**Fase C — El flip.** `--brand` pasa de rojo a `#2563EB`. Un archivo. Lo bien
clasificado se vuelve azul; el rojo sobrevive solo donde significa emergencia.
Entran superficies (`#F4F6FB`), cards con borde en vez de sombra, radios,
escala de espaciado y el par de rojos accesibles.
→ *Acá el panel pasa a verse como la app.*

**Fase D — El catálogo de modos.** `core/alarm-modes.ts` con los 8 modos, y
`triggerMode` renderizado en el tablero de eventos, en el marcador del mapa y en
el detalle del equipo. **Es la fase que más valor operativo entrega**: tapa un
agujero funcional, no repinta.

**Fase E — El mapa.** Tiles CARTO Voyager + atribución, pin tipo gota con la
corrección de anclaje que la app ya pagó
(`map_tiles.dart:56-61` — el globo rotado no llena su caja), variantes alineadas
y **la leyenda leyendo de la misma fuente que los marcadores** (hoy duplica 3
hex en [`neighborhood-detail.html:65-76`](../../../frontend-angular/src/app/features/neighborhoods/neighborhood-detail.html#L65-L76)).
Se deja preparada la constante de Dark Matter para la Fase G.

### Bloque 3 — Sistema completo

**Fase F — Lucide.** Barrido único: 261 usos, 80 íconos. Se arma primero la
tabla de equivalencias `bi-*` → Lucide, se revisa una vez, y recién ahí se
ejecuta. **No se hace de a pantallas.**

**Fase G — Modo oscuro.** Requisito de la sala de monitoreo. **Se diseña, no se
copia** (la app no tiene). Paleta oscura derivada de los tokens semánticos,
`prefers-color-scheme` + override manual, color modes de Bootstrap 5.3, y el
basemap Dark Matter. Cada valor se mide contra WCAG antes de fijarlo.

**Fase H — Responsive.** El contrato de breakpoints y densidad para los cuatro
contextos. Pasada dedicada sobre las pantallas ya rediseñadas (shell, eventos,
alarmas, inventario), con foco en el técnico en el celular: detalle de equipo y
mapa clickeable usables con una mano.

**Fase I — Las pantallas que faltan** (la vieja Fase 5). Barrios, Viviendas,
Controles de Operar, Clientes, Usuarios, Personal, Planes, Perfil, Dashboard y
las de auth — ya con el diseño nuevo, en una sola pasada. Se aprovecha para bajar
los 81 spinners a `cps-async` y los 67 badges a `cps-status`, y para partir
`account-form.ts` (595) y `account-members.html` (639).

### Bloque 4 — Cierre

**Fase J — Accesibilidad y formatos.** `aria-label` en botones de solo ícono,
foco visible, barrido de contraste. Helper único de fechas, coordenadas y
teléfono, **con la zona horaria declarada** — en el panel importa más que en la
app porque el operador puede estar en otra provincia que el evento.

---

## 7. Riesgos y preguntas abiertas

| # | Qué | Estado |
|---|---|---|
| 1 | **Política de uso de CARTO.** El basemap es gratuito con atribución en volúmenes bajos, pero el uso productivo requiere cuenta. Nadie verificó el límite. Con un municipio arriba deja de ser un detalle. | **Necesita dueño antes de la Fase E.** |
| 2 | **No hay logo vectorial.** Sólo `logo.png` (13 KB), igual que la app. Para modo oscuro (un logo horneado para fondo claro se ve mal en oscuro), pantalla de sala y favicon hace falta el original vectorial. | **Bloquea parte de la Fase G.** |
| 3 | **El nombre del producto.** Conviven "CPS Security" (sidebar y navbar), "Sistema de Monitoreo" (título de la pestaña, [`index.html:5`](../../../frontend-angular/src/index.html#L5)), y del lado app "Alarma CPS Security" y "Alarma Vecinal". | Decisión de negocio, no de diseño. |
| 4 | **`lucide-angular` está en `1.0.0`.** Major recién salido; poca superficie de rodaje. | Se fija la versión y se revisa en la Fase F. |
| 5 | **Modo oscuro sin precedente.** No se copia de ningún lado; se diseña y se mide. | Riesgo de alcance de la Fase G. |
| 6 | **Tipografía de la app.** Inter queda del lado de ellos. Hasta que lo hagan, los productos siguen con tipografías distintas. | Pendiente del equipo de la app. |

---

## 8. Fuera de alcance

- **La app** — sus fases de deuda (fontSize, hex, a11y) son de ellos.
- **El vecino** — sigue fuera, como en el rediseño original.
- **Migrar de Bootstrap** — no hay motivo; se le cambian los tokens, no se saca.
- **El servicio de alarmas** (`gateway-to-device`) — otro repo.
- **Tiempo real en el panel** — la app es toda push por Firebase RTDB; el panel
  consume REST. Si el tablero tiene que "latir", es una decisión de
  backend-web (WebSocket / SSE / polling) y **no es parte de esta migración**.
- **White-label por cliente** — no se implementa, pero la arquitectura de tokens
  de la Fase A lo deja posible a costo casi cero.

---

## 9. Verificación

Por fase, en el frontend:

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build && npm test -- --watch=false
npx prettier --write .
```

En las Fases A y B, además, la verificación es **visual y de no-cambio**:
capturas antes/después de las pantallas tocadas, que tienen que ser idénticas.
A partir de la Fase C, capturas comparadas contra las pantallas equivalentes de
la app.
