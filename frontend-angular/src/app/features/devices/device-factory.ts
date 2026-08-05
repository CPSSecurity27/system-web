import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { DevicesService } from '../../core/api/devices.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { BoardModel, Device, DeviceStage } from '../../core/models/api.models';
import { DeviceLabel } from './device-label';

/**
 * Cada cuánto se refresca la tabla sola. Generoso: lo único que cambia sin que
 * el operador haga nada es la primera conexión, y un equipo tarda más que esto
 * en salir de la caja y encenderse.
 */
const REFRESCO_MS = 20_000;

/**
 * FÁBRICA de alarmas (solo CPS): el punto por donde un equipo ENTRA al sistema.
 *
 * Acá no se decide destino: ni a qué organización va ni en qué barrio se
 * instala. Eso pasa después y en otro lado (la entrega, desde la cuenta; la
 * instalación por claim, desde el barrio). Lo único que importa en esta
 * pantalla es que el equipo quede registrado con su identidad física, con sus
 * credenciales, y con su etiqueta impresa.
 *
 * Los datos obligatorios se LEEN de la placa, no se inventan:
 *   MAC          `esptool read_mac` en la estación de flasheo
 *   N° de placa  impreso por el fabricante: el modelo se elige de la lista y el
 *                número se tipea. Antes era un solo campo (`ALOY0043`) y el
 *                prefijo se prestaba a error de tipeo — el catálogo ya existe,
 *                así que elegirlo es gratis y no se puede equivocar.
 *
 * El `serial` no se pide: lo deriva el backend como `AV-<12 hex>`.
 *
 * ## Fabricar TARDA, y eso es correcto
 *
 * El alta es atómica: el backend no contesta hasta que el provisioner registró
 * la credencial en el broker (con su `reload` de Mosquitto) y derivó las del
 * portal. Puede ser un par de segundos. Si falla, no queda NADA a medias y el
 * formulario conserva lo tipeado para reintentar tal cual.
 *
 * Está pensada para uso en TANDA, así que el alta y el listado conviven en la
 * misma pantalla y el foco vuelve solo al campo de la MAC después de cada alta.
 */
@Component({
  selector: 'app-device-factory',
  imports: [ReactiveFormsModule, FormsModule, RouterLink, DeviceLabel],
  templateUrl: './device-factory.html',
})
export class DeviceFactory {
  private readonly devices = inject(DevicesService);
  private readonly fb = inject(FormBuilder);

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** El último equipo fabricado: sus credenciales se muestran acá. */
  protected readonly created = signal<Device | null>(null);
  protected readonly boardModels = signal<BoardModel[]>([]);
  protected readonly items = signal<Device[]>([]);

  /**
   * La password del usuario `cps`, si el operador la pidió.
   *
   * No viene con la ficha: se pide aparte, exige OWNER o ADMIN, y cada lectura
   * queda en `audit_log`. Mostrarla siempre en una pantalla de fábrica es cómo
   * termina en una captura de pantalla — el firmware manda no imprimirla nunca.
   */
  protected readonly passCps = signal<string | null>(null);
  protected readonly pidiendoCps = signal(false);

  /** El equipo que se está por imprimir. Lo lee el bloque `.solo-impresion`. */
  protected readonly paraImprimir = signal<Device | null>(null);
  protected readonly imprimiendo = signal<number | null>(null);

  /** El panel de credenciales completas, abierto desde una fila de la tabla. */
  protected readonly credenciales = signal<{
    device: Device;
    cps: string | null;
    /** El usuario no alcanza a ver la de fábrica: se muestra el resto igual. */
    sinPermiso: boolean;
  } | null>(null);
  protected readonly abriendoCreds = signal<number | null>(null);

  /** El equipo que se está removiendo, para no bloquear la tabla entera. */
  protected readonly removiendo = signal<number | null>(null);
  /** El serial del último removido: sin este aviso, la fila se esfuma y listo. */
  protected readonly removidoRecien = signal<string | null>(null);

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
    boardModelCode: ['', [Validators.required]],
    boardSeq: [
      null as number | null,
      [Validators.required, Validators.min(1), Validators.max(9999)],
    ],
  });

  /**
   * "Todo lo fabricado" son dos endpoints: `/devices/inventory` (lo que sigue
   * en stock) y `/devices` (lo que ya se instaló). El backend no expone un
   * listado único, y para CPS la unión de ambos ES el universo de equipos.
   */
  constructor() {
    this.reload();

    // La primera conexión la observa el broker, no la marca nadie: sin este
    // refresco habría que recargar la página a mano para enterarse, que es
    // justo lo que un hito automático no debería obligarte a hacer.
    const tic = setInterval(() => this.traer(), REFRESCO_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(tic));

    this.devices.boardModels().subscribe({
      next: (models) => {
        this.boardModels.set(models);
        // Con un solo modelo activo, elegirlo no es una decisión: es un click
        // de más por equipo en una estación que se usa todo el día.
        const activos = models.filter((m) => m.active);
        if (activos.length === 1) {
          this.form.patchValue({ boardModelCode: activos[0].code });
        }
      },
      error: () => this.boardModels.set([]),
    });
  }

  protected readonly modelosActivos = computed(() =>
    this.boardModels().filter((m) => m.active),
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

  protected readonly counts = computed(() => {
    const all = this.items();
    const porEtapa = (stage: DeviceStage) => all.filter((d) => d.stage === stage).length;

    return {
      total: all.length,
      manufactured: porEtapa('MANUFACTURED'),
      connected: porEtapa('CONNECTED'),
      tested: porEtapa('TESTED'),
      ready: porEtapa('READY'),
      // Los que hay que mirar: la credencial no quedó registrada.
      sinCredencial: all.filter((d) => d.provisioning && !d.provisioning.brokerRegistered)
        .length,
    };
  });

  /**
   * Sella o borra un hito. Se hace desde la fila, sin abrir el equipo: en una
   * tanda se marcan de a muchos y navegar por equipo sería el mismo error que
   * tenía el alta antes.
   *
   * `connected` no se manda desde acá: es un hito observado por el broker.
   */
  protected mark(
    device: Device,
    milestones: { labeled?: boolean; tested?: boolean; ready?: boolean },
  ): void {
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

  /**
   * Imprime la etiqueta y sella el hito de etiquetado.
   *
   * Pide la FICHA del equipo aunque ya lo tengamos en la lista: la password del
   * portal solo viaja en `GET /devices/:id`, nunca en los listados — una tabla
   * de 200 equipos no puede ser un volcado de 200 passwords.
   *
   * El hito se sella solo si estaba vacío: reimprimir no lo mueve. La primera
   * impresión es la que cuenta.
   */
  protected imprimir(device: Device): void {
    if (this.imprimiendo() !== null) {
      return;
    }
    this.imprimiendo.set(device.id);
    this.error.set(null);

    this.devices.get(device.id).subscribe({
      next: (completo) => {
        if (!completo.portal?.password) {
          this.error.set(
            'Este equipo no tiene la credencial del portal derivada, así que la ' +
              'etiqueta saldría sin clave. Re-fabricá la credencial antes de imprimir.',
          );
          this.imprimiendo.set(null);
          return;
        }

        this.paraImprimir.set(completo);
        // Un tick para que Angular pinte la etiqueta y los QR entren al DOM
        // antes de que el navegador arme la vista de impresión.
        setTimeout(() => {
          window.print();
          this.imprimiendo.set(null);
          if (!completo.milestones.labeledAt) {
            this.mark(completo, { labeled: true });
          }
        }, 300);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.imprimiendo.set(null);
      },
    });
  }

  /** La password de fábrica, a pedido explícito y auditada. */
  protected verPassCps(device: Device): void {
    if (this.pidiendoCps()) return;
    this.pidiendoCps.set(true);

    this.devices.passwordCps(device.id).subscribe({
      next: ({ password }) => {
        this.passCps.set(password);
        this.pidiendoCps.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.pidiendoCps.set(false);
      },
    });
  }

  /**
   * Abre el panel con TODAS las credenciales del equipo, incluida la de `cps`.
   *
   * Son dos requests: la ficha —que es donde viaja la password de `admin`, nunca
   * en los listados— y el endpoint de `cps`, que exige OWNER o ADMIN y deja
   * `audit_log`. Si el segundo falla por permisos, igual se muestra el resto:
   * un técnico tiene que poder ver lo suyo aunque no alcance la de fábrica.
   */
  protected verCredenciales(device: Device): void {
    if (this.abriendoCreds() !== null) return;
    this.abriendoCreds.set(device.id);
    this.error.set(null);

    this.devices.get(device.id).subscribe({
      next: (completo) => {
        this.credenciales.set({ device: completo, cps: null, sinPermiso: false });
        this.devices.passwordCps(device.id).subscribe({
          next: ({ password }) => {
            this.credenciales.update((c) => (c ? { ...c, cps: password } : c));
            this.abriendoCreds.set(null);
          },
          error: () => {
            this.credenciales.update((c) => (c ? { ...c, sinPermiso: true } : c));
            this.abriendoCreds.set(null);
          },
        });
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.abriendoCreds.set(null);
      },
    });
  }

  protected cerrarCredenciales(): void {
    this.credenciales.set(null);
  }

  /**
   * A la papelera. Sale de la tabla y su credencial del broker se revoca.
   *
   * No pide confirmación: es reversible desde la pantalla de removidos, y en una
   * estación donde se cargan equipos en tanda un diálogo por click es fricción.
   * El que SÍ confirma es el borrado definitivo, que no tiene vuelta.
   */
  protected remover(device: Device): void {
    if (this.removiendo() !== null) return;
    this.removiendo.set(device.id);
    this.error.set(null);

    this.devices.remover(device.id).subscribe({
      next: () => {
        this.items.update((items) => items.filter((d) => d.id !== device.id));
        this.removidoRecien.set(device.serial);
        this.removiendo.set(null);
        // Si estaba abierta su tarjeta de alta, ya no aplica a nada.
        if (this.created()?.id === device.id) {
          this.dismiss();
        }
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.removiendo.set(null);
      },
    });
  }

  protected descartarRemovido(): void {
    this.removidoRecien.set(null);
  }

  protected reload(): void {
    this.loading.set(true);
    this.traer();
  }

  /**
   * Refresca la tabla sin spinner. Lo llama el temporizador.
   *
   * Es lo que hace que la primera conexión aparezca SOLA: es un hito observado
   * por el broker (regla 5 del dominio, lo escribe el servicio de alarmas), así
   * que la pantalla no puede hacer más que mirar. Antes había un botón para
   * marcarla a mano y eso era exactamente al revés: convertía una medición en
   * una opinión.
   */
  private traer(): void {
    forkJoin({
      // `true`: la fábrica ve TAMBIÉN los que no tienen el visto bueno. Es la
      // única pantalla que puede — y la única desde la que se los aprueba, así
      // que sin esto un equipo recién fabricado desaparecería de acá.
      stock: this.devices.inventory(true).pipe(catchError(() => of([] as Device[]))),
      installed: this.devices.list().pipe(catchError(() => of([] as Device[]))),
    }).subscribe({
      next: ({ stock, installed }) => {
        // Orden: lo último fabricado primero, que es lo que el operador acaba
        // de cargar y lo que va a querer verificar.
        this.items.set([...stock, ...installed].sort((a, b) => b.id - a.id));
        this.loading.set(false);
      },
      error: (err) => {
        // En el refresco automático no se pisa un error que el operador esté
        // leyendo: solo importa si fue la carga inicial.
        if (this.loading()) {
          this.error.set(apiErrorMessage(err));
        }
        this.loading.set(false);
      },
    });
  }

  protected submit(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const { mac, boardModelCode, boardSeq } = this.form.getRawValue();

    this.saving.set(true);
    this.error.set(null);
    this.passCps.set(null);

    this.devices
      .create({
        mac: mac as string,
        // El backend sigue recibiendo el string impreso completo: el modelo y
        // el número viven separados en la base, pero `ALOY0043` es lo que dice
        // la placa y lo que el operador reconoce.
        boardNumber: boardModelCode + String(boardSeq).padStart(4, '0'),
      })
      .subscribe({
        next: (device) => {
          this.saving.set(false);
          this.created.set(device);
          this.items.update((items) => [device, ...items]);
          // Listo para la placa siguiente. Se conservan el modelo y el
          // "probado", que en una tanda se repiten; el número se autoincrementa
          // porque las placas vienen numeradas de corrido.
          this.form.patchValue({ mac: '', boardSeq: (boardSeq ?? 0) + 1 });
          this.form.markAsUntouched();
          this.focusMac();
        },
        error: (err) => {
          // El equipo NO quedó creado: el backend compensa y borra. Se conserva
          // todo lo tipeado para poder reintentar sin volver a leer la placa.
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }

  protected dismiss(): void {
    this.created.set(null);
    this.passCps.set(null);
  }

  private focusMac(): void {
    // El operador viene del lector/teclado: dejarle el cursor puesto evita un
    // click por equipo en una tanda de decenas.
    queueMicrotask(() => document.getElementById('mac')?.focus());
  }
}
