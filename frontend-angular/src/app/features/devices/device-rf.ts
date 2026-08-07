import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DevicesService } from '../../core/api/devices.service';
import { sondearMientras } from '../../core/sondeo';
import { apiErrorMessage } from '../../core/http/api-error';
import { EstadoRf } from '../../core/models/api.models';

/**
 * La base de controles del equipo, dentro de la pestaña de Configuración.
 *
 * ## Por qué es un componente aparte
 *
 * Porque **no es configuración**, aunque comparta pantalla con ella: no tiene
 * `cfg_v`, no se mergea, no es retained y no entra en el diff de "vas a
 * cambiar". Es una cola de comandos con su ack. Meterla adentro de
 * `DeviceConfigTab` la haría parecer un campo más del formulario, y el día que
 * alguien apriete "Descartar cambios" esperaría que también descartara esto.
 *
 * ## Lo que muestra, y por qué así
 *
 * Los que YA están cargados son un número, no una lista: lo que pide una
 * decisión es lo que falta. Lo que no se puede cargar viene con el motivo
 * explicado por el backend —la web no traduce reglas del firmware por su
 * cuenta— y el conteo va contra la capacidad REAL del chip que reporta el
 * equipo.
 */
@Component({
  selector: 'app-device-rf',
  imports: [RouterLink],
  templateUrl: './device-rf.html',
})
export class DeviceRfTab {
  private readonly devices = inject(DevicesService);

  readonly deviceId = input.required<number>();

  readonly estado = signal<EstadoRf | null>(null);
  readonly cargando = signal(true);
  readonly enviando = signal(false);
  readonly error = signal<string | null>(null);

  /** Cuántos controles hay que tocar. Cero = no hay nada que mandar. */
  readonly aMandar = computed(() => {
    const e = this.estado();
    return e ? e.pendientes.length + e.bajas.length : 0;
  });

  readonly enCurso = computed(() => this.estado()?.tanda?.estado === 'en_curso');

  /**
   * Cuánto va a tardar, en lotes y en segundos.
   *
   * No se puede apurar: el equipo tarda ~2,25 s por lote de 5 porque **cada
   * alta barre su memoria entera**, y los lotes salen de a uno esperando la
   * respuesta del anterior. Decirlo antes evita que alguien crea que se colgó.
   */
  readonly estimado = computed(() => {
    const pendientes = this.estado()?.pendientes.length ?? 0;
    const lotes = Math.ceil(pendientes / 5);
    return { lotes, segundos: Math.ceil(lotes * 2.5) };
  });

  /**
   * El equipo se está quedando sin lugar. El 90% es un aviso, no un límite: el
   * límite lo pone el chip y los que no entran ya aparecen salteados.
   */
  readonly casiLleno = computed(() => {
    const c = this.estado()?.capacidad;
    return !!c && c.tope > 0 && c.ocupados / c.tope >= 0.9;
  });

  constructor() {
    effect(() => this.cargar(this.deviceId()));

    // La tanda avanza lote por lote y cada uno espera el ack del equipo: sin
    // esto el progreso se congelaba en "0 de 24" hasta apretar F5.
    sondearMientras(
      () => this.enCurso(),
      () => this.cargar(this.deviceId()),
      // Una tanda de 24 lotes son ~60 s con el equipo despierto; si duerme,
      // sigue cuando despierte y lo va a ver el próximo que abra la ficha.
      { cada: 4000, tope: 180_000 },
    );
  }

  private cargar(id: number): void {
    this.cargando.set(true);
    this.devices.baseRf(id).subscribe({
      next: (e) => {
        this.estado.set(e);
        this.cargando.set(false);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.cargando.set(false);
      },
    });
  }

  refrescar(): void {
    this.error.set(null);
    this.cargar(this.deviceId());
  }

  /**
   * Manda la tanda. La respuesta ya trae el estado con la tanda en curso, así
   * que no hay que volver a pedirlo — pero sí hay que refrescar a mano para ver
   * avanzar el progreso: los acks llegan del panel, no de esta pantalla.
   */
  sincronizar(): void {
    if (this.enviando()) return;

    this.enviando.set(true);
    this.error.set(null);

    this.devices.sincronizarRf(this.deviceId()).subscribe({
      next: (e) => {
        this.estado.set(e);
        this.enviando.set(false);
      },
      error: (e: unknown) => {
        // 409: ya hay una tanda en vuelo, o no hay nada que mandar.
        this.error.set(apiErrorMessage(e));
        this.enviando.set(false);
      },
    });
  }
}
