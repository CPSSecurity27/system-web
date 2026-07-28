import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { AccountsService } from '../../core/api/accounts.service';
import { DevicesService } from '../../core/api/devices.service';
import { HomesService } from '../../core/api/homes.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Account, Device, Home } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';
import { Map, MapMarker } from '../../shared/map/map';

@Component({
  selector: 'app-neighborhood-detail',
  imports: [RouterLink, ReactiveFormsModule, Map],
  templateUrl: './neighborhood-detail.html',
})
export class NeighborhoodDetail {
  private readonly neighborhoods = inject(NeighborhoodsService);
  private readonly homes = inject(HomesService);
  private readonly devices = inject(DevicesService);
  private readonly accounts = inject(AccountsService);
  private readonly route = inject(ActivatedRoute);
  private readonly fb = inject(FormBuilder);
  protected readonly auth = inject(AuthService);

  protected readonly id = Number(this.route.snapshot.paramMap.get('id'));

  protected readonly neighborhood = signal<Neighborhood | null>(null);
  protected readonly homeList = signal<Home[]>([]);
  protected readonly deviceList = signal<Device[]>([]);
  protected readonly accountList = signal<Account[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly adminMessage = signal<string | null>(null);
  protected readonly savingQuotas = signal(false);
  protected readonly transferring = signal(false);

  /** CUPOS del barrio (tarifa, solo CPS). */
  protected readonly quotasForm = this.fb.group({
    maxFamilyMembers: [null as number | null],
    remoteControlsEnabled: [false],
  });

  /** Transferencia de comunidad (solo CPS): la operación más sensible. */
  protected readonly transferForm = this.fb.group({
    organizationId: [null as number | null, Validators.required],
  });

  protected readonly organizations = computed(() =>
    this.accountList().filter(
      (a) => a.type === 'ORGANIZATION' && a.id !== this.neighborhood()?.organizationId,
    ),
  );

  protected readonly ownerName = computed(() => {
    const barrio = this.neighborhood();
    if (!barrio) return '';
    return (
      this.accountList().find((a) => a.id === barrio.organizationId)?.name ??
      `Organización #${barrio.organizationId}`
    );
  });

  /**
   * Solo se mapean las alarmas con coordenadas. El mapa NO dice si una alarma
   * está online o disparada: ese dato vive en /devices/:id/state y lo escribe
   * el servicio de alarmas (todavía no existe).
   */
  protected readonly markers = computed<MapMarker[]>(() =>
    this.deviceList()
      .filter((d) => d.latitude !== null && d.longitude !== null)
      .map((d) => ({
        latitude: d.latitude as number,
        longitude: d.longitude as number,
        label: `${d.name ?? 'Alarma'} (${d.serial})`,
      })),
  );

  protected readonly withoutCoordinates = computed(
    () => this.deviceList().filter((d) => d.latitude === null || d.longitude === null).length,
  );

  constructor() {
    forkJoin({
      neighborhood: this.neighborhoods.get(this.id),
      homes: this.homes.list(this.id),
      devices: this.devices.list(this.id),
    }).subscribe({
      next: ({ neighborhood, homes, devices }) => {
        this.neighborhood.set(neighborhood);
        this.homeList.set(homes);
        this.deviceList.set(devices);
        this.quotasForm.reset({
          maxFamilyMembers: neighborhood.maxFamilyMembers,
          remoteControlsEnabled: neighborhood.remoteControlsEnabled,
        });
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });

    // La lista de cuentas es de gestión: el vecino no la necesita (ni puede).
    if (this.auth.isCps()) {
      this.accounts.list().subscribe({
        next: (accounts) => this.accountList.set(accounts),
        error: () => this.accountList.set([]),
      });
    }
  }

  protected saveQuotas(): void {
    if (this.savingQuotas()) return;

    const value = this.quotasForm.getRawValue();

    this.savingQuotas.set(true);
    this.error.set(null);
    this.adminMessage.set(null);

    this.neighborhoods
      .updateQuotas(this.id, {
        ...(value.maxFamilyMembers !== null ? { maxFamilyMembers: value.maxFamilyMembers } : {}),
        remoteControlsEnabled: value.remoteControlsEnabled ?? false,
      })
      .subscribe({
        next: (barrio) => {
          this.neighborhood.set(barrio);
          this.savingQuotas.set(false);
          this.adminMessage.set('Cupos del barrio actualizados (auditado).');
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.savingQuotas.set(false);
        },
      });
  }

  protected transfer(): void {
    if (this.transferForm.invalid || this.transferring()) {
      this.transferForm.markAllAsTouched();
      return;
    }

    this.transferring.set(true);
    this.error.set(null);
    this.adminMessage.set(null);

    this.neighborhoods
      .transfer(this.id, this.transferForm.getRawValue().organizationId as number)
      .subscribe({
        next: (barrio) => {
          this.neighborhood.set(barrio);
          this.transferring.set(false);
          this.transferForm.reset({ organizationId: null });
          this.adminMessage.set('Comunidad transferida. Hogares, vecinos y equipos intactos.');
        },
        error: (err) => {
          // 400 típico: el cupo de barrios del destino está lleno (ampliar primero).
          this.error.set(apiErrorMessage(err));
          this.transferring.set(false);
        },
      });
  }
}
