import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { EMPTY, catchError, forkJoin, of, switchMap, timer } from 'rxjs';

import { DevicesService } from '../../core/api/devices.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Device, DeviceState, Maintenance } from '../../core/models/api.models';
import { Status } from '../../shared/ui/status/status';
import { Map, MapMarker } from '../../shared/map/map';

@Component({
  selector: 'app-device-detail',
  imports: [RouterLink, DatePipe, Map, Status],
  templateUrl: './device-detail.html',
})
export class DeviceDetail {
  private readonly devices = inject(DevicesService);
  private readonly neighborhoods = inject(NeighborhoodsService);
  private readonly route = inject(ActivatedRoute);
  protected readonly auth = inject(AuthService);

  protected readonly id = Number(this.route.snapshot.paramMap.get('id'));

  /**
   * Pestañas dentro de la ficha. Van por signal y no por ruta hija: la pantalla
   * carga UNA alarma y las dos vistas comparten esa carga. Si algún día hace
   * falta dejar el estado abierto en una pantalla de monitoreo con URL propia,
   * pasarlo a rutas hijas es un paso corto.
   */
  protected readonly tab = signal<'ficha' | 'estado'>('ficha');

  protected readonly device = signal<Device | null>(null);
  protected readonly maintenances = signal<Maintenance[]>([]);
  /** null = el servicio de alarmas todavÃ­a no reportÃ³ nada de este equipo. */
  protected readonly state = signal<DeviceState | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly mensaje = signal<string | null>(null);

  /**
   * Error DEL GUARDADO de ubicación, aparte de `error()`: ese es el de la carga
   * de la pantalla y, si se llena, el template reemplaza toda la ficha por un
   * banner. Un 403 al mover un punto no puede hacer desaparecer la alarma.
   */
  protected readonly errorUbicacion = signal<string | null>(null);

  /** Ubicación elegida clickeando el mapa, todavía sin guardar. */
  protected readonly nuevaUbicacion = signal<{ latitude: number; longitude: number } | null>(null);
  protected readonly savingUbicacion = signal(false);

  /** Centro del barrio: dónde abrir el mapa si la alarma todavía no tiene punto. */
  private readonly centroBarrio = signal<[number, number] | null>(null);

  /**
   * Quién puede corregir el punto en el mapa: gestores y TÉCNICOS, de CPS o de
   * la organización dueña — el mismo conjunto que acepta `PATCH /devices/:id`.
   * Un MONITOR mira y no toca.
   *
   * Un equipo en INVENTORY no tiene dónde estar todavía: la ubicación se carga
   * al instalarlo (claim) o después, ya en el barrio.
   */
  protected readonly puedeEditarUbicacion = computed(() => {
    const device = this.device();
    if (!device || device.neighborhoodId === null) return false;
    return this.auth.isManager() || this.auth.isTechnician();
  });

  /**
   * Dónde abre el mapa. `app-map` lee `center` una sola vez al inicializarse;
   * con marcadores hace fitBounds igual, así que esto pesa cuando la alarma
   * NO tiene coordenadas todavía — y ahí lo útil es abrir en su barrio.
   */
  protected readonly centroMapa = computed<[number, number]>(() => {
    const device = this.device();
    if (device?.latitude != null && device.longitude != null) {
      return [device.latitude, device.longitude];
    }
    return this.centroBarrio() ?? [-31.4167, -64.1836]; // Córdoba: default del componente
  });

  /** Ninguno de los cinco cargado: se avisa en vez de mostrar cuatro guiones. */
  protected readonly sinDatosDeInstalacion = computed(() => {
    const d = this.device();
    if (!d) return true;
    return (
      d.poleNumber === null &&
      d.heightM === null &&
      d.reference === null &&
      d.powerPoint === null &&
      d.installNotes === null
    );
  });

  /**
   * Cada cuánto se relee el estado vivo. El panel manda su telemetría cada 300 s
   * por defecto, así que refrescar más seguido no trae dato nuevo — 20 s es para
   * que un cambio de conexión o un disparo se vean casi al toque sin castigar la
   * API. Cuando el backend exponga el `NOTIFY app_panel_state` (que ya existe y
   * ya filtra por cambio real) esto se reemplaza por push y el polling se va.
   */
  private static readonly PERIODO_MS = 20_000;

  /**
   * A partir de cuánto silencio el `online` deja de ser creíble. Son 3 tandas de
   * telemetría (300 s de default en el firmware): con eso, un equipo que en la
   * base figura conectado pero hace 15 minutos que no habla es un dato viejo, no
   * un equipo sano. Pasa si se cae el gateway: nadie lo marca offline y la fila
   * queda congelada diciendo que está todo bien.
   */
  private static readonly SILENCIO_MAX_MIN = 15;

  /**
   * Umbrales de batería, en voltios. PROVISORIOS: salen del comportamiento
   * conocido de una plomo-ácido de 12 V (12,6 V en reposo a plena carga; por
   * debajo de 11,8 V es descarga profunda), que es lo que sugiere el 12.60 que
   * reporta el equipo. NO están confirmados contra la especificación real de la
   * batería — hay que validarlos con quien la eligió antes de colgarles una
   * alerta operativa.
   */
  private static readonly VBAT_BAJO = 12.0;
  private static readonly VBAT_CRITICO = 11.8;

  /** Cuándo se leyó el estado por última vez (el reloj de la web, no del equipo). */
  protected readonly ultimaLectura = signal<Date | null>(null);

  /** El equipo nunca habló: no es que falte el dato, es que todavía no conectó. */
  protected readonly nuncaConecto = computed(
    () => this.device()?.milestones.firstConnectionAt === null,
  );

  /** Minutos desde que el equipo habló por última vez. */
  protected readonly minutosDeSilencio = computed<number | null>(() => {
    const vivo = this.state();
    const ultimo = vivo?.lastSeen ?? vivo?.lastHeartbeat;
    if (!ultimo) return null;
    return Math.floor((Date.now() - new Date(ultimo).getTime()) / 60_000);
  });

  /**
   * Figura conectado pero hace rato que no habla. Se avisa en vez de mostrar el
   * badge verde a secas: un "online" congelado es peor que no tener dato, porque
   * se le cree.
   */
  protected readonly datoDudoso = computed(() => {
    const minutos = this.minutosDeSilencio();
    return (
      this.state()?.online === true && minutos !== null && minutos >= DeviceDetail.SILENCIO_MAX_MIN
    );
  });

  protected readonly vbat = computed<number | null>(() => {
    const crudo = this.state()?.vbat;
    if (crudo == null) return null;
    const valor = Number(crudo);
    return Number.isFinite(valor) ? valor : null;
  });

  /** Semáforo de batería. null = sin dato; ver la nota de los umbrales. */
  protected readonly nivelBateria = computed<'ok' | 'baja' | 'critica' | null>(() => {
    const valor = this.vbat();
    if (valor === null) return null;
    if (valor < DeviceDetail.VBAT_CRITICO) return 'critica';
    if (valor < DeviceDetail.VBAT_BAJO) return 'baja';
    return 'ok';
  });

  protected readonly markers = computed<MapMarker[]>(() => {
    const device = this.device();
    if (!device || device.latitude === null || device.longitude === null) {
      return [];
    }
    return [
      {
        latitude: device.latitude,
        longitude: device.longitude,
        label: device.name ?? device.serial,
      },
    ];
  });

  constructor() {
    forkJoin({
      device: this.devices.get(this.id),
      maintenances: this.devices.maintenances(this.id),
      // El estado vivo puede fallar o venir vacÃ­o sin romper la pantalla.
      state: this.devices.state(this.id).pipe(catchError(() => of(null))),
    }).subscribe({
      next: ({ device, maintenances, state }) => {
        this.device.set(device);
        this.maintenances.set(maintenances);
        this.state.set(state);
        this.loading.set(false);

        // Solo para encuadrar el mapa cuando la alarma no tiene punto: si
        // falla, el mapa abre en el default y no se rompe nada.
        if (device.neighborhoodId !== null) {
          this.neighborhoods
            .get(device.neighborhoodId)
            .pipe(catchError(() => of(null)))
            .subscribe((barrio) => {
              if (barrio?.latitude != null && barrio.longitude != null) {
                this.centroBarrio.set([barrio.latitude, barrio.longitude]);
              }
            });
        }
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });

    /**
     * El estado se recarga solo, pero SOLO con la pestaña abierta: dejar la
     * ficha en pantalla no tiene por qué generar tráfico cada 20 segundos.
     * Cambiar de pestaña corta el timer (switchMap) y volver lo reinicia con una
     * lectura inmediata.
     *
     * Un error no rompe la vista ni corta el ciclo: se conserva la última
     * lectura buena y se vuelve a intentar en el próximo tick. Un pico de la API
     * no puede dejar la pantalla de monitoreo en blanco.
     */
    toObservable(this.tab)
      .pipe(
        switchMap((tab) =>
          tab === 'estado'
            ? timer(0, DeviceDetail.PERIODO_MS).pipe(
                switchMap(() => this.devices.state(this.id).pipe(catchError(() => EMPTY))),
              )
            : EMPTY,
        ),
        takeUntilDestroyed(),
      )
      .subscribe((state) => {
        this.state.set(state);
        this.ultimaLectura.set(new Date());
      });
  }

  protected setUbicacion(position: { latitude: number; longitude: number }): void {
    this.nuevaUbicacion.set(position);
  }

  /**
   * Corrige dónde está el poste. Es dato de instalación, no estado del equipo:
   * no toca `status` ni pasa por los hitos de fábrica.
   */
  protected saveUbicacion(): void {
    const position = this.nuevaUbicacion();
    if (!position || this.savingUbicacion()) return;

    this.savingUbicacion.set(true);
    this.errorUbicacion.set(null);
    this.mensaje.set(null);

    this.devices.update(this.id, position).subscribe({
      next: (device) => {
        this.device.set(device);
        this.nuevaUbicacion.set(null);
        this.savingUbicacion.set(false);
        this.mensaje.set('Ubicación de la alarma actualizada.');
      },
      error: (err) => {
        this.errorUbicacion.set(apiErrorMessage(err));
        this.savingUbicacion.set(false);
      },
    });
  }
}
