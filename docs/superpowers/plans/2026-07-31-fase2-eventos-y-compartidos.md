# Fase 2 — Eventos y la capa compartida: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rediseñar la pantalla de Eventos y extraer, de ese trabajo, los cinco componentes compartidos que van a usar las 27 pantallas restantes.

**Architecture:** Cada componente se escribe **primero con su test**, aislado, antes de tocar Eventos. Recién en la anteúltima tarea Eventos los consume. Así cada componente se valida solo y el diff de Eventos queda limpio.

**Tech Stack:** Angular 21 (standalone, signals, content projection), Bootstrap 5, Bootstrap Icons, Vitest + TestBed.

## Global Constraints

- Idioma: **español rioplatense (voseo)** en labels, comentarios y mensajes.
- **Vitest, no Jasmine.** `withContext()` no existe — si hace falta contexto en una assertion, compará listas completas.
- Prefijo `cps-` en todos los selectores.
- Los componentes van en `src/app/shared/ui/<nombre>/`. Template **inline**: son todos de menos de 50 líneas.
- Ningún componente conoce el dominio salvo `cps-status`, que centraliza el mapeo estado → etiqueta + color.
- No se define paleta: se reusan las clases que ya existen (`bg-brand-soft`, `text-brand`, `bg-success-soft`, `bg-warning-soft`).
- Verificación por tarea: `npx tsc --noEmit && npx ng build && npm test -- --watch=false` desde `frontend-angular/`.

## Desvíos respecto del spec

1. El spec lo llamaba `cps-page`. Se renombra a **`cps-page-header`**: es el encabezado, no un contenedor de página, y el nombre viejo hacía pensar lo contrario.
2. **`cps-table` NO se extrae.** El spec lo dejó condicional a tener dos casos reales. Con el caso de Eventos a la vista alcanza para decidir que no: la tabla tiene ocho columnas propias, filas expandibles y una celda de acciones que cambia según `canResolve()`. Una tabla genérica que soporte eso termina siendo más compleja que las once tablas honestas que reemplaza. Se revisa en la Fase 5 si aparece evidencia nueva.

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `src/app/shared/ui/alert/alert.ts` | **Crear.** `cps-alert`: 4 variantes semánticas. |
| `src/app/shared/ui/alert/alert.spec.ts` | **Crear.** |
| `src/app/shared/ui/page-header/page-header.ts` | **Crear.** `cps-page-header`: título, subtítulo, acciones. |
| `src/app/shared/ui/page-header/page-header.spec.ts` | **Crear.** |
| `src/app/shared/ui/async/async.ts` | **Crear.** `cps-async`: carga / vacío / contenido. |
| `src/app/shared/ui/async/async.spec.ts` | **Crear.** |
| `src/app/shared/ui/status/status-map.ts` | **Crear.** El mapeo estado → etiqueta + tono, en UN lugar. |
| `src/app/shared/ui/status/status.ts` | **Crear.** `cps-status`: lo renderiza. |
| `src/app/shared/ui/status/status.spec.ts` | **Crear.** |
| `src/app/shared/ui/paginator/paginator.ts` | **Crear.** `cps-paginator`. |
| `src/app/shared/ui/paginator/paginator.spec.ts` | **Crear.** |
| `src/app/features/events/event-list.html` | **Modificar.** Consume los cinco. |
| `src/app/features/events/event-list.ts` | **Modificar.** Solo los `imports` del componente. |

---

### Task 1: cps-alert

**Files:**
- Create: `frontend-angular/src/app/shared/ui/alert/alert.ts`
- Test: `frontend-angular/src/app/shared/ui/alert/alert.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `export type AlertVariant = 'error' | 'warning' | 'success' | 'info';` y `export class Alert` con selector `cps-alert`, inputs `variant: AlertVariant` (default `'info'`) y `dense: boolean` (default `false`). El contenido va por proyección.

- [ ] **Step 1: Escribir el test que falla**

Crear `frontend-angular/src/app/shared/ui/alert/alert.spec.ts`:

```ts
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Alert, AlertVariant } from './alert';

@Component({
  imports: [Alert],
  template: `<cps-alert [variant]="variant" [dense]="dense">Algo pasó</cps-alert>`,
})
class Host {
  variant: AlertVariant = 'info';
  dense = false;
}

const render = (variant: AlertVariant, dense = false) => {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.variant = variant;
  fixture.componentInstance.dense = dense;
  fixture.detectChanges();
  return fixture.nativeElement.querySelector('.alert') as HTMLElement;
};

describe('cps-alert', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
  });

  it('proyecta el contenido', () => {
    expect(render('info').textContent).toContain('Algo pasó');
  });

  it('el error usa el tono de marca', () => {
    const el = render('error');
    expect(el.className).toContain('bg-brand-soft');
    expect(el.className).toContain('text-brand');
  });

  it('cada variante tiene su tono', () => {
    expect(render('warning').className).toContain('bg-warning-soft');
    expect(render('success').className).toContain('bg-success-soft');
    expect(render('info').className).toContain('bg-light');
  });

  it('cada variante tiene su ícono', () => {
    const icon = (v: AlertVariant) =>
      (render(v).querySelector('i') as HTMLElement).className;
    expect(icon('error')).toContain('bi-exclamation-triangle-fill');
    expect(icon('warning')).toContain('bi-exclamation-circle');
    expect(icon('success')).toContain('bi-check-circle');
    expect(icon('info')).toContain('bi-info-circle');
  });

  it('dense achica el bloque', () => {
    expect(render('info', true).className).toContain('py-2');
    expect(render('info', true).className).toContain('small');
    expect(render('info', false).className).not.toContain('py-2');
  });

  it('tiene rol de alerta para lectores de pantalla', () => {
    expect(render('error').getAttribute('role')).toBe('alert');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: FALLA con `Could not resolve "./alert"`.

- [ ] **Step 3: Escribir el componente**

Crear `frontend-angular/src/app/shared/ui/alert/alert.ts`:

```ts
import { Component, computed, input } from '@angular/core';

export type AlertVariant = 'error' | 'warning' | 'success' | 'info';

/** Tono e ícono de cada variante, en UN lugar. Antes había 8 combinaciones
 *  de clase distintas para decir estas 4 cosas. */
const TONE: Record<AlertVariant, { classes: string; icon: string }> = {
  error: { classes: 'bg-brand-soft text-brand', icon: 'bi-exclamation-triangle-fill' },
  warning: { classes: 'bg-warning-soft', icon: 'bi-exclamation-circle' },
  success: { classes: 'bg-success-soft text-success', icon: 'bi-check-circle' },
  info: { classes: 'bg-light text-muted', icon: 'bi-info-circle' },
};

@Component({
  selector: 'cps-alert',
  template: `
    <div class="alert border-0 {{ tone().classes }}" [class.py-2]="dense()"
         [class.small]="dense()" role="alert">
      <i class="bi me-1" [class]="tone().icon"></i><ng-content />
    </div>
  `,
})
export class Alert {
  readonly variant = input<AlertVariant>('info');
  /** Compacto: para avisos al pie de un formulario, no para el error de la pantalla. */
  readonly dense = input(false);

  protected readonly tone = computed(() => TONE[this.variant()]);
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: PASA, 6 tests de `cps-alert`.

- [ ] **Step 5: Verificar tipos y build**

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build
```

Esperado: sin errores.

---

### Task 2: cps-page-header

**Files:**
- Create: `frontend-angular/src/app/shared/ui/page-header/page-header.ts`
- Test: `frontend-angular/src/app/shared/ui/page-header/page-header.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `export class PageHeader` con selector `cps-page-header`, inputs `title: string` (requerido), `subtitle: string` (default `''`), `icon: string` (default `''`). Las acciones se proyectan con `<ng-content select="[actions]" />`.

- [ ] **Step 1: Escribir el test que falla**

Crear `frontend-angular/src/app/shared/ui/page-header/page-header.spec.ts`:

```ts
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { PageHeader } from './page-header';

@Component({
  imports: [PageHeader],
  template: `
    <cps-page-header [title]="title" [subtitle]="subtitle" [icon]="icon">
      <button actions type="button">Registrar evento</button>
    </cps-page-header>
  `,
})
class Host {
  title = 'Eventos';
  subtitle = 'El tablero del monitoreo';
  icon = 'bi-bell-fill';
}

const render = () => {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
};

describe('cps-page-header', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
  });

  it('muestra el título como encabezado', () => {
    const h = render().querySelector('h2') as HTMLElement;
    expect(h.textContent).toContain('Eventos');
  });

  it('muestra el subtítulo', () => {
    expect(render().textContent).toContain('El tablero del monitoreo');
  });

  it('muestra el ícono cuando hay uno', () => {
    expect((render().querySelector('h2 i') as HTMLElement).className).toContain('bi-bell-fill');
  });

  it('proyecta las acciones', () => {
    expect(render().querySelector('button[actions]')?.textContent).toContain('Registrar evento');
  });

  it('sin subtítulo no deja el párrafo vacío', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.subtitle = '';
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('p')).toBeNull();
  });

  it('sin ícono no deja el <i> vacío', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.icon = '';
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('h2 i')).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: FALLA con `Could not resolve "./page-header"`.

- [ ] **Step 3: Escribir el componente**

Crear `frontend-angular/src/app/shared/ui/page-header/page-header.ts`:

```ts
import { Component, input } from '@angular/core';

/** El encabezado de una pantalla: título, bajada y acciones a la derecha.
 *  Las 28 pantallas lo venían armando a mano, cada una con su espaciado. */
@Component({
  selector: 'cps-page-header',
  template: `
    <div class="d-flex align-items-center justify-content-between mb-3">
      <div>
        <h2 class="h5 fw-bold mb-0">
          @if (icon()) {
            <i class="bi text-brand me-2" [class]="icon()"></i>
          }{{ title() }}
        </h2>
        @if (subtitle()) {
          <p class="text-muted small mb-0">{{ subtitle() }}</p>
        }
      </div>
      <ng-content select="[actions]" />
    </div>
  `,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input('');
  readonly icon = input('');
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: PASA, 6 tests de `cps-page-header`.

- [ ] **Step 5: Verificar tipos y build**

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build
```

---

### Task 3: cps-async

**Files:**
- Create: `frontend-angular/src/app/shared/ui/async/async.ts`
- Test: `frontend-angular/src/app/shared/ui/async/async.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `export class Async` con selector `cps-async`, inputs `loading: boolean`, `empty: boolean`, `loadingText: string` (default `'Cargando…'`), `emptyText: string` (default `'No hay nada para mostrar.'`), `emptyIcon: string` (default `'bi-inbox'`). El contenido se proyecta **solo** cuando no está cargando ni vacío.

- [ ] **Step 1: Escribir el test que falla**

Crear `frontend-angular/src/app/shared/ui/async/async.spec.ts`:

```ts
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Async } from './async';

@Component({
  imports: [Async],
  template: `
    <cps-async
      [loading]="loading"
      [empty]="empty"
      loadingText="Cargando eventos…"
      emptyText="No hay eventos para mostrar."
      emptyIcon="bi-bell-slash"
    >
      <table id="contenido"></table>
    </cps-async>
  `,
})
class Host {
  loading = false;
  empty = false;
}

const render = (loading: boolean, empty: boolean) => {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.loading = loading;
  fixture.componentInstance.empty = empty;
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
};

describe('cps-async', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
  });

  it('cargando: muestra el spinner y su texto, y NO el contenido', () => {
    const el = render(true, false);
    expect(el.querySelector('.spinner-border')).not.toBeNull();
    expect(el.textContent).toContain('Cargando eventos…');
    expect(el.querySelector('#contenido')).toBeNull();
  });

  it('vacío: muestra el texto y el ícono, y NO el contenido', () => {
    const el = render(false, true);
    expect(el.textContent).toContain('No hay eventos para mostrar.');
    expect((el.querySelector('.text-center i') as HTMLElement).className).toContain(
      'bi-bell-slash',
    );
    expect(el.querySelector('#contenido')).toBeNull();
  });

  it('con datos: muestra el contenido y nada más', () => {
    const el = render(false, false);
    expect(el.querySelector('#contenido')).not.toBeNull();
    expect(el.querySelector('.spinner-border')).toBeNull();
    expect(el.textContent).not.toContain('No hay eventos');
  });

  it('cargando gana sobre vacío: una lista vacía mientras carga no es "no hay nada"', () => {
    const el = render(true, true);
    expect(el.querySelector('.spinner-border')).not.toBeNull();
    expect(el.textContent).not.toContain('No hay eventos');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: FALLA con `Could not resolve "./async"`.

- [ ] **Step 3: Escribir el componente**

Crear `frontend-angular/src/app/shared/ui/async/async.ts`:

```ts
import { Component, input } from '@angular/core';

/** Los tres estados de una pantalla que trae datos: cargando, vacío, con datos.
 *  Estaban copiados a mano en 26 y 21 archivos respectivamente.
 *
 *  CARGANDO GANA SOBRE VACÍO a propósito: mientras carga, la lista está vacía
 *  y decir "no hay nada" sería mentir por un instante en cada request. */
@Component({
  selector: 'cps-async',
  template: `
    @if (loading()) {
      <div class="text-center text-muted py-5">
        <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
        {{ loadingText() }}
      </div>
    } @else if (empty()) {
      <div class="text-center text-muted py-5 bg-light rounded">
        <i class="bi d-block mb-2" [class]="emptyIcon()" style="font-size: 2rem"></i>
        {{ emptyText() }}
      </div>
    } @else {
      <ng-content />
    }
  `,
})
export class Async {
  readonly loading = input(false);
  readonly empty = input(false);
  readonly loadingText = input('Cargando…');
  readonly emptyText = input('No hay nada para mostrar.');
  readonly emptyIcon = input('bi-inbox');
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: PASA, 4 tests de `cps-async`.

- [ ] **Step 5: Verificar tipos y build**

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build
```

---

### Task 4: cps-status

**Files:**
- Create: `frontend-angular/src/app/shared/ui/status/status-map.ts`
- Create: `frontend-angular/src/app/shared/ui/status/status.ts`
- Test: `frontend-angular/src/app/shared/ui/status/status.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `export interface StatusLook { label: string; classes: string; icon?: string; }`
  - `export const STATUS_MAP: { event: Record<string, StatusLook> }`
  - `export function lookOf(kind: 'event', value: string): StatusLook`
  - `export class Status` con selector `cps-status`, inputs `kind: 'event'` y `value: string`.

Se implementa **solo** `event`, que es lo que esta fase usa. `device`, `contract` y `entity` se suman cuando sus pantallas les toquen (Fases 3 y 5), en este mismo archivo.

- [ ] **Step 1: Escribir el test que falla**

Crear `frontend-angular/src/app/shared/ui/status/status.spec.ts`:

```ts
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Status } from './status';
import { lookOf } from './status-map';

@Component({
  imports: [Status],
  template: `<cps-status kind="event" [value]="value" />`,
})
class Host {
  value = 'OPEN';
}

const render = (value: string) => {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.value = value;
  fixture.detectChanges();
  return fixture.nativeElement.querySelector('.badge') as HTMLElement;
};

describe('lookOf', () => {
  it('traduce los tres estados de un evento', () => {
    expect(lookOf('event', 'OPEN').label).toBe('Abierto');
    expect(lookOf('event', 'RESOLVED').label).toBe('Resuelto');
    expect(lookOf('event', 'FALSE_ALARM').label).toBe('Falsa alarma');
  });

  it('un valor desconocido se muestra tal cual en vez de romper', () => {
    expect(lookOf('event', 'LO_QUE_SEA').label).toBe('LO_QUE_SEA');
  });
});

describe('cps-status', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
  });

  it('renderiza la etiqueta traducida', () => {
    expect(render('OPEN').textContent).toContain('Abierto');
  });

  it('el abierto usa el tono de marca', () => {
    expect(render('OPEN').className).toContain('bg-brand-soft');
  });

  it('el resuelto usa el tono de éxito', () => {
    expect(render('RESOLVED').className).toContain('bg-success-soft');
  });

  it('la falsa alarma queda apagada', () => {
    expect(render('FALSE_ALARM').className).toContain('text-muted');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: FALLA con `Could not resolve "./status"`.

- [ ] **Step 3: Escribir el mapeo**

Crear `frontend-angular/src/app/shared/ui/status/status-map.ts`:

```ts
/**
 * Estado del dominio -> cómo se ve. En UN solo lugar.
 *
 * Antes este mapeo estaba repetido en 17 archivos: cambiar el color de
 * "Resuelto" era buscarlo en todos. Y peor: dos pantallas podían mostrar el
 * mismo estado de dos colores distintos sin que nadie lo notara.
 */

export interface StatusLook {
  label: string;
  classes: string;
  icon?: string;
}

export type StatusKind = 'event';

export const STATUS_MAP: Record<StatusKind, Record<string, StatusLook>> = {
  event: {
    OPEN: { label: 'Abierto', classes: 'bg-brand-soft text-brand border', icon: 'bi-broadcast' },
    RESOLVED: { label: 'Resuelto', classes: 'bg-success-soft text-success border' },
    FALSE_ALARM: { label: 'Falsa alarma', classes: 'bg-light text-muted border' },
  },
};

/** Un valor que no está en el mapa se muestra crudo: preferimos ver
 *  'LO_QUE_SEA' en pantalla antes que romper el listado entero. */
export function lookOf(kind: StatusKind, value: string): StatusLook {
  return STATUS_MAP[kind][value] ?? { label: value, classes: 'bg-light text-muted border' };
}
```

- [ ] **Step 4: Escribir el componente**

Crear `frontend-angular/src/app/shared/ui/status/status.ts`:

```ts
import { Component, computed, input } from '@angular/core';

import { lookOf, StatusKind } from './status-map';

@Component({
  selector: 'cps-status',
  template: `
    <span class="badge {{ look().classes }}">
      @if (look().icon) {
        <i class="bi me-1" [class]="look().icon"></i>
      }{{ look().label }}
    </span>
  `,
})
export class Status {
  readonly kind = input.required<StatusKind>();
  readonly value = input.required<string>();

  protected readonly look = computed(() => lookOf(this.kind(), this.value()));
}
```

- [ ] **Step 5: Correr el test y verificar que pasa**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: PASA, 6 tests entre `lookOf` y `cps-status`.

- [ ] **Step 6: Verificar tipos y build**

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build
```

---

### Task 5: cps-paginator

**Files:**
- Create: `frontend-angular/src/app/shared/ui/paginator/paginator.ts`
- Test: `frontend-angular/src/app/shared/ui/paginator/paginator.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `export class Paginator` con selector `cps-paginator`, inputs `offset: number`, `count: number`, `total: number`, `disabled: boolean`; outputs `prev` y `next` (ambos `output<void>()`).

- [ ] **Step 1: Escribir el test que falla**

Crear `frontend-angular/src/app/shared/ui/paginator/paginator.spec.ts`:

```ts
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Paginator } from './paginator';

@Component({
  imports: [Paginator],
  template: `
    <cps-paginator
      [offset]="offset"
      [count]="count"
      [total]="total"
      [disabled]="disabled"
      (prev)="movimientos.push('prev')"
      (next)="movimientos.push('next')"
    />
  `,
})
class Host {
  offset = 0;
  count = 20;
  total = 45;
  disabled = false;
  movimientos: string[] = [];
}

const setup = (over: Partial<Host> = {}) => {
  const fixture = TestBed.createComponent(Host);
  Object.assign(fixture.componentInstance, over);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const [prev, next] = Array.from(el.querySelectorAll('button')) as HTMLButtonElement[];
  return { fixture, el, prev, next, host: fixture.componentInstance };
};

describe('cps-paginator', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
  });

  it('dice qué tramo se está viendo, en base 1', () => {
    expect(setup().el.textContent).toContain('1–20 de 45');
  });

  it('en la segunda página el tramo se corre', () => {
    expect(setup({ offset: 20 }).el.textContent).toContain('21–40 de 45');
  });

  it('en la primera página no se puede retroceder', () => {
    expect(setup().prev.disabled).toBe(true);
  });

  it('en la última página no se puede avanzar', () => {
    expect(setup({ offset: 40, count: 5 }).next.disabled).toBe(true);
  });

  it('en el medio se puede para los dos lados', () => {
    const { prev, next } = setup({ offset: 20 });
    expect([prev.disabled, next.disabled]).toEqual([false, false]);
  });

  it('emite prev y next al hacer click', () => {
    const { prev, next, host } = setup({ offset: 20 });
    prev.click();
    next.click();
    expect(host.movimientos).toEqual(['prev', 'next']);
  });

  it('disabled bloquea los dos botones', () => {
    const { prev, next } = setup({ offset: 20, disabled: true });
    expect([prev.disabled, next.disabled]).toEqual([true, true]);
  });

  it('sin resultados no muestra un tramo mentiroso', () => {
    expect(setup({ count: 0, total: 0 }).el.textContent).toContain('0 de 0');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: FALLA con `Could not resolve "./paginator"`.

- [ ] **Step 3: Escribir el componente**

Crear `frontend-angular/src/app/shared/ui/paginator/paginator.ts`:

```ts
import { Component, computed, input, output } from '@angular/core';

/** Paginación por offset, la que usa toda la API. El componente NO pagina:
 *  informa y avisa. Quién carga los datos sigue siendo la pantalla. */
@Component({
  selector: 'cps-paginator',
  template: `
    <div class="d-flex align-items-center justify-content-between">
      <span class="text-muted small">{{ rango() }}</span>
      <div class="btn-group">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          [disabled]="!canPrev() || disabled()"
          (click)="prev.emit()"
        >
          <i class="bi bi-chevron-left"></i> Anteriores
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          [disabled]="!canNext() || disabled()"
          (click)="next.emit()"
        >
          Siguientes <i class="bi bi-chevron-right"></i>
        </button>
      </div>
    </div>
  `,
})
export class Paginator {
  /** Cuántos elementos se saltearon: el offset de la API. */
  readonly offset = input(0);
  /** Cuántos vinieron en ESTA página (no el tamaño de página). */
  readonly count = input(0);
  readonly total = input(0);
  readonly disabled = input(false);

  readonly prev = output<void>();
  readonly next = output<void>();

  protected readonly canPrev = computed(() => this.offset() > 0);
  protected readonly canNext = computed(() => this.offset() + this.count() < this.total());

  /** Base 1 para el humano. Sin resultados no se inventa un "1–0". */
  protected readonly rango = computed(() =>
    this.count() === 0
      ? `0 de ${this.total()}`
      : `${this.offset() + 1}–${this.offset() + this.count()} de ${this.total()}`,
  );
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

```bash
cd frontend-angular
npm test -- --watch=false
```

Esperado: PASA, 8 tests de `cps-paginator`.

- [ ] **Step 5: Verificar tipos y build**

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build
```

---

### Task 6: Eventos consume los cinco

**Files:**
- Modify: `frontend-angular/src/app/features/events/event-list.ts:1-25`
- Modify: `frontend-angular/src/app/features/events/event-list.html`

**Interfaces:**
- Consumes: `Alert`, `PageHeader`, `Async`, `Status`, `Paginator` de `shared/ui/*` (Tasks 1-5).
- Produces: nada nuevo. La lógica del componente **no cambia**: `canPrev()` y `canNext()` dejan de usarse en el template pero siguen existiendo para los tests futuros.

- [ ] **Step 1: Actualizar los imports de `event-list.ts`**

En `frontend-angular/src/app/features/events/event-list.ts`, reemplazar las líneas 1-25 (los imports y el decorador) por:

```ts
import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { EventsService } from '../../core/api/events.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { AlarmEvent, EventStatus } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';
import { Alert } from '../../shared/ui/alert/alert';
import { Async } from '../../shared/ui/async/async';
import { PageHeader } from '../../shared/ui/page-header/page-header';
import { Paginator } from '../../shared/ui/paginator/paginator';
import { Status } from '../../shared/ui/status/status';

const PAGE_SIZE = 20;

/**
 * El tablero del monitoreo (NUEVO en v2): la pantalla principal del MONITOR.
 *
 * Los eventos son append-only e ilimitados; la única mutación es la
 * RESOLUCIÓN (resuelto o falsa alarma), y la hace el monitoreo. El activador
 * es un snapshot congelado: se muestra tal cual quedó al momento del evento.
 */
@Component({
  selector: 'app-event-list',
  imports: [FormsModule, DatePipe, Alert, Async, PageHeader, Paginator, Status],
  templateUrl: './event-list.html',
})
```

- [ ] **Step 2: Reemplazar el encabezado en `event-list.html`**

Reemplazar las líneas 1-14 por:

```html
<cps-page-header
  title="Eventos"
  icon="bi-bell-fill"
  subtitle="El tablero del monitoreo: cada activación, quién la disparó y cómo terminó"
>
  @if (canResolve()) {
    <button
      actions
      type="button"
      class="btn btn-brand btn-sm"
      (click)="showCreate.set(!showCreate())"
    >
      <i class="bi bi-plus-lg me-1"></i> Registrar evento
    </button>
  }
</cps-page-header>
```

- [ ] **Step 3: Reemplazar el bloque de error**

Reemplazar el bloque `@if (error()) { … }` (líneas 86-90 del archivo original) por:

```html
@if (error()) {
  <cps-alert variant="error" [dense]="true">{{ error() }}</cps-alert>
}
```

- [ ] **Step 4: Envolver la tabla con `cps-async`**

Reemplazar la estructura `@if (loading()) { … } @else if (items().length === 0) { … } @else { … }` de modo que el `@else` pase a ser el contenido de `cps-async`. El bloque abre así:

```html
<cps-async
  [loading]="loading()"
  [empty]="items().length === 0"
  loadingText="Cargando eventos…"
  emptyText="No hay eventos para mostrar."
  emptyIcon="bi-bell-slash"
>
  <div class="table-responsive">
```

…y cierra, después del paginador, con `</cps-async>`. Los bloques de carga y de vacío que estaban escritos a mano se **borran**: los provee el componente.

- [ ] **Step 5: Reemplazar el badge de estado**

Reemplazar el `@switch (event.status) { … }` completo (líneas 136-150 del original) por:

```html
<cps-status kind="event" [value]="event.status" />
```

- [ ] **Step 6: Reemplazar el paginador**

Reemplazar el bloque final `<div class="d-flex align-items-center justify-content-between"> … </div>` (líneas 270-292 del original) por:

```html
<cps-paginator
  [offset]="offset()"
  [count]="items().length"
  [total]="total()"
  [disabled]="loading()"
  (prev)="prev()"
  (next)="next()"
/>
```

- [ ] **Step 7: Reemplazar el spinner del detalle expandido**

En el bloque de la fila expandida, reemplazar el `@if (loadingDetail()) { … }` por un `cps-async` que envuelva el detalle:

```html
<cps-async
  [loading]="loadingDetail()"
  [empty]="false"
  loadingText="Cargando respuestas…"
>
  <div class="py-2">
```

…cerrando con `</cps-async>` donde cerraba el `@else`.

- [ ] **Step 8: Verificar que compila y los tests pasan**

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build && npm test -- --watch=false
```

Esperado: sin errores, todos los tests en verde.

- [ ] **Step 9: Confirmar que no quedó markup duplicado**

```bash
cd frontend-angular
grep -nE "spinner-border|alert bg-|Anteriores" src/app/features/events/event-list.html
```

Esperado: **sin resultados**. Si aparece alguno, quedó un bloque sin migrar.

---

### Task 7: Verificación en el navegador

**Files:** ninguno (verificación).

- [ ] **Step 1: Verificación completa**

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build && npm test -- --watch=false
```

**Pegar la salida real.**

- [ ] **Step 2: Levantar backend y frontend**

```bash
cd backend-nestjs && npm run start:dev
```

```bash
cd frontend-angular && npx ng serve
```

- [ ] **Step 3: Probar `/eventos` con `cps_root`**

Credenciales: `cps_root` / `RootCps2026!`.

Verificar en el navegador:
- El encabezado muestra título, bajada y el botón "Registrar evento".
- Sin eventos: aparece el vacío con el ícono de campana tachada, **no** un spinner colgado.
- Con eventos: la tabla, los badges de estado traducidos ("Abierto", "Resuelto", "Falsa alarma") y el paginador con su tramo.
- Los filtros por barrio y estado siguen funcionando.
- La fila expandible ("Respuestas") abre, muestra las respuestas y permite "Estoy yendo".
- Resolver y marcar falsa alarma siguen funcionando.
- **Sin errores en la consola del navegador.**

- [ ] **Step 4: Provocar un error y ver el alert**

Cortar el backend (`Ctrl+C`) y recargar `/eventos`. Debe aparecer el `cps-alert` en variante error, **no** una pantalla en blanco.

---

## Qué NO se hace en esta fase

- No se extrae `cps-table` (ver Desvíos).
- No se extrae `cps-field`: es de formularios y esta pantalla casi no tiene. Sale en la Fase 5.
- No se migran las otras 27 pantallas: van a usar estos componentes cuando les toque.
- No se toca la lógica de `event-list.ts` más allá de los `imports`.
- No se define paleta ni identidad visual (Fase 6).
