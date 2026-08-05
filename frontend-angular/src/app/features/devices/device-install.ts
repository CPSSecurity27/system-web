import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { DevicesService } from '../../core/api/devices.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Device } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';
import { Map } from '../../shared/map/map';

/** De dónde sale el equipo que se está instalando. */
type Origen = 'STOCK' | 'CODIGO';

/**
 * INSTALAR una alarma en un barrio.
 *
 * Vive en Alarmas y no en Inventario (2026-08-05): instalar es trabajo de campo
 * —dónde va el poste, a qué altura, de qué luminaria cuelga— y no tiene nada que
 * ver con controlar stock. Antes estaba mezclado con el inventario, que terminó
 * teniendo un mapa para clickear la posición de un poste.
 *
 * ## Los dos caminos llegan al mismo lugar
 *
 *   DESDE MI STOCK  el equipo ya es mío: lo elijo de una lista. Es el camino de
 *                   la oficina, planificando qué se instala dónde.
 *   CON EL CÓDIGO   tengo el equipo en la mano y leo su etiqueta. Es el camino
 *                   del técnico parado abajo del poste, y sirve además para un
 *                   equipo que NO es de nadie todavía: se salta el inventario y
 *                   va derecho al barrio.
 *
 * Los dos terminan en el mismo `POST /devices/claim`. La diferencia es de dónde
 * salen el serial y el código, no qué hace el backend.
 *
 * ## Lo que decide si se puede
 *
 * No el código —que nunca se quema— sino de QUIÉN ES el equipo. Sin dueño lo
 * reclama cualquiera; con dueño, solo esa organización o CPS hacia un barrio de
 * ella. Esa regla vive en el backend y acá solo se muestra su resultado: la
 * pantalla no puede ser la que la garantice.
 */
@Component({
  selector: 'app-device-install',
  imports: [ReactiveFormsModule, RouterLink, Map],
  templateUrl: './device-install.html',
})
export class DeviceInstall {
  private readonly devices = inject(DevicesService);
  private readonly neighborhoods = inject(NeighborhoodsService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  protected readonly origen = signal<Origen>('STOCK');

  protected readonly stock = signal<Device[]>([]);
  protected readonly barrios = signal<Neighborhood[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Ubicación del poste elegida clickeando el mapa (opcional). */
  protected readonly latitude = signal<number | null>(null);
  protected readonly longitude = signal<number | null>(null);

  /** Camino "desde mi stock": el equipo elegido de la lista. */
  protected readonly elegido = signal<Device | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    // Solo se usan en el camino CÓDIGO; en el de stock salen del equipo elegido.
    serial: [''],
    claimCode: [''],
    neighborhoodId: [null as number | null, Validators.required],
    // OBLIGATORIO: el serial identifica al equipo, pero el que sale en el
    // tablero y en el evento es el nombre. Una alarma llamada
    // "AV-A842E38FCA6C" no le dice nada a quien está monitoreando.
    name: ['', Validators.required],
    // Datos de instalación: OPCIONALES pero recomendados. El mejor momento
    // para cargarlos es este, con el técnico parado abajo del poste.
    poleNumber: [''],
    heightM: [null as number | null],
    reference: [''],
    powerPoint: [''],
    installNotes: [''],
  });

  /**
   * Espejo en signal del valor del formulario.
   *
   * Hace falta porque la app es ZONELESS y un `FormControl` no es un signal: un
   * `computed()` que lea `form.controls.x.value` se calcula UNA vez y no se
   * entera nunca de que el usuario eligió algo. Así estaba `falta()`, y por eso
   * decía "elegí el barrio" con el barrio ya elegido.
   *
   * En el template no pasa —escribir en un input dispara change detection y las
   * expresiones se re-evalúan— pero adentro de un `computed` no hay nada que lo
   * despierte.
   */
  private readonly valores = signal(this.form.getRawValue());

  constructor() {
    this.form.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.valores.set(this.form.getRawValue()));

    forkJoin({
      stock: this.devices.inventory().pipe(catchError(() => of([] as Device[]))),
      barrios: this.neighborhoods.list().pipe(catchError(() => of([] as Neighborhood[]))),
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
  }

  /**
   * El stock, que desde el 2026-08-05 ya viene filtrado por el backend: un
   * equipo entra al stock cuando alguien le da el visto bueno de fábrica.
   *
   * Acá no se filtra nada, entonces. Si el equipo que buscás no está, es porque
   * todavía no lo aprobaron — y eso se resuelve en Fábrica, no acá. La pantalla
   * lo dice cuando la lista está vacía en vez de dejarte adivinando.
   *
   * Igual se puede instalar uno sin aprobar: por el camino del código, que el
   * backend no restringe por esto.
   */
  protected readonly disponibles = computed(() => this.stock());

  protected cambiarOrigen(origen: Origen): void {
    this.origen.set(origen);
    this.error.set(null);
    if (origen === 'CODIGO') {
      this.elegido.set(null);
    } else {
      this.form.patchValue({ serial: '', claimCode: '' });
    }
  }

  protected elegir(device: Device): void {
    this.elegido.set(device);
    this.error.set(null);
    // El nombre del poste se propone con el que ya tenga, si lo tiene.
    if (device.name && !this.form.value.name) {
      this.form.patchValue({ name: device.name });
    }
  }

  protected setPosition(position: { latitude: number; longitude: number }): void {
    this.latitude.set(position.latitude);
    this.longitude.set(position.longitude);
  }

  protected clearPosition(): void {
    this.latitude.set(null);
    this.longitude.set(null);
  }

  /**
   * El barrio elegido, para llevar el mapa hasta ahí.
   *
   * Un mapa que arranca en Córdoba cuando estás instalando en Jujuy obliga a
   * arrastrar medio país antes de poder clickear el poste. Con el `zoom`
   * explícito el componente SIEMPRE vuela —sin él solo se mueve si el punto
   * quedó fuera de la vista, que acá no alcanza.
   */
  protected readonly foco = computed(() => {
    const id = this.valores().neighborhoodId;
    if (id === null) return null;

    const barrio = this.barrios().find((b) => b.id === id);
    if (!barrio) return null;

    return { latitude: barrio.latitude, longitude: barrio.longitude, zoom: 15 };
  });

  /** El pin del barrio, para saber dónde estás parado antes de marcar el poste. */
  protected readonly marcadores = computed(() => {
    const barrio = this.foco();
    if (!barrio) return [];

    const id = this.valores().neighborhoodId;
    const nombre = this.barrios().find((b) => b.id === id)?.name ?? 'Barrio';
    return [
      {
        latitude: barrio.latitude,
        longitude: barrio.longitude,
        label: nombre,
        variant: 'neighborhood' as const,
      },
    ];
  });

  /** Falta algo para poder instalar, y qué. `null` si está todo. */
  protected readonly falta = computed(() => {
    // `valores()` y no `form.controls...`: ver el comentario del espejo.
    if (this.valores().neighborhoodId === null) {
      return 'Elegí el barrio donde va la alarma.';
    }
    if (this.origen() === 'STOCK') {
      if (this.elegido() === null) return 'Elegí un equipo de tu stock.';
    } else if (!this.valores().serial.trim() || !this.valores().claimCode.trim()) {
      return 'Cargá el serial y el código de la etiqueta.';
    }
    // El nombre es lo que ve el que monitorea cuando la alarma suena.
    if (!this.valores().name.trim()) {
      return 'Ponele un nombre a la alarma (la esquina, el lugar).';
    }
    // El GPS es OBLIGATORIO: el tablero de monitoreo es un mapa, y una alarma
    // sin punto es una alarma que nadie va a mirar cuando suene. La base lo
    // impone con chk_device_gps; acá se avisa antes de mandar nada.
    if (this.latitude() === null) {
      return 'Marcá en el mapa dónde queda el poste.';
    }
    return null;
  });

  protected instalar(): void {
    if (this.saving() || this.falta() !== null) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();
    const desdeStock = this.origen() === 'STOCK';
    const device = this.elegido();

    // El serial y el código salen del equipo elegido o de lo tipeado, pero la
    // llamada al backend es la misma: los dos caminos son la misma operación.
    const serial = desdeStock ? (device?.serial ?? '') : value.serial.trim().toUpperCase();
    const claimCode = desdeStock
      ? (device?.claimCode ?? '')
      : value.claimCode.trim().toUpperCase();

    if (!serial || !claimCode) {
      this.error.set(
        desdeStock
          ? 'Ese equipo no tiene código de reclamo cargado. Re-fabricalo o instalalo con el código de su etiqueta.'
          : 'Cargá el serial y el código que están impresos en la etiqueta.',
      );
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    this.devices
      .claim({
        serial,
        claimCode,
        neighborhoodId: value.neighborhoodId as number,
        name: value.name.trim() ? value.name.trim() : undefined,
        // Obligatorias: `falta()` no deja llegar hasta acá sin ellas.
        latitude: this.latitude() as number,
        longitude: this.longitude() as number,
        // Solo se mandan los que se completaron: el vacío no es un dato.
        poleNumber: value.poleNumber.trim() || undefined,
        heightM: value.heightM ?? undefined,
        reference: value.reference.trim() || undefined,
        powerPoint: value.powerPoint.trim() || undefined,
        installNotes: value.installNotes.trim() || undefined,
      })
      .subscribe({
        next: (instalada) => {
          this.saving.set(false);
          // A la ficha de la alarma recién instalada: es donde se completa lo
          // que faltó y se la ve funcionar. Quedarse acá con el formulario
          // vacío no le sirve a nadie.
          void this.router.navigate(['/alarmas', instalada.id]);
        },
        error: (err) => {
          // Los mensajes del backend explican el caso real: código equivocado,
          // stock de otro cliente, equipo ya instalado.
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }
}
