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
import { MapLegend, MapLegendItem } from '../../shared/map/map-legend';

@Component({
  selector: 'app-neighborhood-detail',
  imports: [RouterLink, ReactiveFormsModule, Map, MapLegend],
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

  /** Ubicación elegida clickeando el mapa, todavía sin guardar. */
  protected readonly nuevaUbicacion = signal<{ latitude: number; longitude: number } | null>(null);
  protected readonly savingUbicacion = signal(false);

  /**
   * Quién puede mover el barrio en el mapa: CPS siempre, y el OWNER/ADMIN de la
   * organización dueña SOLO si ella gestiona el barrio. Con `managedBy = 'CPS'`
   * (vendido llave en mano) el cliente lo ve pero no lo opera — el backend
   * responde 403 igual, esto solo evita ofrecer un botón que va a fallar.
   */
  protected readonly puedeEditarUbicacion = computed(() => {
    if (this.auth.isCps()) return true;
    return this.auth.isOrgManager() && this.neighborhood()?.managedBy === 'ORGANIZATION';
  });

  /** El barrio en el mapa (su centro), aparte de las alarmas y las viviendas. */
  protected readonly ubicacionActual = computed<MapMarker[]>(() => {
    const barrio = this.neighborhood();
    if (!barrio) return [];
    return [
      {
        latitude: barrio.latitude,
        longitude: barrio.longitude,
        label: `Centro de ${barrio.name}`,
        variant: 'center' as const,
      },
    ];
  });

  /**
   * Dónde abre el mapa. `app-map` lee `center` una sola vez al inicializarse y
   * después, si hay marcadores, hace fitBounds — así que esto manda sobre todo
   * cuando NO hay nada que encuadrar (barrio recién creado).
   *
   * Desde que las coordenadas del barrio son obligatorias, el único caso sin
   * centro es que el barrio todavía no haya cargado.
   */
  protected readonly centroMapa = computed<[number, number]>(() => {
    const barrio = this.neighborhood();
    if (barrio) return [barrio.latitude, barrio.longitude];
    return [-31.4167, -64.1836]; // Córdoba: el default del componente
  });

  /** CUPOS del barrio (tarifa, solo CPS). */
  protected readonly quotasForm = this.fb.group({
    maxFamilyMembers: [null as number | null],
    communityScopeEnabled: [false],
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
   * El mapa del barrio muestra tres cosas distintas, con colores distintos:
   * las ALARMAS (verde, del barrio), las VIVIENDAS (azul, de los vecinos) y el
   * CENTRO del barrio (naranja, referencia).
   *
   * El mapa NO dice si una alarma está online o disparada: ese dato vive en
   * /devices/:id/state y lo escribe el servicio de alarmas (todavía no existe).
   */
  protected readonly alarmMarkers = computed<MapMarker[]>(() =>
    this.deviceList()
      .filter((d) => d.latitude !== null && d.longitude !== null)
      .map((d) => ({
        latitude: d.latitude as number,
        longitude: d.longitude as number,
        label: `${d.name ?? 'Alarma'} (${d.serial})`,
        variant: 'device' as const,
      })),
  );

  /** Desde 2026-08-02 el GPS de la vivienda es obligatorio: entran todas. */
  protected readonly homeMarkers = computed<MapMarker[]>(() =>
    this.homeList().map((h) => ({
      latitude: h.latitude,
      longitude: h.longitude,
      label: h.address,
      variant: 'home' as const,
    })),
  );

  protected readonly markers = computed<MapMarker[]>(() => [
    ...this.alarmMarkers(),
    ...this.homeMarkers(),
    ...this.ubicacionActual(),
  ]);

  /**
   * Sólo se lista lo que el mapa realmente está dibujando: si el barrio no tiene
   * ubicación propia, no aparece la fila "Centro del barrio". Una leyenda que
   * nombra un color que no está en pantalla confunde igual que una que miente.
   */
  protected readonly leyenda = computed<MapLegendItem[]>(() =>
    (
      [
        { variant: 'device' as const, count: this.alarmMarkers().length },
        { variant: 'home' as const, count: this.homeMarkers().length },
        { variant: 'center' as const, count: this.ubicacionActual().length },
      ] satisfies MapLegendItem[]
    ).filter((item) => item.count > 0),
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
          communityScopeEnabled: neighborhood.communityScopeEnabled,
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

  protected setUbicacion(position: { latitude: number; longitude: number }): void {
    this.nuevaUbicacion.set(position);
  }

  /**
   * Guarda el centro del barrio. Sirve de referencia en los mapas y es el punto
   * de partida cuando se marca una vivienda nueva, así que moverlo es
   * corrección de dato, no una decisión comercial: no pasa por /quotas.
   */
  protected saveUbicacion(): void {
    const position = this.nuevaUbicacion();
    if (!position || this.savingUbicacion()) return;

    this.savingUbicacion.set(true);
    this.error.set(null);
    this.adminMessage.set(null);

    this.neighborhoods.update(this.id, position).subscribe({
      next: (barrio) => {
        this.neighborhood.set(barrio);
        this.nuevaUbicacion.set(null);
        this.savingUbicacion.set(false);
        this.adminMessage.set('Ubicación del barrio actualizada.');
      },
      error: (err) => {
        // 403 típico: el barrio lo gestiona CPS y quien llama es el cliente.
        this.error.set(apiErrorMessage(err));
        this.savingUbicacion.set(false);
      },
    });
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
        communityScopeEnabled: value.communityScopeEnabled ?? false,
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
