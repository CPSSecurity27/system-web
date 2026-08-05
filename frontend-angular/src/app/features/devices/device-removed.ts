import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { DevicesService } from '../../core/api/devices.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Device } from '../../core/models/api.models';

/**
 * La PAPELERA de equipos (solo CPS).
 *
 * Un equipo removido salió de circulación: no aparece en fábrica, ni en el
 * inventario, ni en el listado de un barrio. Pero sigue existiendo, y desde acá
 * tiene dos salidas y solo dos:
 *
 *   REACTIVAR  vuelve al stock de FÁBRICA —no al barrio donde estaba, porque
 *              reinstalarlo es un claim— con un claim code nuevo y su credencial
 *              del broker pedida de nuevo.
 *   BORRAR     definitivo, sin vuelta. Se lleva la bitácora de mantenimiento.
 *              Un equipo con EVENTOS no se puede borrar: son append-only y la
 *              base lo rechaza.
 *
 * Es una pantalla aparte y no una pestaña de fábrica a propósito: son dos
 * trabajos distintos. En fábrica se cargan equipos de a decenas; acá se revisan
 * de a uno y las dos acciones son difíciles de deshacer.
 */
@Component({
  selector: 'app-device-removed',
  imports: [DatePipe, FormsModule, RouterLink],
  templateUrl: './device-removed.html',
})
export class DeviceRemoved {
  private readonly devices = inject(DevicesService);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly aviso = signal<string | null>(null);
  protected readonly items = signal<Device[]>([]);
  protected readonly search = signal('');

  /** El id sobre el que se está trabajando, para no bloquear la tabla entera. */
  protected readonly trabajando = signal<number | null>(null);

  /**
   * El equipo cuyo borrado está esperando confirmación.
   *
   * Se confirma en la misma fila y no con un `confirm()` del navegador: un
   * diálogo nativo no puede mostrar el serial ni advertir qué se lleva puesto, y
   * esta es la única acción del módulo que destruye algo sin vuelta.
   */
  protected readonly confirmando = signal<number | null>(null);

  constructor() {
    this.reload();
  }

  protected readonly filtered = computed(() => {
    const term = this.search().trim().toLowerCase();
    if (!term) return this.items();

    return this.items().filter((d) =>
      [d.serial, d.mac, d.boardNumber, d.name]
        .filter((v): v is string => !!v)
        .some((v) => v.toLowerCase().includes(term)),
    );
  });

  protected reload(): void {
    this.loading.set(true);
    this.devices.removidos().subscribe({
      next: (items) => {
        this.items.set(items);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected reactivar(device: Device): void {
    if (this.trabajando() !== null) return;
    this.trabajando.set(device.id);
    this.error.set(null);

    this.devices.reactivar(device.id).subscribe({
      next: () => {
        this.items.update((items) => items.filter((d) => d.id !== device.id));
        this.aviso.set(
          `${device.serial} volvió al stock de fábrica con un código de reclamo ` +
            'nuevo. Se pidió su credencial del broker; si estaba instalado, no ' +
            'volvió a su barrio: hay que reclamarlo de nuevo.',
        );
        this.trabajando.set(null);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.trabajando.set(null);
      },
    });
  }

  protected borrar(device: Device): void {
    if (this.trabajando() !== null) return;
    this.trabajando.set(device.id);
    this.error.set(null);

    this.devices.borrarDefinitivo(device.id).subscribe({
      next: ({ mensaje }) => {
        this.items.update((items) => items.filter((d) => d.id !== device.id));
        this.aviso.set(mensaje);
        this.confirmando.set(null);
        this.trabajando.set(null);
      },
      error: (err) => {
        // El caso típico es "tiene eventos": el backend lo explica con el
        // serial adentro, así que se muestra tal cual.
        this.error.set(apiErrorMessage(err));
        this.confirmando.set(null);
        this.trabajando.set(null);
      },
    });
  }

  protected pedirConfirmacion(device: Device): void {
    this.confirmando.set(device.id);
    this.error.set(null);
  }

  protected cancelar(): void {
    this.confirmando.set(null);
  }

  protected descartarAviso(): void {
    this.aviso.set(null);
  }
}
