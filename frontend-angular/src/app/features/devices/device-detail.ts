import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, forkJoin, of } from 'rxjs';

import { DevicesService } from '../../core/api/devices.service';
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
  private readonly route = inject(ActivatedRoute);

  protected readonly id = Number(this.route.snapshot.paramMap.get('id'));

  protected readonly device = signal<Device | null>(null);
  protected readonly maintenances = signal<Maintenance[]>([]);
  /** null = el servicio de alarmas todavÃ­a no reportÃ³ nada de este equipo. */
  protected readonly state = signal<DeviceState | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

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
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }
}
