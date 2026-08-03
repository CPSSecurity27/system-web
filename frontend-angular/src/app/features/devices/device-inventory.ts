import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { AccountsService } from '../../core/api/accounts.service';
import { DevicesService } from '../../core/api/devices.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Account, Device } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';
import { Map } from '../../shared/map/map';

/**
 * Stock e instalación (nuevo en v2). Custodia en 3 niveles:
 * fábrica CPS → stock de la organización → instalada en un barrio.
 *
 * CPS ve TODO el stock y entrega lotes; la organización ve el SUYO y lo
 * instala en SUS barrios reclamando (serial + claim code de un solo uso).
 */
@Component({
  selector: 'app-device-inventory',
  imports: [ReactiveFormsModule, RouterLink, Map],
  templateUrl: './device-inventory.html',
})
export class DeviceInventory {
  private readonly devices = inject(DevicesService);
  private readonly accounts = inject(AccountsService);
  private readonly neighborhoods = inject(NeighborhoodsService);
  private readonly fb = inject(FormBuilder);
  protected readonly auth = inject(AuthService);

  /** Ubicación del poste elegida clickeando el mapa (opcional). */
  protected readonly latitude = signal<number | null>(null);
  protected readonly longitude = signal<number | null>(null);

  protected readonly stock = signal<Device[]>([]);
  protected readonly barrios = signal<Neighborhood[]>([]);
  protected readonly accountList = signal<Account[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);

  protected readonly organizations = computed(() =>
    this.accountList().filter((a) => a.type === 'ORGANIZATION'),
  );

  /** Entrega del lote (solo CPS): qué equipo, a qué organización. */
  /** Los equipos van por `selectedIds` (un `<select multiple>`), no por acá. */
  protected readonly deliverForm = this.fb.group({
    organizationId: [null as number | null, Validators.required],
  });

  /** Instalación por claim: serial + código + barrio destino. */
  protected readonly claimForm = this.fb.nonNullable.group({
    serial: ['', Validators.required],
    claimCode: ['', Validators.required],
    neighborhoodId: [null as number | null, Validators.required],
    name: [''],
    // Datos de instalación: OPCIONALES pero recomendados. El mejor momento
    // para cargarlos es este, con el técnico parado abajo del poste.
    poleNumber: [''],
    heightM: [null as number | null],
    reference: [''],
    powerPoint: [''],
    installNotes: [''],
  });

  constructor() {
    this.load();
  }

  private load(): void {
    this.loading.set(true);

    forkJoin({
      stock: this.devices.inventory(),
      barrios: this.neighborhoods.list(),
    }).subscribe({
      next: ({ stock, barrios }) => {
        this.stock.set(stock);
        this.barrios.set(barrios);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });

    if (this.auth.isCps()) {
      this.accounts.list().subscribe({
        next: (accounts) => this.accountList.set(accounts),
        error: () => this.accountList.set([]),
      });
    }
  }

  protected orgName(id: number | null): string {
    if (id === null) return 'Fábrica CPS';
    return this.accountList().find((a) => a.id === id)?.name ?? `Organización #${id}`;
  }

  /** Los equipos tildados para la entrega. El `<select multiple>` no va por form. */
  protected readonly selectedIds = signal<number[]>([]);

  protected onSelectionChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.selectedIds.set(Array.from(select.selectedOptions).map((o) => Number(o.value)));
  }

  /**
   * ENTREGA DE LOTE: una sola llamada para N equipos. El backend la hace
   * atómica — o van todos o no va ninguno — así que no puede quedar media tanda
   * entregada si algo falla en el medio.
   */
  protected deliver(): void {
    const ids = this.selectedIds();
    if (this.deliverForm.invalid || this.saving() || ids.length === 0) {
      this.deliverForm.markAllAsTouched();
      return;
    }

    const { organizationId } = this.deliverForm.getRawValue();

    this.saving.set(true);
    this.error.set(null);
    this.message.set(null);

    this.devices.deliver({ deviceIds: ids, organizationId: organizationId as number }).subscribe({
      next: ({ delivered }) => {
        this.saving.set(false);
        this.deliverForm.reset({ organizationId: null });
        this.selectedIds.set([]);
        this.message.set(
          `${delivered} ${delivered === 1 ? 'equipo entregado' : 'equipos entregados'} al stock de ${this.orgName(organizationId as number)}.`,
        );
        this.load();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  protected setPosition(position: { latitude: number; longitude: number }): void {
    this.latitude.set(position.latitude);
    this.longitude.set(position.longitude);
  }

  protected clearPosition(): void {
    this.latitude.set(null);
    this.longitude.set(null);
  }

  protected claim(): void {
    if (this.claimForm.invalid || this.saving()) {
      this.claimForm.markAllAsTouched();
      return;
    }

    const value = this.claimForm.getRawValue();

    this.saving.set(true);
    this.error.set(null);
    this.message.set(null);

    this.devices
      .claim({
        serial: value.serial.trim(),
        claimCode: value.claimCode.trim(),
        neighborhoodId: value.neighborhoodId as number,
        name: value.name.trim() ? value.name.trim() : undefined,
        latitude: this.latitude() ?? undefined,
        longitude: this.longitude() ?? undefined,
        // Solo se mandan los que se completaron: el vacío no es un dato.
        poleNumber: value.poleNumber.trim() || undefined,
        heightM: value.heightM ?? undefined,
        reference: value.reference.trim() || undefined,
        powerPoint: value.powerPoint.trim() || undefined,
        installNotes: value.installNotes.trim() || undefined,
      })
      .subscribe({
        next: (device) => {
          this.saving.set(false);
          this.claimForm.reset({
            serial: '',
            claimCode: '',
            neighborhoodId: null,
            name: '',
            poleNumber: '',
            heightM: null,
            reference: '',
            powerPoint: '',
            installNotes: '',
          });
          this.clearPosition();
          this.message.set(
            `Equipo ${device.serial} instalado en el barrio. El código quedó quemado.`,
          );
          this.load();
        },
        error: (err) => {
          // 403: código equivocado o stock ajeno. El mensaje del backend manda.
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }
}
