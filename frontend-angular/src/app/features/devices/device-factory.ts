import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { DevicesService } from '../../core/api/devices.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { BoardModel, Device, DeviceStage } from '../../core/models/api.models';

/**
 * FÁBRICA de alarmas (solo CPS): el punto por donde un equipo ENTRA al sistema.
 *
 * Acá no se decide destino: ni a qué organización va ni en qué barrio se
 * instala. Eso pasa después y en otro lado (la entrega, desde la cuenta; la
 * instalación por claim, desde el barrio). Lo único que importa en esta
 * pantalla es que el equipo quede registrado con su identidad física.
 *
 * Los dos datos obligatorios se LEEN de la placa, no se inventan:
 *   MAC          `esptool read_mac` en la estación de flasheo
 *   N° de placa  impreso por el fabricante, `ALOY0043`
 *
 * El `serial` no se pide: lo deriva el backend como `AV-<12 hex>`.
 *
 * Está pensada para uso en TANDA — se cargan placas una atrás de otra —, así
 * que el alta y el listado conviven en la misma pantalla y el foco vuelve solo
 * al campo de la MAC después de cada alta. Navegar entre dos rutas por equipo
 * sería fricción pura en una estación que se usa todo el día.
 */
@Component({
  selector: 'app-device-factory',
  imports: [ReactiveFormsModule, FormsModule, RouterLink],
  templateUrl: './device-factory.html',
})
export class DeviceFactory {
  private readonly devices = inject(DevicesService);
  private readonly fb = inject(FormBuilder);

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** El último equipo fabricado: su claim code se muestra UNA vez, acá. */
  protected readonly created = signal<Device | null>(null);
  protected readonly boardModels = signal<BoardModel[]>([]);
  protected readonly items = signal<Device[]>([]);

  /** Filtros del listado (el buscador es sobre MAC, serial o n° de placa). */
  protected readonly search = signal('');
  /**
   * Se filtra por ETAPA DE PUESTA EN MARCHA, no por dónde está el equipo: en
   * fábrica la pregunta es "¿qué me falta terminar?", no "¿de quién es?".
   */
  protected readonly stage = signal<'' | DeviceStage>('');

  /** Marcando hitos: el id del equipo, para no bloquear la tabla entera. */
  protected readonly marking = signal<number | null>(null);

  protected readonly form = this.fb.group({
    // Permisivo a propósito: con o sin ':'/'-' y en cualquier caja, tal como
    // sale de `esptool`. La validación de verdad (ceros, broadcast, multicast)
    // es del backend, que es el único lugar donde no se puede saltear.
    mac: [
      '',
      [Validators.required, Validators.pattern(/^[0-9A-Fa-f]{2}([:-]?[0-9A-Fa-f]{2}){5}$/)],
    ],
    boardNumber: ['', [Validators.required, Validators.pattern(/^[A-Za-z]{2,8}\d{1,4}$/)]],
    tested: [false],
  });

  /**
   * "Todo lo fabricado" son dos endpoints: `/devices/inventory` (lo que sigue
   * en stock) y `/devices` (lo que ya se instaló). El backend no expone un
   * listado único, y para CPS la unión de ambos ES el universo de equipos.
   */
  constructor() {
    this.reload();

    this.devices.boardModels().subscribe({
      next: (models) => this.boardModels.set(models),
      error: () => this.boardModels.set([]),
    });
  }

  protected readonly prefixes = computed(() =>
    this.boardModels()
      .filter((m) => m.active)
      .map((m) => m.code)
      .join(', '),
  );

  protected readonly filtered = computed(() => {
    const term = this.search().trim().toLowerCase();
    const stage = this.stage();

    return this.items().filter((device) => {
      if (stage && device.stage !== stage) {
        return false;
      }
      if (!term) {
        return true;
      }
      return [device.serial, device.mac, device.boardNumber, device.name]
        .filter((v): v is string => !!v)
        .some((v) => v.toLowerCase().includes(term));
    });
  });

  /**
   * Dónde está el equipo (distinto de en qué etapa de puesta en marcha):
   * fábrica, stock de una organización, o instalado. Derivado, sin columna.
   */
  protected custodyOf(device: Device): 'FACTORY' | 'DELIVERED' | 'INSTALLED' {
    if (device.neighborhoodId !== null) {
      return 'INSTALLED';
    }
    return device.organizationId === null ? 'FACTORY' : 'DELIVERED';
  }

  protected readonly counts = computed(() => {
    const all = this.items();
    const porEtapa = (stage: DeviceStage) => all.filter((d) => d.stage === stage).length;

    return {
      total: all.length,
      created: porEtapa('CREATED'),
      provisioned: porEtapa('PROVISIONED'),
      labeled: porEtapa('LABELED'),
      connected: porEtapa('CONNECTED'),
    };
  });

  /**
   * Sella o borra un hito. Se hace desde la fila, sin abrir el equipo: en una
   * tanda se etiquetan de a muchos y navegar por equipo sería el mismo error
   * que tenía el alta antes.
   */
  protected mark(device: Device, milestones: { labeled?: boolean; connected?: boolean }): void {
    if (this.marking() !== null) {
      return;
    }
    this.marking.set(device.id);

    this.devices.updateMilestones(device.id, milestones).subscribe({
      next: (updated) => {
        this.items.update((items) => items.map((d) => (d.id === updated.id ? updated : d)));
        this.marking.set(null);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.marking.set(null);
      },
    });
  }

  protected reload(): void {
    this.loading.set(true);

    forkJoin({
      stock: this.devices.inventory().pipe(catchError(() => of([] as Device[]))),
      installed: this.devices.list().pipe(catchError(() => of([] as Device[]))),
    }).subscribe({
      next: ({ stock, installed }) => {
        // Orden: lo último fabricado primero, que es lo que el operador acaba
        // de cargar y lo que va a querer verificar.
        this.items.set([...stock, ...installed].sort((a, b) => b.id - a.id));
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected submit(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const { mac, boardNumber, tested } = this.form.getRawValue();

    this.saving.set(true);
    this.error.set(null);

    this.devices
      .create({
        mac: mac as string,
        boardNumber: (boardNumber as string).toUpperCase(),
        tested: tested ?? undefined,
      })
      .subscribe({
        next: (device) => {
          this.saving.set(false);
          this.created.set(device);
          this.items.update((items) => [device, ...items]);
          // Listo para la placa siguiente, sin perder el "probado" que en una
          // tanda suele repetirse.
          this.form.patchValue({ mac: '', boardNumber: '' });
          this.form.markAsUntouched();
          this.focusMac();
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }

  protected dismiss(): void {
    this.created.set(null);
  }

  private focusMac(): void {
    // El operador viene del lector/teclado: dejarle el cursor puesto evita un
    // click por equipo en una tanda de decenas.
    queueMicrotask(() => document.getElementById('mac')?.focus());
  }
}
