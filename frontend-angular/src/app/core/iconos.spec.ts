import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El set de íconos es un SUBSET generado (`scripts/generar-iconos.py`): sólo
 * entran a la fuente los que el código usa. Si alguien escribe un `icon-*` nuevo
 * y no vuelve a correr el script, el ícono simplemente no se dibuja — queda un
 * hueco silencioso que nadie nota hasta que un usuario mira la pantalla.
 *
 * Este test convierte ese hueco silencioso en un test rojo.
 */

/**
 * Vitest corre desde la raíz del paquete, o sea `frontend-angular/`.
 *
 * Los tipos de Node están sólo en `tsconfig.spec.json`: el build de la app
 * tiene `types: []`, así que sus globales no se filtran al código de producción.
 */
const RAIZ = process.cwd();
const APP = join(RAIZ, 'src', 'app');
const GENERADO = join(RAIZ, 'src', 'styles', '_icons.scss');

/** Clases de composición nuestras, no íconos. Ver el script. */
const NO_SON_ICONOS = new Set(['icon-tile', 'icon-tile-sm', 'icon-tile-lg']);

function archivosDeCodigo(dir: string): string[] {
  const entradas: string[] = readdirSync(dir);

  return entradas.flatMap((entrada: string) => {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) {
      return archivosDeCodigo(ruta);
    }
    const esCodigo = ruta.endsWith('.ts') || ruta.endsWith('.html');
    return esCodigo && !ruta.endsWith('.spec.ts') ? [ruta] : [];
  });
}

describe('set de íconos', () => {
  const generado = readFileSync(GENERADO, 'utf8');

  const usados = new Set(
    archivosDeCodigo(APP)
      .flatMap((f) => readFileSync(f, 'utf8').match(/\bicon-[a-z0-9-]+/g) ?? [])
      .filter((nombre) => !NO_SON_ICONOS.has(nombre)),
  );

  it('encuentra íconos en el código (si no, el test no está midiendo nada)', () => {
    expect(usados.size).toBeGreaterThan(20);
  });

  it('todo ícono usado está en la fuente generada', () => {
    const faltantes = [...usados].filter((nombre) => !generado.includes(`.${nombre}::before`));

    // Si esto falla: cd frontend-angular && python scripts/generar-iconos.py
    expect(faltantes).toEqual([]);
  });

  it('no quedan íconos de Bootstrap Icons sueltos', () => {
    const conBootstrap = archivosDeCodigo(APP).filter((f) =>
      /\bbi-[a-z]/.test(readFileSync(f, 'utf8')),
    );

    expect(conBootstrap).toEqual([]);
  });
});
