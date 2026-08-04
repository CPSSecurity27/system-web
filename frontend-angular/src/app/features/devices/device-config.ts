import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { DevicesService } from '../../core/api/devices.service';
import { apiErrorMessage } from '../../core/http/api-error';
import {
  DeviceConfig,
  DeviceState,
  RedWifiRevelada,
} from '../../core/models/api.models';

/** Una red en el formulario. `psw` vacía = conservar la que ya tiene el panel. */
export interface RedEditable {
  ssid: string;
  psw: string;
  prio: number;
  tienePassword: boolean;
}

interface Cambio {
  campo: string;
  de: string;
  a: string;
}

/** Los módulos, con lo que se pierde al apagar cada uno. */
const CONSECUENCIA_MODULO: Record<string, string> = {
  rf: 'el panel deja de escuchar los controles remotos de los vecinos',
  ds3231: 'el equipo pierde el reloj de respaldo y la hora de los eventos se vuelve poco confiable',
  eeprom: 'el panel deja de guardar la base de códigos RF',
  supervisor: 'se apaga el watchdog que reinicia el equipo si se cuelga',
};

/** Campos escalares que se comparan para el diff, con su ruta en el JSON. */
const CAMPOS_ESCALARES = [
  'tiempos.send_tele_s',
  'hora.tz_offset_s',
  'mante.on',
  'modulos.ds3231',
  'modulos.eeprom',
  'modulos.supervisor',
  'modulos.rf',
  'red_avanzada.roam_rssi',
  'red_avanzada.roam_delta',
  'red_avanzada.roam_cooldown_s',
];

function leer(objeto: Record<string, unknown> | null, ruta: string): unknown {
  if (!objeto) return undefined;
  const [seccion, campo] = ruta.split('.');
  const sub = objeto[seccion];
  if (typeof sub !== 'object' || sub === null) return undefined;
  return (sub as Record<string, unknown>)[campo];
}

/**
 * Pestaña de configuración de una alarma.
 *
 * Muestra el ESPEJO (lo que el panel dice que corre, después de los clamps
 * silenciosos del firmware) y publica un patch contra él. La pantalla nunca
 * miente: un valor solo se muestra como vigente cuando el equipo lo confirmó.
 *
 * Diseño: `docs/superpowers/specs/2026-08-04-configuracion-por-equipo-design.md`.
 */
@Component({
  selector: 'app-device-config',
  imports: [FormsModule, DatePipe],
  templateUrl: './device-config.html',
})
export class DeviceConfigTab {
  private readonly devices = inject(DevicesService);

  readonly deviceId = input.required<number>();
  /** Para saber si el equipo puede atender un scan ahora mismo. */
  readonly estadoVivo = input<DeviceState | null>(null);

  readonly config = signal<DeviceConfig | null>(null);
  readonly borrador = signal<Record<string, unknown>>({});
  readonly redes = signal<RedEditable[]>([]);
  readonly cargando = signal(true);
  readonly guardando = signal(false);
  readonly error = signal<string | null>(null);
  readonly aviso = signal<string | null>(null);
  readonly reveladas = signal<RedWifiRevelada[] | null>(null);

  constructor() {
    effect(() => {
      const id = this.deviceId();
      this.cargar(id);
    });
  }

  private cargar(id: number): void {
    this.cargando.set(true);
    this.devices.config(id).subscribe({
      next: (c) => {
        this.aplicar(c);
        this.cargando.set(false);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.cargando.set(false);
      },
    });
  }

  /** Vuelca la respuesta al formulario. El borrador arranca igual al espejo. */
  private aplicar(c: DeviceConfig): void {
    this.config.set(c);
    this.borrador.set(structuredClone(c.configuracion ?? {}));
    this.redes.set(
      c.redes.map((r) => ({
        ssid: r.ssid,
        psw: '',
        prio: r.prio,
        tienePassword: r.tienePassword,
      })),
    );
    this.reveladas.set(null);
  }

  // ── Estado de la pantalla ────────────────────────────────────────

  /** Sin espejo no se puede editar: un patch a ciegas apagaría módulos. */
  readonly bloqueado = computed(() => {
    const c = this.config();
    return !c || c.estado === 'SIN_ESPEJO' || !c.puedeEditar;
  });

  readonly sinEspejo = computed(() => this.config()?.estado === 'SIN_ESPEJO');

  readonly durmiendo = computed(() => {
    const hasta = this.estadoVivo()?.sleepUntil;
    return hasta !== null && hasta !== undefined && new Date(hasta) > new Date();
  });

  readonly puedeEscanear = computed(
    () =>
      !this.bloqueado() &&
      this.estadoVivo()?.online === true &&
      !this.durmiendo(),
  );

  readonly motivoSinScan = computed(() => {
    if (this.durmiendo()) {
      const hasta = this.estadoVivo()?.sleepUntil;
      return `El equipo duerme hasta ${hasta ? new Date(hasta).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : 'más tarde'}`;
    }
    if (this.estadoVivo()?.online !== true) {
      return 'El equipo está desconectado';
    }
    return '';
  });

  // ── El diff ──────────────────────────────────────────────────────

  readonly cambios = computed<Cambio[]>(() => {
    const espejo = this.config()?.configuracion ?? null;
    const borrador = this.borrador();
    const lista: Cambio[] = [];

    for (const ruta of CAMPOS_ESCALARES) {
      const antes = leer(espejo, ruta);
      const ahora = leer(borrador, ruta);
      if (antes === undefined && ahora === undefined) continue;
      if (String(antes) !== String(ahora)) {
        lista.push({ campo: ruta, de: String(antes), a: String(ahora) });
      }
    }

    if (this.redesCambiaron()) {
      lista.push({
        campo: 'redes',
        de: `${this.config()?.redes.length ?? 0} redes`,
        a: `${this.redes().length} redes`,
      });
    }
    return lista;
  });

  readonly hayCambios = computed(() => this.cambios().length > 0);

  private redesCambiaron(): boolean {
    const originales = this.config()?.redes ?? [];
    const actuales = this.redes();
    if (originales.length !== actuales.length) return true;
    return actuales.some(
      (r, i) =>
        r.ssid !== originales[i].ssid ||
        r.prio !== originales[i].prio ||
        r.psw.length > 0,
    );
  }

  /**
   * SOLO las secciones que cambiaron. No es una optimización: el panel acepta
   * 1024 bytes y el merge del servidor ya repone lo que falte desde el espejo.
   */
  readonly patch = computed<Record<string, unknown>>(() => {
    const borrador = this.borrador();
    const patch: Record<string, unknown> = {};
    const secciones = new Set(
      this.cambios()
        .filter((c) => c.campo !== 'redes')
        .map((c) => c.campo.split('.')[0]),
    );

    for (const seccion of secciones) {
      patch[seccion] = borrador[seccion];
    }
    if (this.redesCambiaron()) {
      // `psw` vacía se omite: el backend conserva la guardada.
      patch['redes'] = this.redes().map((r) =>
        r.psw.length > 0
          ? { ssid: r.ssid, psw: r.psw, prio: r.prio }
          : { ssid: r.ssid, prio: r.prio },
      );
    }
    return patch;
  });

  readonly avisosDeApagado = computed<string[]>(() => {
    const espejo = this.config()?.configuracion ?? null;
    const borrador = this.borrador();
    const avisos: string[] = [];
    for (const [modulo, consecuencia] of Object.entries(CONSECUENCIA_MODULO)) {
      const antes = leer(espejo, `modulos.${modulo}`);
      const ahora = leer(borrador, `modulos.${modulo}`);
      if (antes === true && ahora === false) {
        avisos.push(`Al apagar ${modulo}, ${consecuencia}.`);
      }
    }
    return avisos;
  });

  // ── Acciones ─────────────────────────────────────────────────────

  agregarRed(): void {
    this.redes.update((rs) => [
      ...rs,
      { ssid: '', psw: '', prio: rs.length + 1, tienePassword: false },
    ]);
  }

  quitarRed(i: number): void {
    this.redes.update((rs) => rs.filter((_, j) => j !== i));
  }

  /** Clic en una red del scan: completa el SSID y deja tipear solo la clave. */
  elegirDelScan(indice: number, ssid: string): void {
    this.redes.update((rs) =>
      rs.map((r, i) => (i === indice ? { ...r, ssid } : r)),
    );
  }

  cambiarEscalar(ruta: string, valor: unknown): void {
    const [seccion, campo] = ruta.split('.');
    this.borrador.update((b) => ({
      ...b,
      [seccion]: { ...((b[seccion] as object) ?? {}), [campo]: valor },
    }));
  }

  guardar(): void {
    if (!this.hayCambios() || this.guardando()) return;
    this.guardando.set(true);
    this.error.set(null);

    this.devices.publicarConfig(this.deviceId(), this.patch()).subscribe({
      next: (c) => {
        this.aplicar(c);
        this.aviso.set('Configuración enviada al equipo.');
        this.guardando.set(false);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.guardando.set(false);
      },
    });
  }

  descartar(): void {
    const c = this.config();
    if (c) this.aplicar(c);
  }

  pedirScan(): void {
    this.devices.pedirScan(this.deviceId()).subscribe({
      next: (r) => this.aviso.set(r.mensaje),
      error: (e: unknown) => this.error.set(apiErrorMessage(e)),
    });
  }

  pedirRefresh(): void {
    this.devices.pedirRefresh(this.deviceId()).subscribe({
      next: (r) => this.aviso.set(r.mensaje),
      error: (e: unknown) => this.error.set(apiErrorMessage(e)),
    });
  }

  revelarWifi(): void {
    this.devices.revelarWifi(this.deviceId()).subscribe({
      next: (rs) => this.reveladas.set(rs),
      error: (e: unknown) => this.error.set(apiErrorMessage(e)),
    });
  }

  passwordRevelada(ssid: string): string | null {
    return this.reveladas()?.find((r) => r.ssid === ssid)?.psw ?? null;
  }
}
