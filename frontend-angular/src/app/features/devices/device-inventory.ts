import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AccountsService } from '../../core/api/accounts.service';
import { DevicesService } from '../../core/api/devices.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Account, Device } from '../../core/models/api.models';

/** Cada cuánto se refresca el stock solo. */
const REFRESCO_MS = 20_000;

/**
 * INVENTARIO: control de stock, y nada más.
 *
 * Responde una sola pregunta —qué equipos hay y de quién son— y por eso acá NO
 * se instala nada. Hasta el 2026-08-05 esta pantalla tenía además el formulario
 * de instalación completo, con mapa para clickear dónde va el poste, altura de
 * montaje y punto de energía: trabajo de campo mezclado con control de stock.
 * Eso se mudó a `/alarmas/instalar`.
 *
 * Quedan las dos formas en que un equipo ENTRA a un stock:
 *
 *   ENTREGA (solo CPS)   despacho de un lote: CPS le pasa N equipos a un
 *                        cliente, típicamente antes de que lleguen físicamente.
 *   ADOPCIÓN (por código) la caja que alguien ya tiene en la mano: se carga el
 *                        serial y el código y el equipo pasa a su stock.
 *
 * Conviven porque son dos situaciones reales distintas, no dos caminos para lo
 * mismo.
 */
@Component({
  selector: 'app-device-inventory',
  imports: [FormsModule, ReactiveFormsModule, RouterLink],
  templateUrl: './device-inventory.html',
})
export class DeviceInventory {
  private readonly devices = inject(DevicesService);
  private readonly accounts = inject(AccountsService);
  private readonly fb = inject(FormBuilder);
  protected readonly auth = inject(AuthService);

  protected readonly stock = signal<Device[]>([]);
  protected readonly accountList = signal<Account[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);

  protected readonly search = signal('');

  protected readonly organizations = computed(() =>
    this.accountList().filter((a) => a.type === 'ORGANIZATION'),
  );

  /** Entrega del lote (solo CPS). Los equipos van por `selectedIds`. */
  protected readonly deliverForm = this.fb.group({
    organizationId: [null as number | null, Validators.required],
  });

  /**
   * Adopción por código. `organizationId` solo lo completa CPS: una persona de
   * una organización lo suma a la suya y no hay nada que elegir.
   */
  protected readonly adoptForm = this.fb.nonNullable.group({
    serial: ['', Validators.required],
    claimCode: ['', Validators.required],
    organizationId: [null as number | null],
  });

  constructor() {
    this.load();

    // Se refresca sola. Sin esto, una pestaña abierta desde antes de fabricar o
    // aprobar un equipo no se entera nunca de que el stock cambió, y desde
    // afuera se ve idéntico a que el equipo no existe.
    const tic = setInterval(() => this.traer(), REFRESCO_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(tic));
  }

  private load(): void {
    this.loading.set(true);
    this.traer();
  }

  /** Refresca sin spinner. Lo llama el temporizador. */
  private traer(): void {
    this.devices.inventory().subscribe({
      next: (stock) => {
        this.stock.set(stock);
        this.loading.set(false);
      },
      error: (err) => {
        // En el refresco automático no se pisa un error que estés leyendo.
        if (this.loading()) {
          this.error.set(apiErrorMessage(err));
        }
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

  protected readonly filtered = computed(() => {
    const term = this.search().trim().toLowerCase();
    if (!term) return this.stock();

    return this.stock().filter((d) =>
      [d.serial, d.mac, d.boardNumber, d.name]
        .filter((v): v is string => !!v)
        .some((v) => v.toLowerCase().includes(term)),
    );
  });

  /** Cuántos son de fábrica y cuántos ya tienen dueño. */
  protected readonly resumen = computed(() => {
    const all = this.stock();
    return {
      total: all.length,
      sinDueno: all.filter((d) => d.organizationId === null).length,
      listos: all.filter((d) => d.milestones.readyAt !== null).length,
    };
  });

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

  /**
   * ADOPTAR: sumar al stock propio con serial + código.
   *
   * Solo funciona sobre equipos sin dueño. Si el equipo ya es de alguien, el
   * backend lo rechaza con un mensaje que lo explica — la puerta se cierra
   * apenas el equipo tiene propietario, y eso es lo que impide que alguien
   * fotografíe una etiqueta ajena y se lleve el equipo.
   */
  protected adopt(): void {
    if (this.adoptForm.invalid || this.saving()) {
      this.adoptForm.markAllAsTouched();
      return;
    }

    const { serial, claimCode, organizationId } = this.adoptForm.getRawValue();

    this.saving.set(true);
    this.error.set(null);
    this.message.set(null);

    this.devices
      .adopt({
        serial: serial.trim().toUpperCase(),
        claimCode: claimCode.trim().toUpperCase(),
        organizationId: organizationId ?? undefined,
      })
      .subscribe({
        next: (device) => {
          this.saving.set(false);
          this.adoptForm.reset({ serial: '', claimCode: '', organizationId: null });
          this.message.set(
            `${device.serial} entró al stock. Para ponerlo en servicio, instalalo desde Alarmas.`,
          );
          this.load();
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }
}
