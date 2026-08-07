import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { FirmwareService } from '../../core/api/firmware.service';
import { apiErrorMessage } from '../../core/http/api-error';
import {
  ChequeoFirmware,
  FirmwareRanura,
  FirmwareRelease,
  FirmwareSlot,
} from '../../core/models/api.models';

/**
 * El GESTOR DE VERSIONES (solo CPS): subir un `.bin` y decidir qué versión
 * está publicada en cada una de las dos bases del equipo.
 *
 * ## Las dos ranuras no son la misma cosa, y la pantalla lo dice
 *
 * `new` es la que baja un OTA automático: la última que queremos desplegar, y
 * se cambia cada vez que sale una versión.
 *
 * `emergency` es el **último bueno conocido**. El equipo la baja SOLO, sin que
 * nadie se lo pida, cuando decide que está roto. Publicar ahí la misma versión
 * de la que está tratando de escapar anula el mecanismo entero — por eso es un
 * botón aparte, con confirmación y con el texto que lo explica, y no un tilde
 * al lado del otro.
 *
 * ## Lo que NO se tipea
 *
 * Del `.bin` salen el proyecto, el tamaño y el sha256. Lo único que escribe una
 * persona es la versión, y no por comodidad: el `CMakeLists.txt` del firmware
 * no define `PROJECT_VER`, así que la imagen declara su `git describe` y no
 * sirve para nombrar nada.
 */
@Component({
  selector: 'app-firmware-versions',
  imports: [FormsModule, DatePipe, DecimalPipe],
  templateUrl: './firmware-versions.html',
})
export class FirmwareVersions {
  private readonly api = inject(FirmwareService);

  protected readonly cargando = signal(true);
  protected readonly subiendo = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly aviso = signal<string | null>(null);

  protected readonly versiones = signal<FirmwareRelease[]>([]);
  protected readonly ranuras = signal<FirmwareRanura[]>([]);

  /** El archivo elegido. `File`, no un path: el input file no devuelve rutas. */
  protected readonly archivo = signal<File | null>(null);
  protected readonly version = signal('');
  protected readonly notas = signal('');

  /** La publicación que está esperando confirmación. */
  protected readonly publicando = signal<{
    release: FirmwareRelease;
    slot: FirmwareSlot;
  } | null>(null);
  /** La versión que se está por borrar. */
  protected readonly borrando = signal<FirmwareRelease | null>(null);
  protected readonly trabajando = signal<number | null>(null);

  /** El resultado del botón "Verificar el servidor". */
  protected readonly chequeo = signal<ChequeoFirmware | null>(null);
  protected readonly chequeando = signal(false);

  constructor() {
    this.cargar();
  }

  private cargar(): void {
    this.cargando.set(true);
    this.api.listar().subscribe({
      next: (v) => {
        this.versiones.set(v);
        this.cargando.set(false);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.cargando.set(false);
      },
    });
    this.api.ranuras().subscribe({
      next: (r) => this.ranuras.set(r),
      error: () => this.ranuras.set([]),
    });
  }

  // ── Las dos ranuras ──────────────────────────────────────────────

  protected readonly ranuraNew = computed(() =>
    this.ranuras().find((r) => r.slot === 'new'),
  );
  protected readonly ranuraEmergencia = computed(() =>
    this.ranuras().find((r) => r.slot === 'emergency'),
  );

  /**
   * La de emergencia apunta a la misma que la automática.
   *
   * No es un error —puede ser deliberado cuando recién arranca todo, con una
   * sola versión cargada— pero sí es un aviso: la red de seguridad deja de
   * serlo el día que esa versión resulte ser la rota.
   */
  protected readonly emergenciaEsLaMisma = computed(() => {
    const n = this.ranuraNew();
    const e = this.ranuraEmergencia();
    return n !== undefined && e !== undefined && n.releaseId === e.releaseId;
  });

  // ── Subir ────────────────────────────────────────────────────────

  protected elegirArchivo(evento: Event): void {
    const input = evento.target as HTMLInputElement;
    this.archivo.set(input.files?.[0] ?? null);
    this.error.set(null);
  }

  protected readonly puedeSubir = computed(
    () => this.archivo() !== null && this.version().trim().length > 0,
  );

  protected subir(): void {
    const file = this.archivo();
    if (!file || this.subiendo()) return;

    this.subiendo.set(true);
    this.error.set(null);
    this.aviso.set(null);

    this.api
      .subir(file, this.version().trim(), this.notas().trim() || undefined)
      .subscribe({
        next: (r) => {
          this.subiendo.set(false);
          this.aviso.set(
            `${r.version} quedó cargada. Todavía NO la baja ningún equipo: ` +
              `para eso hay que publicarla.`,
          );
          this.version.set('');
          this.notas.set('');
          this.archivo.set(null);
          this.cargar();
        },
        error: (e: unknown) => {
          this.subiendo.set(false);
          this.error.set(apiErrorMessage(e));
        },
      });
  }

  // ── Publicar ─────────────────────────────────────────────────────

  protected pedirPublicar(release: FirmwareRelease, slot: FirmwareSlot): void {
    this.publicando.set({ release, slot });
    this.error.set(null);
  }

  protected cancelarPublicacion(): void {
    this.publicando.set(null);
  }

  protected confirmarPublicacion(): void {
    const pedido = this.publicando();
    if (!pedido) return;

    this.trabajando.set(pedido.release.id);
    this.publicando.set(null);

    this.api.publicar(pedido.release.id, pedido.slot).subscribe({
      next: (r) => {
        this.ranuras.set(r);
        this.trabajando.set(null);
        this.aviso.set(
          pedido.slot === 'new'
            ? `${pedido.release.version} es la que van a bajar los equipos. ` +
                `Falta mandársela: eso se hace en la pestaña Equipos.`
            : `${pedido.release.version} quedó como firmware de recuperación.`,
        );
        this.cargar();
      },
      error: (e: unknown) => {
        this.trabajando.set(null);
        this.error.set(apiErrorMessage(e));
      },
    });
  }

  // ── Borrar ───────────────────────────────────────────────────────

  protected pedirBorrar(release: FirmwareRelease): void {
    this.borrando.set(release);
    this.error.set(null);
  }

  protected cancelarBorrado(): void {
    this.borrando.set(null);
  }

  protected confirmarBorrado(): void {
    const release = this.borrando();
    if (!release) return;

    this.trabajando.set(release.id);
    this.borrando.set(null);

    this.api.borrar(release.id).subscribe({
      next: () => {
        this.trabajando.set(null);
        this.aviso.set(`${release.version} se sacó del catálogo y del disco.`);
        this.cargar();
      },
      error: (e: unknown) => {
        this.trabajando.set(null);
        this.error.set(apiErrorMessage(e));
      },
    });
  }

  // ── Verificar el servidor ────────────────────────────────────────

  /**
   * El modo de falla de todo esto es SILENCIOSO: la pantalla muestra el catálogo
   * leyéndolo de la base, y si nginx no sirve `/firmware/` o `FIRMWARE_ROOT`
   * apunta a otro lado, se ve todo perfecto hasta que un poste baja un 404 y
   * suma un intento fallido.
   */
  protected verificar(): void {
    this.chequeando.set(true);
    this.chequeo.set(null);
    this.api.verificar().subscribe({
      next: (c) => {
        this.chequeo.set(c);
        this.chequeando.set(false);
      },
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.chequeando.set(false);
      },
    });
  }

  // ── Presentación ─────────────────────────────────────────────────

  protected estaEn(release: FirmwareRelease, slot: FirmwareSlot): boolean {
    return release.publicadoEn.includes(slot);
  }

  protected copiar(texto: string): void {
    void navigator.clipboard?.writeText(texto);
    this.aviso.set('Copiado.');
  }
}
