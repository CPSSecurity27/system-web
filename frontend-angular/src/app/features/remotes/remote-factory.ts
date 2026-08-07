import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { RemotesService } from '../../core/api/remotes.service';
import { apiErrorMessage } from '../../core/http/api-error';
import {
  EtiquetaControl,
  RemoteFabricado,
  RemoteModel,
  ResultadoBusqueda,
} from '../../core/models/api.models';
import { RemoteLabel } from './remote-label';

/** De dónde sale el número que se graba en el control. */
export type ModoCodigos = 'azar' | 'correlativo' | 'manual';

/**
 * Lo que el panel guarda como código (`EE_CODE_MIN`/`EE_CODE_MAX` del firmware).
 *
 * Están repetidos acá a propósito: el backend los valida igual y su respuesta es
 * la que manda, pero un límite que solo se conoce del otro lado convierte un
 * error de tipeo en un viaje al servidor y un cartel rojo. Acá se ve antes.
 */
const CODIGO_MIN = 10_000;
const CODIGO_MAX = 999_999_999_999;

/**
 * Qué botón es cada posición. Es la misma tabla del backend (`POSICIONES`), que
 * a su vez sale de `POS_TO_MODE` en el firmware: la posición NO es un orden de
 * carga, es qué hace ese código. Cargarlos a mano en el orden equivocado deja el
 * botón de apagar disparando emergencia.
 */
const BOTONES = [
  { position: 1, boton: 'A', label: 'Emergencia' },
  { position: 2, boton: 'B', label: 'Sospechoso' },
  { position: 3, boton: 'C', label: 'Alerta' },
  { position: 4, boton: 'D', label: 'Apagar' },
] as const;

/**
 * Fábrica de controles remotos. Solo CPS.
 *
 * Alta y registro en la MISMA pantalla, igual que la de alarmas: en la estación
 * se fabrican de a tandas y navegar por control sería fricción pura.
 *
 * El flujo es: elegís modelo → salen serial y códigos → los grabás en el control
 * → imprimís la etiqueta → **Listo**. Recién con el visto bueno el control entra
 * al stock de fábrica: hasta ahí es un llavero a medio hacer, y entregarlo sería
 * darle a un vecino algo que todavía no dispara nada.
 */
@Component({
  selector: 'app-remote-factory',
  imports: [FormsModule, RouterLink, RemoteLabel],
  templateUrl: './remote-factory.html',
})
export class RemoteFactory {
  private readonly remotes = inject(RemotesService);

  readonly modelos = signal<RemoteModel[]>([]);
  readonly modeloId = signal<number | null>(null);

  /**
   * De dónde salen los códigos.
   *
   * **Al azar** es el default y es lo correcto: un código es la única credencial
   * del control —el panel no valida nada más que el número— así que tiene que
   * ser imposible de adivinar. **Correlativo** sirve al grabar una tanda en la
   * mesa: quedan en orden y se verifican de un vistazo; los tomados se saltean.
   * **A mano** es para el control que ya viene con sus códigos de fábrica y no
   * se deja regrabar: ahí no se eligen, se copian.
   */
  readonly modo = signal<ModoCodigos>('azar');

  /**
   * Lo tipeado, por posición. Se guarda como texto y no como número: `''` y `0`
   * son cosas distintas y un input numérico vacío no las distingue.
   */
  readonly manuales = signal<string[]>(['', '', '', '']);

  /** TODO lo fabricado, no solo lo de esta sesión. Lo último arriba. */
  readonly fabricados = signal<ResultadoBusqueda[]>([]);
  readonly cargando = signal(true);

  /**
   * El recién fabricado, con sus códigos a la vista.
   *
   * Es la única respuesta del sistema que trae los códigos sin pedirlos aparte,
   * y están acá porque hay que grabarlos en el control ahora mismo.
   */
  readonly recien = signal<RemoteFabricado | null>(null);

  /** Los códigos de un control ya fabricado, cuando alguien los pide. */
  readonly codigosVistos = signal<EtiquetaControl | null>(null);

  /** Lo que va a salir por la impresora. Invisible en pantalla. */
  readonly paraImprimir = signal<EtiquetaControl | null>(null);

  readonly guardando = signal(false);
  readonly marcando = signal<number | null>(null);
  readonly imprimiendo = signal<number | null>(null);
  readonly abriendoCodigos = signal<number | null>(null);
  readonly removiendo = signal<number | null>(null);
  readonly error = signal<string | null>(null);

  /** Buscador. `null` = todavía no se buscó (distinto de "sin resultados"). */
  readonly consulta = signal('');
  readonly resultados = signal<ResultadoBusqueda[] | null>(null);
  readonly buscando = signal(false);

  constructor() {
    this.remotes.modelos().subscribe({
      next: (ms) => {
        const activos = ms.filter((m) => m.active);
        this.modelos.set(activos);
        if (activos.length === 1) this.modeloId.set(activos[0].id);
      },
      error: (e: unknown) => this.error.set(apiErrorMessage(e)),
    });
    this.cargarFabricados();
  }

  private cargarFabricados(): void {
    this.cargando.set(true);
    this.remotes.fabricados().subscribe({
      next: (rs) => {
        this.fabricados.set(rs);
        this.cargando.set(false);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.cargando.set(false);
      },
    });
  }

  /** Lo que se muestra en la tabla: el resultado de la búsqueda, o todo. */
  readonly listado = computed(() => this.resultados() ?? this.fabricados());

  readonly modeloElegido = computed(
    () => this.modelos().find((m) => m.id === this.modeloId()) ?? null,
  );

  /** Cuántos códigos lleva: los botones del modelo, con el tope del panel (4). */
  readonly cantidadCodigos = computed(() =>
    Math.min(this.modeloElegido()?.buttons ?? 0, 4),
  );

  /** Un modelo con más de 4 botones tiene teclas que el panel no registra. */
  readonly botonesDeMas = computed(() => {
    const botones = this.modeloElegido()?.buttons ?? 0;
    return botones > 4 ? botones - 4 : 0;
  });

  // ── Códigos a mano ────────────────────────────────────────────────

  cambiarModo(modo: ModoCodigos): void {
    this.modo.set(modo);
  }

  /** Lo tipeado en una posición. Fuera del modo manual esto no se usa. */
  escribirCodigo(indice: number, valor: string): void {
    this.manuales.update((vs) => vs.map((v, i) => (i === indice ? valor : v)));
  }

  private limpiarManuales(): void {
    this.manuales.set(['', '', '', '']);
  }

  /**
   * Un campo por botón, con lo que le pasa a lo tipeado.
   *
   * El error se calcula por campo y no de a uno global porque son cuatro números
   * largos: decir "hay un código inválido" obligaría a revisarlos todos.
   */
  readonly camposManuales = computed(() => {
    const valores = this.manuales();
    const cuantos = this.cantidadCodigos();

    // Un número repetido en dos posiciones lo rechaza el backend igual (el
    // índice único vive sobre el HMAC), pero acá se ve sin mandar nada.
    const veces = new Map<string, number>();
    for (const v of valores.slice(0, cuantos)) {
      const t = v.trim();
      if (t.length > 0) veces.set(t, (veces.get(t) ?? 0) + 1);
    }

    return BOTONES.slice(0, cuantos).map((b, i) => {
      const valor = valores[i] ?? '';
      const t = valor.trim();
      let error: string | null = null;
      if (t.length === 0) {
        error = null; // Vacío todavía no es un error: es un campo sin llenar.
      } else if (!/^\d+$/.test(t)) {
        error = 'Solo números, sin puntos ni espacios';
      } else if (Number(t) < CODIGO_MIN || Number(t) > CODIGO_MAX) {
        error = `El equipo guarda de ${CODIGO_MIN} a ${CODIGO_MAX}`;
      } else if ((veces.get(t) ?? 0) > 1) {
        error = 'Repetido en otra posición';
      }
      return { ...b, indice: i, valor, error };
    });
  });

  /** Los cuatro cargados y sin problemas. Recién ahí se puede fabricar. */
  readonly manualCompleto = computed(() => {
    const campos = this.camposManuales();
    return (
      campos.length > 0 &&
      campos.every((c) => c.valor.trim().length > 0 && c.error === null)
    );
  });

  readonly puedeFabricar = computed(() => {
    if (this.modeloId() === null || this.guardando()) return false;
    return this.modo() === 'manual' ? this.manualCompleto() : true;
  });

  // ── Fabricar ──────────────────────────────────────────────────────

  fabricar(): void {
    const modelId = this.modeloId();
    if (!modelId || !this.puedeFabricar()) return;

    const manual = this.modo() === 'manual';
    const codigos = manual
      ? this.camposManuales().map((c) => Number(c.valor.trim()))
      : undefined;

    this.guardando.set(true);
    this.error.set(null);

    this.remotes
      .fabricar(modelId, this.modo() === 'correlativo', codigos)
      .subscribe({
        next: (control) => {
          this.recien.set(control);
          this.guardando.set(false);
          // Los tipeados ya quedaron grabados en ESE control: dejarlos en el
          // formulario sería ofrecerlos para el siguiente, y el backend los
          // rechazaría por repetidos — con suerte.
          if (manual) this.limpiarManuales();
          // La búsqueda vieja dejaría el recién fabricado afuera de la tabla.
          this.limpiarBusqueda();
          this.cargarFabricados();
        },
        error: (e: unknown) => {
          this.error.set(apiErrorMessage(e));
          this.guardando.set(false);
        },
      });
  }

  cerrarRecien(): void {
    this.recien.set(null);
  }

  // ── El visto bueno ────────────────────────────────────────────────

  /**
   * Marca o desmarca "listo". Con el visto bueno el control entra al stock.
   *
   * Se puede desmarcar porque el error más común es marcar de más, y obligar a
   * borrar el control para corregirlo sería peor que el error.
   */
  marcarListo(control: ResultadoBusqueda): void {
    if (this.marcando() !== null) return;
    this.marcando.set(control.id);
    this.error.set(null);

    this.remotes.marcarListo(control.id, control.readyAt === null).subscribe({
      next: (actualizado) => {
        this.reemplazar(actualizado);
        this.marcando.set(null);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.marcando.set(null);
      },
    });
  }

  /** Actualiza la fila en las dos listas sin volver a pedir todo. */
  private reemplazar(control: ResultadoBusqueda): void {
    const cambiar = (rs: ResultadoBusqueda[]) =>
      rs.map((r) => (r.id === control.id ? { ...r, ...control } : r));
    this.fabricados.update(cambiar);
    this.resultados.update((rs) => (rs === null ? null : cambiar(rs)));
  }

  /**
   * A la papelera. Desaparece de esta lista y aparece en removidos.
   *
   * No lo deja sin efecto: sus códigos siguen grabados en las alarmas del
   * barrio. La pantalla de removidos lo dice con todas las letras.
   */
  remover(control: ResultadoBusqueda): void {
    if (this.removiendo() !== null) return;
    this.removiendo.set(control.id);
    this.error.set(null);

    this.remotes.remover(control.id).subscribe({
      next: () => {
        const sacar = (rs: ResultadoBusqueda[]) =>
          rs.filter((r) => r.id !== control.id);
        this.fabricados.update(sacar);
        this.resultados.update((rs) => (rs === null ? null : sacar(rs)));
        this.removiendo.set(null);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.removiendo.set(null);
      },
    });
  }

  // ── Códigos e impresión ───────────────────────────────────────────

  /**
   * Ver los códigos sin imprimir. Queda en `audit_log` igual que imprimir: el
   * backend entrega los códigos y no puede saber qué se hace después con ellos.
   */
  verCodigos(id: number): void {
    if (this.abriendoCodigos() !== null) return;
    this.abriendoCodigos.set(id);
    this.error.set(null);

    this.remotes.etiqueta(id).subscribe({
      next: (e) => {
        this.codigosVistos.set(e);
        this.abriendoCodigos.set(null);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.abriendoCodigos.set(null);
      },
    });
  }

  cerrarCodigos(): void {
    this.codigosVistos.set(null);
  }

  /**
   * Imprimir la etiqueta.
   *
   * Se pinta primero y se imprime en el tick siguiente: si se llama a
   * `window.print()` en el mismo, el navegador arma la vista de impresión antes
   * de que el SVG del QR haya entrado al DOM y la etiqueta sale sin QR.
   */
  imprimir(id: number): void {
    if (this.imprimiendo() !== null) return;
    this.imprimiendo.set(id);
    this.error.set(null);

    this.remotes.etiqueta(id).subscribe({
      next: (e) => {
        this.paraImprimir.set(e);
        setTimeout(() => {
          window.print();
          this.imprimiendo.set(null);
        }, 300);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.imprimiendo.set(null);
      },
    });
  }

  // ── Buscador ──────────────────────────────────────────────────────

  /**
   * Busca en TODO lo fabricado. El caso de uso es tener un control en la mano
   * —o un código de un log— y averiguar cuál es.
   *
   * Por código encuentra solo con el número completo: el backend lo compara
   * contra el HMAC, que es exacto. No hay búsqueda por prefijo ni forma de
   * enumerar, y la respuesta nunca trae códigos.
   */
  buscar(): void {
    const q = this.consulta().trim();
    if (q.length === 0) {
      this.resultados.set(null);
      return;
    }
    this.buscando.set(true);
    this.error.set(null);

    this.remotes.buscar(q).subscribe({
      next: (rs) => {
        this.resultados.set(rs);
        this.buscando.set(false);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.buscando.set(false);
      },
    });
  }

  limpiarBusqueda(): void {
    this.consulta.set('');
    this.resultados.set(null);
  }
}
