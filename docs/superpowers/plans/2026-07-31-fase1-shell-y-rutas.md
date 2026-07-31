# Fase 1 — Shell y rutas: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar el mapa de navegación Operar / Inventario / Administrar / Mi Empresa en el shell y las rutas, sin tocar el interior de ninguna pantalla.

**Architecture:** La navegación deja de ser HTML con `@if` desparramados y pasa a ser un **modelo de datos puro** (`nav.ts`) que recibe los flags de rol y devuelve las secciones visibles. El template itera ese modelo. Así la estructura del menú se puede testear sin montar el componente ni simular sesiones.

**Tech Stack:** Angular 21 (standalone, signals), Bootstrap 5, Bootstrap Icons, Karma/Jasmine.

## Global Constraints

- Idioma: **español rioplatense (voseo)** en labels, comentarios y mensajes.
- Ninguna pantalla cambia por dentro en esta fase. Solo shell y rutas.
- Los guards **no cambian** en esta fase. Inventario sigue siendo `cpsGuard`; que las organizaciones vean su stock es Fase 4, junto con `permisos-check`.
- Todos los links viejos siguen andando vía redirect.
- Una sola marca: **"CPS Security"**.
- Verificación por tarea: `npx tsc --noEmit && npx ng build && npm test -- --watch=false` desde `frontend-angular/`.

## Desvíos respecto del spec (decididos acá)

1. **Dashboard** no figuraba en el mapa del spec §3, pero es la ruta `''` y tiene que ser alcanzable. Entra como primer item de Operar con el label **"Inicio"**.
2. **Entregas** no se crea en esta fase. Es la mitad de `/alarmas/stock` que hay que partir, y partir esa pantalla es Fase 4. Hasta entonces, Inventario/Alarmas apunta a la pantalla de stock completa.
3. Las rutas de Inventario se renombran por **lo que son**: `/inventario/stock` y `/inventario/fabrica`. `/inventario/alarmas` (que hoy es la fábrica) redirige a `/inventario/fabrica`, preservando el significado del link viejo.

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `src/app/layout/shell/nav.ts` | **Crear.** Modelo puro del menú: tipos + `buildNav(flags)`. Sin Angular, sin inyección. |
| `src/app/layout/shell/nav.spec.ts` | **Crear.** Tests del modelo por rol. |
| `src/app/layout/shell/shell.ts` | **Modificar.** Expone `sections` como `computed` sobre `buildNav`. |
| `src/app/layout/shell/shell.html` | **Modificar.** Itera `sections`. Marca unificada. |
| `src/app/app.routes.ts` | **Modificar.** Rutas nuevas de Inventario + redirects. |
| `src/app/app.routes.spec.ts` | **Crear.** Tests de los redirects. |

---

### Task 1: El modelo de navegación

**Files:**
- Create: `frontend-angular/src/app/layout/shell/nav.ts`
- Test: `frontend-angular/src/app/layout/shell/nav.spec.ts`

**Interfaces:**
- Consumes: nada (es la primera tarea).
- Produces:
  - `export interface NavItem { label: string; link: string; icon: string; }`
  - `export interface NavSection { label: string; items: NavItem[]; }`
  - `export interface NavFlags { isCps: boolean; isManager: boolean; isCommunityOrg: boolean; }`
  - `export function buildNav(flags: NavFlags): NavSection[]`

`buildNav` devuelve **solo las secciones con al menos un item visible**. Una sección vacía no se devuelve.

- [ ] **Step 1: Escribir el test que falla**

Crear `frontend-angular/src/app/layout/shell/nav.spec.ts`:

```ts
import { buildNav, NavFlags } from './nav';

const flags = (over: Partial<NavFlags> = {}): NavFlags => ({
  isCps: false,
  isManager: false,
  isCommunityOrg: false,
  ...over,
});

const sectionLabels = (f: NavFlags) => buildNav(f).map((s) => s.label);
const linksOf = (f: NavFlags, label: string) =>
  buildNav(f)
    .find((s) => s.label === label)
    ?.items.map((i) => i.link) ?? [];

describe('buildNav', () => {
  it('el vecino solo ve Operar', () => {
    expect(sectionLabels(flags())).toEqual(['Operar']);
  });

  it('Operar tiene las cinco pantallas del día a día más Inicio', () => {
    expect(linksOf(flags(), 'Operar')).toEqual([
      '/',
      '/eventos',
      '/barrios',
      '/viviendas',
      '/alarmas',
      '/controles',
    ]);
  });

  it('una organización COMMUNITY ve "Barrio" en singular', () => {
    const items = buildNav(flags({ isCommunityOrg: true }))[0].items;
    expect(items.find((i) => i.link === '/barrios')?.label).toBe('Barrio');
  });

  it('sin COMMUNITY el label es plural', () => {
    const items = buildNav(flags())[0].items;
    expect(items.find((i) => i.link === '/barrios')?.label).toBe('Barrios');
  });

  it('el manager de una organización ve Administrar con Contratos solamente', () => {
    expect(sectionLabels(flags({ isManager: true }))).toEqual(['Operar', 'Administrar']);
    expect(linksOf(flags({ isManager: true }), 'Administrar')).toEqual(['/contratos']);
  });

  it('CPS ve las cuatro secciones', () => {
    expect(sectionLabels(flags({ isCps: true, isManager: true }))).toEqual([
      'Operar',
      'Inventario',
      'Administrar',
      'Mi Empresa',
    ]);
  });

  it('Inventario es solo de CPS en esta fase', () => {
    expect(sectionLabels(flags({ isManager: true }))).not.toContain('Inventario');
    expect(linksOf(flags({ isCps: true, isManager: true }), 'Inventario')).toEqual([
      '/inventario/stock',
      '/inventario/fabrica',
      '/inventario/controles',
    ]);
  });

  it('Administrar de CPS suma Clientes y Usuarios', () => {
    expect(linksOf(flags({ isCps: true, isManager: true }), 'Administrar')).toEqual([
      '/clientes',
      '/contratos',
      '/usuarios',
    ]);
  });

  it('Mi Empresa es solo comercial', () => {
    expect(linksOf(flags({ isCps: true, isManager: true }), 'Mi Empresa')).toEqual([
      '/empresa/personal',
      '/empresa/planes',
    ]);
  });

  it('no devuelve secciones vacías', () => {
    for (const s of buildNav(flags({ isCps: true, isManager: true }))) {
      expect(s.items.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: FALLA con `Cannot find module './nav'`.

- [ ] **Step 3: Escribir el modelo**

Crear `frontend-angular/src/app/layout/shell/nav.ts`:

```ts
/**
 * El menú como DATO, no como HTML.
 *
 * La navegación se arma con el par (tipo de cuenta, rol), NUNCA con el rol
 * suelto: ADMIN en COMPANY es el admin de CPS, ADMIN en una ORGANIZATION es el
 * gestor de un municipio.
 *
 * Esconder un link NO es la protección — el backend ya rechaza con 403. Es para
 * no ofrecer puertas que dan a un error o a una pantalla vacía.
 *
 * El corte de las secciones es por FRECUENCIA DE USO, no por quién lo hace:
 *   Operar       el día a día, recortado por alcance
 *   Inventario   equipos que todavía no están en servicio
 *   Administrar  lo comercial, de vez en cuando
 *   Mi Empresa   el negocio de CPS
 */

export interface NavItem {
  label: string;
  link: string;
  icon: string;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export interface NavFlags {
  isCps: boolean;
  isManager: boolean;
  isCommunityOrg: boolean;
}

export function buildNav(flags: NavFlags): NavSection[] {
  const sections: NavSection[] = [
    {
      label: 'Operar',
      items: [
        { label: 'Inicio', link: '/', icon: 'bi-speedometer2' },
        { label: 'Eventos', link: '/eventos', icon: 'bi-bell' },
        {
          // Una organización COMMUNITY gestiona UN solo barrio (lo fuerza el
          // negocio): el plural quedaría mal.
          label: flags.isCommunityOrg ? 'Barrio' : 'Barrios',
          link: '/barrios',
          icon: 'bi-houses',
        },
        { label: 'Viviendas', link: '/viviendas', icon: 'bi-house-door' },
        { label: 'Alarmas', link: '/alarmas', icon: 'bi-broadcast' },
        { label: 'Controles', link: '/controles', icon: 'bi-key' },
      ],
    },
    {
      // Fase 1: sigue siendo solo-CPS. Que la organización vea SU stock es
      // Fase 4, junto con la revisión de alcance en el backend.
      label: 'Inventario',
      items: flags.isCps
        ? [
            { label: 'Alarmas', link: '/inventario/stock', icon: 'bi-box-seam' },
            { label: 'Fábrica', link: '/inventario/fabrica', icon: 'bi-cpu' },
            { label: 'Controles', link: '/inventario/controles', icon: 'bi-key-fill' },
          ]
        : [],
    },
    {
      label: 'Administrar',
      items: [
        ...(flags.isCps ? [{ label: 'Clientes', link: '/clientes', icon: 'bi-briefcase' }] : []),
        ...(flags.isManager
          ? [{ label: 'Contratos', link: '/contratos', icon: 'bi-file-earmark-text' }]
          : []),
        ...(flags.isCps ? [{ label: 'Usuarios', link: '/usuarios', icon: 'bi-people' }] : []),
      ],
    },
    {
      label: 'Mi Empresa',
      items: flags.isCps
        ? [
            { label: 'Personal', link: '/empresa/personal', icon: 'bi-person-badge' },
            { label: 'Planes', link: '/empresa/planes', icon: 'bi-tags' },
          ]
        : [],
    },
  ];

  return sections.filter((s) => s.items.length > 0);
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: PASA, 10 tests de `buildNav`.

- [ ] **Step 5: Verificar tipos y build**

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build
```

Esperado: sin errores.

- [ ] **Step 6: Commit**

```bash
git add frontend-angular/src/app/layout/shell/nav.ts frontend-angular/src/app/layout/shell/nav.spec.ts
git commit -m "Modelo de navegación: el menú como dato testeable"
```

---

### Task 2: El shell consume el modelo

**Files:**
- Modify: `frontend-angular/src/app/layout/shell/shell.ts`
- Modify: `frontend-angular/src/app/layout/shell/shell.html`

**Interfaces:**
- Consumes: `buildNav`, `NavSection` de `./nav` (Task 1).
- Produces: `protected readonly sections: Signal<NavSection[]>` en `Shell`.

- [ ] **Step 1: Reescribir `shell.ts`**

Reemplazar el contenido de `frontend-angular/src/app/layout/shell/shell.ts`:

```ts
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthService } from '../../core/auth/auth.service';
import { buildNav } from './nav';

const SIDEBAR_COLLAPSED_KEY = 'cps.sidebarCollapsed';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  protected readonly auth = inject(AuthService);

  /** El menú sale del modelo, no del template: así se puede testear solo. */
  protected readonly sections = computed(() =>
    buildNav({
      isCps: this.auth.isCps(),
      isManager: this.auth.isManager(),
      isCommunityOrg: this.auth.isCommunityOrg(),
    }),
  );

  protected readonly collapsed = signal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');

  protected toggleSidebar(): void {
    this.collapsed.update((v) => !v);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, this.collapsed() ? '1' : '0');
  }

  protected logout(): void {
    this.auth.logout().subscribe();
  }
}
```

- [ ] **Step 2: Reescribir `shell.html`**

Reemplazar el contenido de `frontend-angular/src/app/layout/shell/shell.html`:

```html
<!-- Layout del Operador — docs/angular-ui-styles-spec.md §5 -->
<div class="d-flex" style="min-height: 100vh">
  <!--
    El menú se arma en nav.ts, no acá. Esconder un link NO es la protección:
    el backend ya rechaza con 403. Es para no ofrecer puertas a un error.
  -->
  <aside
    class="bg-light border-end d-none d-md-block sidebar"
    [class.sidebar-collapsed]="collapsed()"
  >
    <div class="sidebar-heading border-bottom px-2 py-3 d-flex align-items-center">
      <span class="sidebar-brand d-flex align-items-center">
        <img src="logo.png" alt="CPS Security" class="sidebar-logo me-2" />
        <span class="fw-bold sidebar-brand-text">CPS Security</span>
      </span>

      <button
        type="button"
        class="btn btn-sm btn-outline-secondary sidebar-toggle ms-auto"
        (click)="toggleSidebar()"
        [title]="collapsed() ? 'Expandir menú' : 'Contraer menú'"
      >
        <i
          class="bi"
          [class.bi-chevron-left]="!collapsed()"
          [class.bi-chevron-right]="collapsed()"
        ></i>
      </button>
    </div>

    <div class="list-group list-group-flush p-2">
      @for (section of sections(); track section.label; let first = $first) {
        @if (!first) {
          <hr class="my-2" />
        }
        <!--
          Con una sola sección visible (el vecino) el título no separa nada:
          es ruido. Recién aparece cuando hay más de una.
        -->
        @if (sections().length > 1) {
          <span
            class="text-muted small px-3 pt-2 text-uppercase fw-semibold sidebar-section-label"
            style="font-size: 0.7rem"
          >
            {{ section.label }}
          </span>
        }

        @for (item of section.items; track item.link) {
          <a
            class="list-group-item list-group-item-action border-0 rounded text-dark"
            [routerLink]="item.link"
            routerLinkActive="active-link"
            [routerLinkActiveOptions]="{ exact: item.link === '/' }"
            [title]="item.label"
          >
            <i class="bi me-2" [class]="item.icon"></i> <span>{{ item.label }}</span>
          </a>
        }
      }
    </div>
  </aside>

  <!-- Contenedor principal -->
  <div class="flex-grow-1 bg-white">
    <nav class="navbar navbar-expand-lg navbar-light bg-white border-bottom py-3">
      <div class="container-fluid">
        <span class="navbar-brand fw-semibold text-brand mb-0 h1">CPS Security</span>

        <div class="ms-auto d-flex align-items-center">
          <a routerLink="/perfil" class="me-3 text-muted small text-decoration-none">
            <i class="bi bi-person-circle me-1"></i>
            <span class="d-none d-sm-inline-block">{{ auth.displayName() }}</span>
          </a>
          <button
            type="button"
            class="btn btn-sm btn-outline-danger"
            (click)="logout()"
            title="Cerrar sesión"
          >
            <i class="bi bi-box-arrow-right"></i>
          </button>
        </div>
      </div>
    </nav>

    <main class="container-fluid p-4">
      <router-outlet />
    </main>
  </div>
</div>
```

- [ ] **Step 3: Verificar que compila y los tests siguen pasando**

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build && npm test -- --watch=false
```

Esperado: sin errores, tests en verde.

- [ ] **Step 4: Commit**

```bash
git add frontend-angular/src/app/layout/shell/shell.ts frontend-angular/src/app/layout/shell/shell.html
git commit -m "Shell: menú desde el modelo y marca unificada"
```

---

### Task 3: Rutas de Inventario y redirects

**Files:**
- Modify: `frontend-angular/src/app/app.routes.ts:146-172`
- Test: `frontend-angular/src/app/app.routes.spec.ts`

**Interfaces:**
- Consumes: `routes` de `./app.routes`.
- Produces: rutas `/inventario/stock`, `/inventario/fabrica`, `/inventario/controles` y los redirects listados abajo.

**Tabla de redirects** (todos los links viejos siguen andando):

| Link viejo | Va a | Por qué |
|---|---|---|
| `/inventario/alarmas` | `/inventario/fabrica` | hoy es la fábrica: se preserva el significado |
| `/inventario/alarmas/fabricar` | `/inventario/fabrica` | ya existía como redirect |
| `/alarmas/stock` | `/inventario/stock` | el stock se muda a Inventario |
| `/alarmas/nueva` | `/inventario/fabrica` | hoy apunta a la fábrica |
| `/controles/nuevo` | `/inventario/controles` | ya existía |

- [ ] **Step 1: Escribir el test que falla**

Crear `frontend-angular/src/app/app.routes.spec.ts`:

```ts
import { Routes } from '@angular/router';

import { routes } from './app.routes';

/** Las rutas privadas cuelgan del shell (el único hijo de la ruta ''). */
const shellChildren = (): Routes => {
  const shell = routes.find((r) => r.path === '' && r.children);
  return shell?.children ?? [];
};

const find = (path: string) => shellChildren().find((r) => r.path === path);

const inventarioChildren = (): Routes => find('inventario')?.children ?? [];

describe('rutas', () => {
  it('Inventario tiene stock, fábrica y controles', () => {
    const paths = inventarioChildren().map((r) => r.path);
    expect(paths).toContain('stock');
    expect(paths).toContain('fabrica');
    expect(paths).toContain('controles');
  });

  it('Inventario entra por stock', () => {
    const index = inventarioChildren().find((r) => r.path === '');
    expect(index?.redirectTo).toBe('stock');
  });

  it('el link viejo de la fábrica sigue llevando a la fábrica', () => {
    expect(inventarioChildren().find((r) => r.path === 'alarmas')?.redirectTo).toBe('fabrica');
    expect(inventarioChildren().find((r) => r.path === 'alarmas/fabricar')?.redirectTo).toBe(
      'fabrica',
    );
  });

  it('el stock viejo redirige a Inventario', () => {
    expect(find('alarmas/stock')?.redirectTo).toBe('/inventario/stock');
  });

  it('el alta vieja de alarmas lleva a la fábrica', () => {
    expect(find('alarmas/nueva')?.redirectTo).toBe('/inventario/fabrica');
  });

  it('el alta vieja de controles lleva a Inventario', () => {
    expect(find('controles/nuevo')?.redirectTo).toBe('/inventario/controles');
  });

  it('las rutas de Operar no se movieron', () => {
    for (const p of ['eventos', 'barrios', 'viviendas', 'alarmas', 'controles']) {
      expect(find(p)).withContext(p).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: FALLA — no existen `stock` ni `fabrica` dentro de `inventario`.

- [ ] **Step 3: Reemplazar el bloque de Inventario en `app.routes.ts`**

En `frontend-angular/src/app/app.routes.ts`, reemplazar el bloque que va desde el comentario `// INVENTARIO — la FÁBRICA:` hasta la línea `{ path: 'controles/nuevo', redirectTo: 'inventario/controles' },` (líneas 135-172) por:

```ts
      // ---------------------------------------------------------------------
      // INVENTARIO — los equipos que TODAVÍA NO están en servicio.
      //
      // El corte con /alarmas es el CHECK de la base: INVENTORY <=> sin barrio.
      // Operar/Alarmas son las que tienen barrio; Inventario, las que no.
      //
      // Fase 1: sigue siendo cpsGuard. Que una organización vea SU stock es
      // Fase 4, y ahí hay que revisar alcance en el backend (permisos-check).
      // ---------------------------------------------------------------------
      {
        path: 'inventario',
        canActivate: [cpsGuard],
        loadComponent: () =>
          import('./features/inventory/inventory-shell').then((m) => m.InventoryShell),
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'stock' },
          {
            // El stock: equipos entregados y por entregar. Provisorio — la
            // ENTREGA de lotes se separa a /inventario/entregas en la Fase 4,
            // y la instalación por reclamo se muda al detalle del barrio.
            path: 'stock',
            loadComponent: () =>
              import('./features/devices/device-inventory').then((m) => m.DeviceInventory),
          },
          {
            // Alta desde MAC + n° de placa, y el registro de todo lo fabricado.
            // Alta y listado en la MISMA pantalla: la estación de flasheo carga
            // placas en tanda y navegar por equipo sería fricción pura.
            path: 'fabrica',
            loadComponent: () =>
              import('./features/devices/device-factory').then((m) => m.DeviceFactory),
          },
          {
            // Provisorio: el único acto de fábrica que hoy existe para
            // controles es el alta. La pantalla propia —con su listado, al
            // molde de la de alarmas— es la Fase 4.
            path: 'controles',
            loadComponent: () => import('./features/remotes/remote-form').then((m) => m.RemoteForm),
          },
          // Los links viejos siguen andando: alguien los tiene en un favorito.
          { path: 'alarmas', pathMatch: 'full', redirectTo: 'fabrica' },
          { path: 'alarmas/fabricar', redirectTo: 'fabrica' },
        ],
      },

      { path: 'controles/nuevo', redirectTo: 'inventario/controles' },
```

- [ ] **Step 4: Mover los redirects viejos de `/alarmas`**

En el mismo archivo, dentro del bloque de alarmas, reemplazar:

```ts
      {
        // Entrega del lote a una organización + instalación por reclamo. NO es
        // fábrica: acá sí importa el destino, y por eso no vive en Inventario.
        // Provisorio — cada mitad se va a mudar a donde pertenece: la entrega
        // al detalle de la cuenta, la instalación al detalle del barrio.
        path: 'alarmas/stock',
        canActivate: [managerGuard],
        loadComponent: () =>
          import('./features/devices/device-inventory').then((m) => m.DeviceInventory),
      },
      // Va ANTES de :id o el router se come "nueva" como si fuera un id.
      // Mismo motivo por el que 'barrios/nuevo' precede a ':id'.
      { path: 'alarmas/nueva', redirectTo: 'inventario/alarmas' },
```

por:

```ts
      // El stock se mudó a Inventario. Van ANTES de ':id' o el router se come
      // "stock" y "nueva" como si fueran un id — mismo motivo por el que
      // 'barrios/nuevo' precede a ':id'.
      { path: 'alarmas/stock', pathMatch: 'full', redirectTo: '/inventario/stock' },
      { path: 'alarmas/nueva', redirectTo: '/inventario/fabrica' },
```

- [ ] **Step 5: Sacar el import que quedó sin uso**

`managerGuard` deja de usarse en las rutas de alarmas. Verificar si sigue usándose en `viviendas/nueva`:

```bash
cd frontend-angular
grep -n "managerGuard" src/app/app.routes.ts
```

Si aparece solo en el `import`, sacarlo de la lista de imports en `src/app/app.routes.ts:3-9`. Si aparece en alguna ruta, dejarlo.

- [ ] **Step 6: Correr el test y verificar que pasa**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: PASA, 7 tests de rutas.

- [ ] **Step 7: Verificar tipos y build**

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build
```

Esperado: sin errores.

- [ ] **Step 8: Commit**

```bash
git add frontend-angular/src/app/app.routes.ts frontend-angular/src/app/app.routes.spec.ts
git commit -m "Rutas: Inventario con stock y fábrica, redirects de los links viejos"
```

---

### Task 4: Verificación en el navegador

**Files:** ninguno (verificación).

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: evidencia de que anda.

- [ ] **Step 1: Verificación completa del frontend**

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build && npm test -- --watch=false
```

Esperado: build sin errores, todos los tests en verde. **Pegar la salida real.**

- [ ] **Step 2: Levantar backend y frontend**

```bash
cd backend-nestjs && npm run start:dev
```

En otra terminal:

```bash
cd frontend-angular && npx ng serve
```

- [ ] **Step 3: Probar con un usuario de CPS**

Credenciales en `docs/estado-proyecto.md` §3.1.

Verificar en el navegador:
- El sidebar muestra **cuatro** secciones: Operar, Inventario, Administrar, Mi Empresa.
- Ambas marcas dicen "CPS Security".
- `/inventario/stock` abre el stock; `/inventario/fabrica` abre la fábrica.
- `/inventario/alarmas` **redirige** a `/inventario/fabrica`.
- `/alarmas/stock` **redirige** a `/inventario/stock`.
- `/alarmas/nueva` **redirige** a `/inventario/fabrica`.
- `/cuentas` sigue redirigiendo a `/clientes` (no se tocó).
- El item activo se resalta bien, y "Inicio" solo se resalta en `/`.

- [ ] **Step 4: Probar con un usuario de organización**

Verificar:
- Ve **dos** secciones: Operar y Administrar.
- Administrar tiene **solo** Contratos.
- **No** ve Inventario ni Mi Empresa.
- Si la organización es COMMUNITY, el item dice "Barrio" en singular.

- [ ] **Step 5: Commit de cierre (si hubo ajustes)**

```bash
git add -A
git commit -m "Fase 1 verificada en el navegador"
```

---

## Qué NO se hace en esta fase

- No se toca el interior de ninguna pantalla.
- No se crea Inventario/Entregas (es la partición de `/alarmas/stock`, Fase 4).
- No cambian los guards ni el alcance de Inventario (Fase 4).
- No se toca `device_status` ni `INSTALLED` (Fase 3).
- No se define paleta ni identidad visual (Fase 6).
