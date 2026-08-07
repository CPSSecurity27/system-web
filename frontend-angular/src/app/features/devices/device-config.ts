import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { DevicesService } from '../../core/api/devices.service';
import { sondearMientras } from '../../core/sondeo';
import { apiErrorMessage } from '../../core/http/api-error';
import {
  DeviceConfig,
  DeviceState,
  FuenteConfig,
  RedWifiRevelada,
} from '../../core/models/api.models';

/** Una red en el formulario. `psw` vacía = conservar la que ya tiene el panel. */
export interface RedEditable {
  ssid: string;
  psw: string;
  prio: number;
  tienePassword: boolean;
  bloqueada: boolean;
}

interface Cambio {
  campo: string;
  /** Cómo se lee en la pantalla. El `campo` sigue siendo la ruta del JSON. */
  etiqueta: string;
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

/**
 * Los 7 modos con auto-apagado, con el slug EXACTO del firmware.
 *
 * Las etiquetas son nuestras y se pueden cambiar; los slugs no, y por eso van
 * visibles al lado: son los mismos que aparecen en `event.trigger_mode` y en el
 * `cfg_full`, así que alguien mirando la base tiene que poder atar las dos
 * puntas sin adivinar.
 */
export const MODOS_AUTOOFF = [
  { slug: 'suspicious', label: 'Sospechoso' },
  { slug: 'alert', label: 'Alerta' },
  { slug: 'emergency', label: 'Emergencia' },
  { slug: 'fire', label: 'Incendio' },
  { slug: 'medical', label: 'Médica' },
  { slug: 'silent', label: 'Silenciosa' },
  { slug: 'panic', label: 'Pánico' },
] as const;

/** Campos escalares que se comparan para el diff, con su ruta en el JSON. */
const CAMPOS_ESCALARES = [
  'tiempos.send_tele_s',
  'hora.tz_offset_s',
  'mante.on',
  'modulos.ds3231',
  'modulos.eeprom',
  'modulos.supervisor',
  'modulos.rf',
  'modulos.eeprom_slot',
  'red_avanzada.roam_rssi',
  'red_avanzada.roam_delta',
  'red_avanzada.roam_cooldown_s',
  ...MODOS_AUTOOFF.map((m) => `alarma.autooff.${m.slug}`),
];

/**
 * Cómo se lee cada ruta en el diff.
 *
 * Sin esto, cambiar dos auto-apagados mostraba `alarma.autooff.fire` y
 * `alarma.autooff.silent` — que es el JSON, no el idioma en el que trabaja
 * quien está por apretar Guardar.
 */
const ETIQUETAS: Record<string, string> = {
  'tiempos.send_tele_s': 'Telemetría cada (s)',
  'hora.tz_offset_s': 'Huso horario (s)',
  'mante.on': 'Modo mantenimiento',
  'modulos.ds3231': 'Módulo reloj (ds3231)',
  'modulos.eeprom': 'Módulo memoria (eeprom)',
  'modulos.supervisor': 'Módulo supervisor',
  'modulos.rf': 'Módulo RF (controles remotos)',
  'modulos.eeprom_slot': 'Slot de memoria activo',
  'red_avanzada.roam_rssi': 'Roaming · RSSI de cambio',
  'red_avanzada.roam_delta': 'Roaming · diferencia mínima',
  'red_avanzada.roam_cooldown_s': 'Roaming · espera entre cambios (s)',
  redes: 'Redes WiFi',
  ...Object.fromEntries(
    MODOS_AUTOOFF.map((m) => [`alarma.autooff.${m.slug}`, `Auto-apagado · ${m.label} (s)`]),
  ),
};

/** Lee una ruta de cualquier profundidad: `alarma.autooff.fire`. */
function leer(objeto: Record<string, unknown> | null, ruta: string): unknown {
  let actual: unknown = objeto;
  for (const clave of ruta.split('.')) {
    if (typeof actual !== 'object' || actual === null) return undefined;
    actual = (actual as Record<string, unknown>)[clave];
  }
  return actual;
}

/** Escribe una ruta de cualquier profundidad SIN mutar: el borrador es un signal. */
function escribir(
  objeto: Record<string, unknown>,
  ruta: string[],
  valor: unknown,
): Record<string, unknown> {
  const [clave, ...resto] = ruta;
  if (resto.length === 0) return { ...objeto, [clave]: valor };

  const sub = objeto[clave];
  const base =
    typeof sub === 'object' && sub !== null && !Array.isArray(sub)
      ? (sub as Record<string, unknown>)
      : {};
  return { ...objeto, [clave]: escribir(base, resto, valor) };
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

  /** Para el `@for` de la plantilla. */
  readonly modosAutooff = MODOS_AUTOOFF;

  readonly config = signal<DeviceConfig | null>(null);
  readonly borrador = signal<Record<string, unknown>>({});
  readonly redes = signal<RedEditable[]>([]);
  readonly cargando = signal(true);
  readonly guardando = signal(false);
  readonly error = signal<string | null>(null);
  readonly aviso = signal<string | null>(null);
  readonly reveladas = signal<RedWifiRevelada[] | null>(null);
  /** Otros postes del mismo barrio de los que se puede copiar. */
  readonly fuentes = signal<FuenteConfig[]>([]);
  readonly copiadoDe = signal<number | null>(null);

  /**
   * Lo que le pedimos al equipo y todavía no volvió.
   *
   * El resultado de un scan o de un refresh llega DESPUÉS y por otro camino
   * (panel → broker → GtD → base), así que la pantalla no se entera sola. Antes
   * había que apretar F5: el escaneo ya estaba en la base y acá se seguía viendo
   * la lista vieja.
   */
  readonly esperando = signal<'scan' | 'refresh' | null>(null);
  /** Para saber si el scan que llegó es el que pedimos, y no el de hace un rato. */
  private scanPrevio: string | null = null;

  constructor() {
    effect(() => {
      const id = this.deviceId();
      this.cargar(id);
    });

    // Mientras haya algo en vuelo, repreguntar. Se corta solo al llegar la
    // respuesta o al vencer el tope.
    sondearMientras(
      () => this.esperando() !== null,
      () => this.cargar(this.deviceId()),
    );
  }

  private cargar(id: number): void {
    this.cargando.set(true);
    this.devices.fuentesDeConfig(id).subscribe({
      next: (fs) => this.fuentes.set(fs),
      // Sin fuentes la pantalla funciona igual: es un atajo, no un requisito.
      error: () => this.fuentes.set([]),
    });
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
    // ¿Llegó lo que estábamos esperando? El scan trae su propia fecha, así que
    // se compara contra la que había — un scan viejo no cuenta como respuesta.
    const scanNuevo = c.ultimoScan?.recibidoEn ?? null;
    if (this.esperando() === 'scan' && scanNuevo !== this.scanPrevio) {
      this.esperando.set(null);
      this.aviso.set('El equipo mandó las redes que ve.');
    } else if (this.esperando() === 'refresh' && c.estado === 'VERIFICADO') {
      this.esperando.set(null);
      this.aviso.set('El equipo reportó su configuración.');
    }
    this.scanPrevio = scanNuevo;

    this.config.set(c);
    this.borrador.set(structuredClone(c.configuracion ?? {}));
    this.redes.set(
      c.redes.map((r) => ({
        ssid: r.ssid,
        psw: '',
        prio: r.prio,
        tienePassword: r.tienePassword,
        bloqueada: r.bloqueada,
      })),
    );
    this.reveladas.set(null);
    this.copiadoDe.set(null);
  }

  // ── Estado de la pantalla ────────────────────────────────────────

  /** Sin espejo no se puede editar: un patch a ciegas apagaría módulos. */
  readonly bloqueado = computed(() => {
    const c = this.config();
    return !c || c.estado === 'SIN_ESPEJO' || !c.puedeEditar;
  });

  readonly sinEspejo = computed(() => this.config()?.estado === 'SIN_ESPEJO');

  /**
   * El equipo volvió a fábrica: lo que se ve NO es lo que corre. Se puede
   * editar igual —publicar es justamente cómo se lo devuelve a su
   * configuración— pero la pantalla tiene que decir que está mirando el pasado.
   */
  readonly desactualizada = computed(() => this.config()?.estado === 'DESACTUALIZADA');

  readonly durmiendo = computed(() => {
    const hasta = this.estadoVivo()?.sleepUntil;
    return hasta !== null && hasta !== undefined && new Date(hasta) > new Date();
  });

  readonly puedeEscanear = computed(
    () => !this.bloqueado() && this.estadoVivo()?.online === true && !this.durmiendo(),
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
        lista.push({
          campo: ruta,
          etiqueta: ETIQUETAS[ruta] ?? ruta,
          de: String(antes),
          a: String(ahora),
        });
      }
    }

    if (this.redesCambiaron()) {
      lista.push({
        campo: 'redes',
        etiqueta: ETIQUETAS['redes'],
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
      (r, i) => r.ssid !== originales[i].ssid || r.prio !== originales[i].prio || r.psw.length > 0,
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
      {
        ssid: '',
        psw: '',
        prio: rs.length + 1,
        tienePassword: false,
        bloqueada: false,
      },
    ]);
  }

  quitarRed(i: number): void {
    this.redes.update((rs) => rs.filter((_, j) => j !== i));
  }

  /**
   * Las redes que vio el equipo, de la más fuerte a la más débil y SIN las que
   * ya están cargadas.
   *
   * Antes esta lista se dibujaba adentro del `@for` de las redes configuradas,
   * o sea que se repetía entera debajo de cada fila: con 2 redes cargadas y 8
   * vistas eran 16 links en dos párrafos corridos. Va una sola vez.
   */
  readonly redesVistas = computed(() => {
    const cargadas = new Set(
      this.redes()
        .map((r) => r.ssid.trim())
        .filter(Boolean),
    );
    return (this.config()?.ultimoScan?.redes ?? [])
      .filter((v) => !cargadas.has(v.ssid))
      .sort((a, b) => b.rssi - a.rssi);
  });

  /**
   * El dBm traducido. -65 no le dice nada a nadie; "buena" sí.
   *
   * Los cortes son los de uso corriente en WiFi: por debajo de -80 el enlace
   * existe pero se cae solo, y eso sobre un poste en la calle es la diferencia
   * entre un equipo que reporta y uno que aparece caído todas las noches.
   */
  calidad(rssi: number): { texto: string; clase: string } {
    if (rssi >= -60) return { texto: 'excelente', clase: 'text-success' };
    if (rssi >= -70) return { texto: 'buena', clase: 'text-success' };
    if (rssi >= -80) return { texto: 'regular', clase: 'text-warning' };
    return { texto: 'débil', clase: 'text-danger' };
  }

  /**
   * Sumar una red vista por el equipo: entra como fila nueva con el SSID puesto
   * y el foco listo para la clave, que es lo único que falta.
   *
   * Si ya se llegó al tope de 5 no hace nada: el botón está deshabilitado, pero
   * la lista de vistas sigue a la vista y alguien puede clickear igual.
   */
  sumarDelScan(ssid: string): void {
    if (this.redes().length >= 5) return;
    this.redes.update((rs) => [
      ...rs,
      {
        ssid,
        psw: '',
        prio: rs.length + 1,
        tienePassword: false,
        bloqueada: false,
      },
    ]);
  }

  cambiarEscalar(ruta: string, valor: unknown): void {
    this.borrador.update((b) => escribir(b, ruta.split('.'), valor));
  }

  /** El valor que hay que pintar en un input, leyendo el borrador. */
  valor(ruta: string): unknown {
    return leer(this.borrador(), ruta);
  }

  /**
   * El huso horario se edita en HORAS aunque viaje en segundos.
   *
   * Es el único campo cuyo error no vuelve: fuera de ±14 h el firmware descarta
   * la cfg entera sin mandar ack, y la pantalla se queda esperando para
   * siempre. Con un campo en segundos, escribir `-3` pensando en horas es un
   * huso de tres segundos que el backend acepta —está en rango— y que deja el
   * reloj del equipo mal sin que nada avise. En horas, `-3` es lo correcto.
   */
  readonly tzHoras = computed<number | null>(() => {
    const segundos = leer(this.borrador(), 'hora.tz_offset_s');
    return typeof segundos === 'number' ? segundos / 3600 : null;
  });

  cambiarTzHoras(horas: number): void {
    if (!Number.isFinite(horas)) return;
    this.cambiarEscalar('hora.tz_offset_s', Math.round(horas * 3600));
  }

  /** Solo lectura del espejo: `rf.total_codigos`, `cal.bat.m`, `id.fw`… */
  readonly soloLectura = computed(() => {
    const espejo = this.config()?.configuracion ?? null;
    const numero = (ruta: string) => {
      const v = leer(espejo, ruta);
      return typeof v === 'number' ? v : null;
    };
    return {
      fw: typeof leer(espejo, 'id.fw') === 'string' ? String(leer(espejo, 'id.fw')) : null,
      rfCodigos: numero('rf.total_codigos'),
      rfGen: numero('rf.gen'),
      calibraciones: (['bat', 'panel', 'fuente'] as const)
        .map((canal) => ({
          canal,
          m: numero(`cal.${canal}.m`),
          b: numero(`cal.${canal}.b`),
        }))
        .filter((c) => c.m !== null),
    };
  });

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
      next: (r) => {
        this.aviso.set(r.mensaje);
        this.esperando.set('scan');
      },
      error: (e: unknown) => this.error.set(apiErrorMessage(e)),
    });
  }

  pedirRefresh(): void {
    this.devices.pedirRefresh(this.deviceId()).subscribe({
      next: (r) => {
        this.aviso.set(r.mensaje);
        this.esperando.set('refresh');
      },
      error: (e: unknown) => this.error.set(apiErrorMessage(e)),
    });
  }

  // ── Copiar de otro equipo ────────────────────────────────────────

  /**
   * Precarga el formulario con la configuración de otro poste del mismo barrio.
   *
   * Es un atajo de tipeo y NADA MÁS: no guarda, no deja vínculo, y cambiar el
   * original después no toca a la copia. Existe porque no hay configuración por
   * barrio y cargar 40 postes con el mismo WiFi municipal es cargarlo 40 veces.
   *
   * Las contraseñas NO se copian —no se leen por ningún lado—, así que las redes
   * traídas llegan vacías y hay que escribirlas. Es el precio de que el GET
   * nunca devuelva una password, y es el correcto.
   */
  copiarDe(deviceId: number): void {
    if (!deviceId) return;
    this.error.set(null);

    this.devices.config(deviceId).subscribe({
      next: (otro) => {
        if (!otro.configuracion) {
          this.error.set('Ese equipo todavía no reportó su configuración.');
          return;
        }
        // El espejo del OTRO equipo, pero SIN su identidad: alias, ubicación y
        // grupo se generan por equipo. Copiarlos dejaría dos postes con el
        // mismo nombre adentro del firmware.
        const copia = structuredClone(otro.configuracion);
        delete copia['id'];
        delete copia['rf'];
        delete copia['cal'];
        delete copia['central'];

        this.borrador.update((b) => ({ ...b, ...copia }));
        this.redes.set(
          otro.redes.map((r) => ({
            ssid: r.ssid,
            psw: '',
            prio: r.prio,
            tienePassword: false,
            bloqueada: false,
          })),
        );
        this.copiadoDe.set(otro.deviceId);
        this.aviso.set(
          'Configuración traída. Revisá el resumen de cambios y cargá las ' +
            'contraseñas WiFi: esas no se copian.',
        );
      },
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
