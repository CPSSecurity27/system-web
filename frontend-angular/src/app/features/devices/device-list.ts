import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { DevicesService } from '../../core/api/devices.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Device } from '../../core/models/api.models';
import { Status } from '../../shared/ui/status/status';
import { Neighborhood } from '../../core/models/neighborhood';

@Component({
  selector: 'app-device-list',
  imports: [RouterLink, FormsModule, Status],
  templateUrl: './device-list.html',
})
export class DeviceList {
  private readonly devices = inject(DevicesService);
  private readonly neighborhoods = inject(NeighborhoodsService);
  protected readonly auth = inject(AuthService);

  protected readonly items = signal<Device[]>([]);
  protected readonly barrios = signal<Neighborhood[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected filter: number | '' = '';

  constructor() {
    forkJoin({
      devices: this.devices.list(),
      barrios: this.neighborhoods.list(),
    }).subscribe({
      next: ({ devices, barrios }) => {
        this.items.set(devices);
        this.barrios.set(barrios);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected onFilterChange(): void {
    this.loading.set(true);
    this.error.set(null);

    this.devices.list(this.filter === '' ? undefined : Number(this.filter)).subscribe({
      next: (devices) => {
        this.items.set(devices);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected barrioName(id: number | null): string {
    if (id === null) return 'En stock';
    return this.barrios().find((b) => b.id === id)?.name ?? `Barrio #${id}`;
  }
}
