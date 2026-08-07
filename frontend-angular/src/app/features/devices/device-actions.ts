import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { DevicesService } from '../../core/api/devices.service';
import { sondearMientras } from '../../core/sondeo';
import { apiErrorMessage } from '../../core/http/api-error';
import { ColaComandos, Comando, Device, DeviceState } from '../../core/models/api.models';

/** Un botón de la pantalla, con lo que el equipo va a hacer si se aprieta. */
interface Accion {
  tipo: string;
  label: string;
  descripcion: string;
  /** Lo que cuesta. Si está, se muestra en rojo y se pide confirmar. */
  consecuencia?: string;
}

/**
 * Comandos sin consecuencia: piden un dato o rehacen una detección. Ninguno
 * interrumpe a la alarma ni cambia nada que después haya que deshacer.
 */
const DIAGNOSTICO: Accion[] = [
  {
    tipo: 'estado',
    label: 'Pedir estado ahora',
    descripcion: 'El equipo publica su presencia y su telemetría sin esperar al próximo envío.',
  },
  {
    tipo: 'hora',
    label: 'Sincronizar el reloj',
    descripcion:
      'Fuerza una consulta al servidor de hora. Sirve cuando los eventos llegan con la hora corrida.',
  },
  {
    tipo: 'i2c_scan',
    label: 'Re-detectar módulos',
    descripcion: 'Vuelve a recorrer el bus interno buscando el reloj, la memoria y el supervisor.',
  },
];

const MANTENIMIENTO: Accion[] = [
  {
    tipo: 'restart',
    label: 'Reiniciar el equipo',
    descripcion: 'Apaga y prende. Se usa cuando quedó raro y no responde bien.',
    consecuencia:
      'Durante el arranque el barrio tiene una alarma menos. Si el equipo no vuelve, hay que ir al poste.',
  },
  {
    tipo: 'ota',
    label: 'Actualizar el firmware',
    descripcion:
      'El equipo baja la versión nueva y se reinicia solo. Necesita energía suficiente: con batería baja lo rechaza.',
    consecuencia:
      'Si la actualización sale mal, el equipo puede quedar sin servicio hasta que alguien vaya.',
  },
  {
    tipo: 'factory',
    label: 'Volver a valores de fábrica',
    descripcion:
      'Borra la configuración y las redes WiFi guardadas. Los controles remotos NO se borran: viven en otra memoria.',
    consecuencia:
      'El equipo se queda SIN FORMA DE CONECTARSE y desaparece del sistema. Hay que ir físicamente hasta el poste y reconfigurarlo por su portal local. No hay vuelta atrás desde acá.',
  },
];

/** Los 8 slugs del firmware. El código es del hardware; la etiqueta es nuestra. */
export const MODOS_DISPARO = [
  { slug: 'emergency', label: 'Emergencia' },
  { slug: 'fire', label: 'Incendio' },
  { slug: 'medical', label: 'Médica' },
  { slug: 'alert', label: 'Alerta' },
  { slug: 'suspicious', label: 'Sospechoso' },
  { slug: 'silent', label: 'Silenciosa' },
  { slug: 'panic', label: 'Pánico' },
] as const;

/** Cómo se lee cada estado de la cola. */
const ESTADOS: Record<string, { texto: string; clase: string }> = {
  pending: { texto: 'en cola', clase: 'text-bg-secondary' },
  sent: { texto: 'enviado', clase: 'text-bg-info' },
  ok: { texto: 'confirmado', clase: 'text-bg-success' },
  error: { texto: 'rechazado', clase: 'text-bg-danger' },
  cancelled: { texto: 'cancelado', clase: 'text-bg-light' },
};

/**
 * Acciones sobre el equipo: los comandos que viajan por `av/<id>/cmd`.
 *
 * Un comando NO es una configuración: no tiene versión, no se mergea y no se
 * reintenta solo. Por eso la cola está a la vista — sin ella, uno que quedó
 * esperando porque el equipo duerme es indistinguible de uno que nunca salió.
 */
@Component({
  selector: 'app-device-actions',
  imports: [FormsModule, DatePipe, RouterLink],
  templateUrl: './device-actions.html',
})
export class DeviceActionsTab {
  private readonly devices = inject(DevicesService);

  readonly deviceId = input.required<number>();
  readonly device = input.required<Device>();
  readonly estadoVivo = input<DeviceState | null>(null);

  readonly diagnostico = DIAGNOSTICO;
  readonly mantenimiento = MANTENIMIENTO;
  readonly modosDisparo = MODOS_DISPARO;

  readonly cola = signal<Comando[]>([]);
  /**
   * Los dos permisos los DICE EL BACKEND, no se deducen de la sesión.
   *
   * Son dos matrices distintas —el disparo de alarma suma al MONITOR, los
   * comandos de infraestructura no— y las dos dependen además de quién opera el
   * barrio. Calcularlas acá sería reescribir en el navegador una regla que ya
   * vive en el servidor, y equivocarse en la copia.
   */
  readonly puedeOperar = signal(false);
  readonly puedeDisparar = signal(false);
  /**
   * Actualizar el firmware, que desde 2026-08-06 es SOLO CPS: instala software
   * en la infraestructura y no configura un barrio. Es una tercera matriz
   * porque `restart` y `factory` siguen siendo del que opera el barrio.
   */
  readonly puedeActualizar = signal(false);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly aviso = signal<string | null>(null);

  /** La acción peligrosa que está esperando confirmación, si hay alguna. */
  readonly confirmando = signal<Accion | null>(null);
  /** Lo que la persona tipeó para confirmar un `factory`. */
  readonly serialTipeado = signal('');
  /** OTA: de dónde baja el firmware. */
  readonly otaUrl = signal('');

  /**
   * Hay algo en vuelo: un pedido publicado que el equipo todavía no ackeó.
   *
   * Mientras dure, la cola se repregunta sola. Antes había que apretar F5 para
   * ver que un comando pasó de "enviado" a "confirmado" — y como el ack llega
   * en segundos, la pantalla mostraba "enviado" sobre algo ya hecho.
   */
  readonly hayEnVuelo = computed(() =>
    this.cola().some((c) => c.estado === 'pending' || c.estado === 'sent'),
  );

  constructor() {
    effect(() => {
      const id = this.deviceId();
      this.cargar(id);
    });

    sondearMientras(
      () => this.hayEnVuelo(),
      () => this.cargar(this.deviceId()),
    );
  }

  private cargar(id: number): void {
    this.cargando.set(true);
    this.devices.comandos(id).subscribe({
      next: (cola) => {
        this.aplicar(cola);
        this.cargando.set(false);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.cargando.set(false);
      },
    });
  }

  private aplicar(cola: ColaComandos): void {
    this.cola.set(cola.comandos);
    this.puedeOperar.set(cola.puedeOperar);
    this.puedeDisparar.set(cola.puedeDisparar);
    this.puedeActualizar.set(cola.puedeActualizar);
  }

  /** El OTA pide su propio permiso; el resto del mantenimiento, `puedeOperar`. */
  puedeUsar(accion: Accion): boolean {
    return accion.tipo === 'ota' ? this.puedeActualizar() : this.puedeOperar();
  }

  // ── Estado del equipo ────────────────────────────────────────────

  readonly durmiendo = computed(() => {
    const hasta = this.estadoVivo()?.sleepUntil;
    return hasta !== null && hasta !== undefined && new Date(hasta) > new Date();
  });

  /**
   * Un comando a un equipo dormido u offline NO es un error: queda en la cola y
   * el GtD lo publica cuando vuelve. Se avisa, no se bloquea — al revés que el
   * scan, que sí necesita al equipo despierto porque el resultado es inmediato.
   */
  readonly demora = computed(() => {
    if (this.durmiendo()) {
      const hasta = this.estadoVivo()?.sleepUntil;
      const hora = hasta
        ? new Date(hasta).toLocaleTimeString('es-AR', {
            hour: '2-digit',
            minute: '2-digit',
          })
        : 'más tarde';
      return `El equipo duerme hasta las ${hora}: lo que mandes queda en cola y lo va a tomar al despertar.`;
    }
    if (this.estadoVivo()?.online !== true) {
      return 'El equipo está desconectado: lo que mandes queda en cola hasta que vuelva.';
    }
    return null;
  });

  // ── La cola ──────────────────────────────────────────────────────

  etiquetaEstado(estado: string): { texto: string; clase: string } {
    return ESTADOS[estado] ?? { texto: estado, clase: 'text-bg-secondary' };
  }

  // ── Mandar ───────────────────────────────────────────────────────

  /** Sin consecuencia va derecho; con consecuencia, primero la muestra. */
  pedir(accion: Accion): void {
    if (accion.consecuencia) {
      this.confirmando.set(accion);
      this.serialTipeado.set('');
      this.otaUrl.set('');
      return;
    }
    this.mandar(accion.tipo, {});
  }

  cancelarConfirmacion(): void {
    this.confirmando.set(null);
  }

  /** Para `factory`: hay que escribir el serial tal cual. */
  readonly confirmacionValida = computed(() => {
    const accion = this.confirmando();
    if (!accion) return false;
    if (accion.tipo !== 'factory') return true;
    return this.serialTipeado().trim() === this.device().serial;
  });

  confirmar(): void {
    const accion = this.confirmando();
    if (!accion || !this.confirmacionValida()) return;

    const params =
      accion.tipo === 'ota' && this.otaUrl().trim().length > 0
        ? { fuente: 'url', base: this.otaUrl().trim() }
        : accion.tipo === 'ota'
          ? { fuente: 'auto' }
          : {};

    this.mandar(
      accion.tipo,
      params,
      accion.tipo === 'factory' ? this.serialTipeado().trim() : undefined,
    );
    this.confirmando.set(null);
  }

  private mandar(tipo: string, params: Record<string, unknown>, confirmacion?: string): void {
    this.error.set(null);
    this.devices.mandarComando(this.deviceId(), tipo, params, confirmacion).subscribe({
      next: (cola) => {
        this.aplicar(cola);
        this.aviso.set('Pedido encolado. Abajo podés ver en qué queda.');
      },
      error: (e: unknown) => this.error.set(apiErrorMessage(e)),
    });
  }

  disparar(modo: string): void {
    this.error.set(null);
    this.devices.dispararAlarma(this.deviceId(), modo).subscribe({
      next: (cola) => {
        this.aplicar(cola);
        this.aviso.set(
          modo === 'off'
            ? 'Se le pidió al equipo que apague la alarma.'
            : 'Se le pidió al equipo que dispare la alarma.',
        );
      },
      error: (e: unknown) => this.error.set(apiErrorMessage(e)),
    });
  }

  cancelarComando(cid: string): void {
    this.error.set(null);
    this.devices.cancelarComando(this.deviceId(), cid).subscribe({
      next: (cola) => this.aplicar(cola),
      error: (e: unknown) => this.error.set(apiErrorMessage(e)),
    });
  }
}
