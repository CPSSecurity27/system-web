import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { FirmwareService } from '../../core/api/firmware.service';
import { sondearMientras } from '../../core/sondeo';
import { apiErrorMessage } from '../../core/http/api-error';
import {
  EquipoFirmware,
  ResultadoActualizacion,
} from '../../core/models/api.models';

/** Cómo se lee cada estado de la comparación. */
const ESTADOS: Record<
  EquipoFirmware['estado'],
  { texto: string; clase: string; orden: number }
> = {
  atrasado: { texto: 'desactualizado', clase: 'text-bg-warning', orden: 0 },
  desconocido: { texto: 'sin datos', clase: 'text-bg-secondary', orden: 1 },
  al_dia: { texto: 'al día', clase: 'text-bg-success', orden: 2 },
};

/**
 * El GESTOR DE ACTUALIZACIONES: qué versión corre cada poste y mandarles la nueva.
 *
 * ## Esto no es una campaña
 *
 * Tildar equipos y apretar encola **un comando por equipo, con su propio `cid`**,
 * igual que si se hubiera entrado a cada ficha. No hay broadcast (el firmware lo
 * prohíbe: el equipo no compara versiones, así que una oferta repetida es un
 * reboot real), no hay reintento automático y nada se dispara solo.
 *
 * ## Por qué el resultado se muestra equipo por equipo
 *
 * Porque una parte va a fallar, y no por error: **el firmware rechaza el OTA si
 * el equipo no está en modo de energía activo**. De noche, un poste solar no lo
 * está. No lo encola ni lo difiere — contesta `error` y se terminó. Un "listo"
 * global sobre eso sería mentir en la única pantalla donde importa.
 */
@Component({
  selector: 'app-firmware-fleet',
  imports: [DatePipe, RouterLink],
  templateUrl: './firmware-fleet.html',
})
export class FirmwareFleet {
  private readonly api = inject(FirmwareService);

  protected readonly cargando = signal(true);
  protected readonly mandando = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly publicada = signal<string | null>(null);
  protected readonly equipos = signal<EquipoFirmware[]>([]);
  protected readonly elegidos = signal<Set<number>>(new Set());

  /** Lo que devolvió el último envío, equipo por equipo. */
  protected readonly resultados = signal<ResultadoActualizacion[] | null>(null);
  /** El pedido esperando confirmación. */
  protected readonly confirmando = signal(false);

  constructor() {
    this.cargar();
    // Mientras haya algo en vuelo, la tabla se repregunta sola: el ack llega en
    // segundos y sin esto habría que apretar F5 para ver que pasó de "enviado" a
    // "confirmado".
    sondearMientras(
      () => this.hayEnVuelo(),
      () => this.cargar(),
    );
  }

  private cargar(): void {
    this.api.flota().subscribe({
      next: (f) => {
        this.publicada.set(f.publicada);
        this.equipos.set(f.equipos);
        this.cargando.set(false);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.cargando.set(false);
      },
    });
  }

  /**
   * Hay algo pasando y vale la pena repreguntar.
   *
   * Son tres situaciones y ninguna sobra:
   *
   * 1. **Un pedido sin cerrar.** El ack llega en segundos.
   * 2. **Un equipo bajando o verificando.**
   * 3. **Un equipo que acaba de reiniciar** para aplicar la actualización. Este
   *    es el caso delicado: "instalada, reiniciando" es el ÚLTIMO mensaje que
   *    manda —el self-test no publica nada—, así que si esperáramos otro
   *    mensaje sondearíamos para siempre. Lo que sí va a cambiar es la versión
   *    que reporta, y por eso se sigue mirando hasta que quede al día, con un
   *    tope de 15 minutos: el self-test tiene 10 para conseguir internet, y
   *    pasado eso el bootloader ya revirtió y refrescar no va a cambiar nada.
   */
  protected readonly hayEnVuelo = computed(() =>
    this.equipos().some((e) => {
      const pedidoAbierto =
        e.otaEnCurso !== null &&
        (e.otaEnCurso.estado === 'pending' || e.otaEnCurso.estado === 'sent');
      if (pedidoAbierto || e.progreso?.enCurso === true) return true;

      if (e.progreso?.esperandoReinicio !== true) return false;
      // Ya se resolvió en un sentido o en el otro: no hay nada que esperar.
      if (e.confirmacion !== null && e.confirmacion.estado !== 'reiniciando') {
        return false;
      }
      const desde = Date.now() - new Date(e.progreso.recibidoEn).getTime();
      return desde < 15 * 60_000;
    }),
  );

  // ── Cómo se ordena y se cuenta ───────────────────────────────────

  /** Los desactualizados primero: es lo que se vino a hacer a esta pantalla. */
  protected readonly ordenados = computed(() =>
    [...this.equipos()].sort(
      (a, b) => ESTADOS[a.estado].orden - ESTADOS[b.estado].orden,
    ),
  );

  protected readonly atrasados = computed(
    () => this.equipos().filter((e) => e.estado === 'atrasado').length,
  );
  protected readonly alDia = computed(
    () => this.equipos().filter((e) => e.estado === 'al_dia').length,
  );
  protected readonly desconocidos = computed(
    () => this.equipos().filter((e) => e.estado === 'desconocido').length,
  );

  // ── La selección ─────────────────────────────────────────────────

  protected estaElegido(id: number): boolean {
    return this.elegidos().has(id);
  }

  protected alternar(id: number): void {
    const copia = new Set(this.elegidos());
    if (copia.has(id)) copia.delete(id);
    else copia.add(id);
    this.elegidos.set(copia);
  }

  /**
   * Tilda todos los desactualizados. NO tilda los "sin datos": un equipo que
   * nunca conectó no está atrasado, no sabemos qué tiene.
   */
  protected elegirAtrasados(): void {
    this.elegidos.set(
      new Set(
        this.equipos()
          .filter((e) => e.estado === 'atrasado')
          .map((e) => e.deviceId),
      ),
    );
  }

  protected limpiarSeleccion(): void {
    this.elegidos.set(new Set());
  }

  protected readonly cuantosElegidos = computed(() => this.elegidos().size);

  /**
   * De los elegidos, cuántos van a rebotar por energía.
   *
   * Se avisa ANTES de mandar y no se bloquea: puede ser deliberado (el equipo
   * puede pasar a modo activo entre que se aprieta y que el comando sale), pero
   * mandar veinte sabiendo que quince rebotan no debería ser una sorpresa.
   */
  protected readonly elegidosSinEnergia = computed(() => {
    const ids = this.elegidos();
    return this.equipos().filter(
      (e) =>
        ids.has(e.deviceId) &&
        e.modoEnergia !== null &&
        !e.modoEnergia.startsWith('ACTIVE'),
    ).length;
  });

  // ── Mandar ───────────────────────────────────────────────────────

  protected pedirActualizar(): void {
    if (this.cuantosElegidos() === 0) return;
    this.confirmando.set(true);
  }

  protected cancelar(): void {
    this.confirmando.set(false);
  }

  protected confirmar(): void {
    this.confirmando.set(false);
    this.mandando.set(true);
    this.error.set(null);
    this.resultados.set(null);

    this.api.actualizar([...this.elegidos()]).subscribe({
      next: (r) => {
        this.resultados.set(r);
        this.mandando.set(false);
        this.limpiarSeleccion();
        this.cargar();
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.mandando.set(false);
      },
    });
  }

  protected cerrarResultados(): void {
    this.resultados.set(null);
  }

  protected readonly encolados = computed(
    () => this.resultados()?.filter((r) => r.encolado).length ?? 0,
  );
  protected readonly rebotados = computed(
    () => this.resultados()?.filter((r) => !r.encolado) ?? [],
  );

  // ── Presentación ─────────────────────────────────────────────────

  protected etiqueta(estado: EquipoFirmware['estado']) {
    return ESTADOS[estado];
  }

  /**
   * Las etiquetas de la confirmación, deliberadamente medidas.
   *
   * "arrancó" y no "actualizada": lo único que el equipo comprueba antes de dar
   * la imagen por buena es que consiguió internet en 10 minutos. Que la alarma
   * suene o que el RF escuche no lo verifica nadie, así que la pantalla no lo
   * puede afirmar — y decir "actualizada" es exactamente eso.
   */
  protected textoConfirmacion(estado: string): string {
    return (
      {
        arranco: 'arrancó con la nueva',
        reiniciando: 'instalada, reiniciando',
        no_aplico: 'no aplicó',
        indistinguible: 'sin confirmar',
        fallo: 'falló',
      }[estado] ?? estado
    );
  }

  /** Un equipo dormido NO está caído: avisó hasta cuándo duerme. */
  protected durmiendo(equipo: EquipoFirmware): boolean {
    return (
      equipo.durmiendoHasta !== null &&
      new Date(equipo.durmiendoHasta) > new Date()
    );
  }

  protected sinEnergia(equipo: EquipoFirmware): boolean {
    return equipo.modoEnergia !== null && !equipo.modoEnergia.startsWith('ACTIVE');
  }
}
