import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, forkJoin, of } from 'rxjs';

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
