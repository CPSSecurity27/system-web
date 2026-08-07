import { DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval } from 'rxjs';

/**
 * Repreguntar mientras haya algo en vuelo hacia el equipo.
 *
 * ## Por qué existe
 *
 * Todo lo que se le pide a un panel llega DESPUÉS y por otro camino: la web
 * encola un comando, el GtD lo publica, el equipo contesta cuando puede, y el
 * resultado aparece en la base sin que el navegador se entere. Sin esto había
 * que apretar F5 para ver un escaneo que ya había llegado — y la pantalla decía
 * "enviado" sobre algo que hacía rato estaba hecho.
 *
 * ## Por qué sondeo y no push
 *
 * La base ya tiene el canal (`NOTIFY app_panel_state`) y algún día habrá un
 * WebSocket. Pero eso es una conexión abierta por operador contra una Raspberry
 * de 921 MB que además corre el broker, Postgres y el GtD; y para el caso real
 * —una persona mirando una ficha después de apretar un botón— un sondeo corto
 * hace lo mismo sin nada de eso.
 *
 * ## Lo que NO hace: sondear para siempre
 *
 * Solo mientras `mientras()` diga que se espera algo, y con un tope. Una ficha
 * abierta y olvidada en una pestaña no puede quedar preguntando toda la noche:
 * un panel dormido no contesta hasta que despierte, y no hay razón para
 * gastarle batería a la Pi mientras tanto.
 *
 * Se llama en el constructor del componente: usa `takeUntilDestroyed`, así que
 * al cerrar la pantalla el sondeo muere con ella.
 */
export interface OpcionesDeSondeo {
  /** Cada cuánto repreguntar. Un panel despierto contesta en 1-3 s. */
  cada?: number;
  /**
   * Cuánto insistir antes de rendirse. Por encima de esto, el equipo está
   * dormido o no va a contestar: lo va a mostrar el próximo que abra la ficha.
   */
  tope?: number;
}

export function sondearMientras(
  mientras: () => boolean,
  recargar: () => void,
  { cada = 3000, tope = 90_000 }: OpcionesDeSondeo = {},
): void {
  const destroyRef = inject(DestroyRef);

  // El tope se cuenta desde que EMPEZÓ esta espera, no desde que se abrió la
  // pantalla: si el operador manda otra cosa media hora después, esa espera
  // arranca con su propio presupuesto. Con un límite fijo al montar, el segundo
  // pedido no se habría actualizado nunca.
  let esperandoDesde: number | null = null;

  interval(cada)
    .pipe(takeUntilDestroyed(destroyRef))
    .subscribe(() => {
      if (!mientras()) {
        esperandoDesde = null;
        return;
      }
      esperandoDesde ??= Date.now();
      if (Date.now() - esperandoDesde > tope) return;
      recargar();
    });
}
