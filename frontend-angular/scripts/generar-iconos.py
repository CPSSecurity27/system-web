#!/usr/bin/env python
"""
Genera el set de íconos del panel a partir de Lucide.

POR QUÉ EXISTE ESTO
-------------------
1. `lucide-static/font/lucide.css` trae 2007 reglas para los ~70 íconos que el
   panel usa, y su woff2 pesa 275 KB. Con el técnico usando el panel desde el
   celular en la calle, eso no da.
2. Y sobre todo: sumar `lucide.css` a `styles[]` de angular.json FUNCIONA en
   `ng build` pero el dev server lo descarta en silencio (leaflet, que va
   después en la misma lista, sí entra). Con el archivo generado acá el
   resultado es el mismo en dev y en prod, porque es código nuestro.

QUÉ HACE
--------
- Barre `src/app` buscando las clases `icon-*` realmente usadas.
- Saca sus codepoints de `lucide.css`.
- Subsetea `lucide.woff2` a esos glifos       -> public/fonts/lucide-subset.woff2
- Emite el @font-face y una regla por ícono   -> src/styles/_icons.scss

CUÁNDO CORRERLO
---------------
Cada vez que se agrega o se saca un ícono del código:

    cd frontend-angular && python scripts/generar-iconos.py

Si te olvidás, el ícono nuevo no se dibuja (queda un hueco). El test
`iconos.spec.ts` lo detecta antes de que llegue a una pantalla.
"""

import re
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
FUENTE_LUCIDE = RAIZ / "node_modules" / "lucide-static" / "font"
CSS_LUCIDE = FUENTE_LUCIDE / "lucide.css"
WOFF2_LUCIDE = FUENTE_LUCIDE / "lucide.woff2"
APP = RAIZ / "src" / "app"
SALIDA_SCSS = RAIZ / "src" / "styles" / "_icons.scss"
SALIDA_FUENTE = RAIZ / "public" / "fonts" / "lucide-subset.woff2"

# `icon-tile` y `icon-tile-sm` son clases de composición nuestras, no íconos.
NO_SON_ICONOS = {"icon-tile", "icon-tile-sm", "icon-tile-lg"}


def iconos_usados() -> set[str]:
    usados: set[str] = set()
    for archivo in list(APP.rglob("*.ts")) + list(APP.rglob("*.html")):
        if archivo.name.endswith(".spec.ts"):
            continue
        for nombre in re.findall(r"\bicon-[a-z0-9-]+", archivo.read_text(encoding="utf-8")):
            if nombre not in NO_SON_ICONOS:
                usados.add(nombre)
    return usados


def codepoints() -> dict[str, str]:
    css = CSS_LUCIDE.read_text(encoding="utf-8")
    return dict(re.findall(r"\.(icon-[a-z0-9-]+)::before\s*\{\s*content:\s*\"\\([0-9a-fA-F]+)\"", css))


def main() -> int:
    if not CSS_LUCIDE.exists():
        print("Falta lucide-static. Corré: npm install", file=sys.stderr)
        return 1

    usados = iconos_usados()
    tabla = codepoints()

    faltantes = sorted(usados - tabla.keys())
    if faltantes:
        print("Estos íconos no existen en Lucide:", ", ".join(faltantes), file=sys.stderr)
        return 1

    elegidos = sorted(usados)
    puntos = [tabla[n] for n in elegidos]

    SALIDA_FUENTE.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            sys.executable, "-m", "fontTools.subset", str(WOFF2_LUCIDE),
            "--unicodes=" + ",".join("U+" + p for p in puntos),
            "--flavor=woff2",
            "--output-file=" + str(SALIDA_FUENTE),
        ],
        check=True,
    )

    reglas = "\n".join(f'.{n}::before {{ content: "\\{tabla[n]}"; }}' for n in elegidos)
    SALIDA_SCSS.parent.mkdir(parents=True, exist_ok=True)
    SALIDA_SCSS.write_text(
        f"""// GENERADO POR scripts/generar-iconos.py — NO EDITAR A MANO.
//
// Subset de Lucide con los {len(elegidos)} íconos que el panel usa hoy.
// Para agregar uno: usalo en el código y volvé a correr el script.

@font-face {{
  font-family: 'lucide';
  src: url('/fonts/lucide-subset.woff2') format('woff2');
  font-display: swap;
}}

[class^='icon-'],
[class*=' icon-'] {{
  font-family: 'lucide';
  font-style: normal;
  font-weight: normal;
  display: inline-block;
  vertical-align: -0.125em;
  line-height: 1;
  -webkit-font-smoothing: antialiased;
}}

{reglas}
""",
        encoding="utf-8",
    )

    kb_antes = WOFF2_LUCIDE.stat().st_size / 1024
    kb_despues = SALIDA_FUENTE.stat().st_size / 1024
    print(f"{len(elegidos)} íconos · fuente {kb_antes:.0f} KB -> {kb_despues:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
