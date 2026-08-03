import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { debounceTime, distinctUntilChanged, switchMap } from 'rxjs';

import { AccountsService } from '../../core/api/accounts.service';
import { GeographyService } from '../../core/api/geography.service';
import { PlansService } from '../../core/api/plans.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { JurisdictionLevel, ManagedBy, OrgSubtype, Plan } from '../../core/models/api.models';
import { Centroide, Department, Locality, Province } from '../../core/models/neighborhood';
import { Map } from '../../shared/map/map';
import type { MapMarkerVariant } from '../../shared/map/map';
import { Alert } from '../../shared/ui/alert/alert';
import { PageHeader } from '../../shared/ui/page-header/page-header';

/** Lo que queda para mostrar una sola vez tras crear la cuenta: la clave no se puede volver a leer. */
interface CreatedAccountResult {
  accountId: number;
  ownerUsername: string;
  temporaryPassword: string;
}

/**
 * Los cuatro tramos del alta. El orden no es estético: sigue el orden en que se
 * conoce la información en una venta real — primero QUIÉN es y qué contrató,
 * después DÓNDE opera, después la plata y quién va a entrar al sistema.
 *
 * `revisar` existe porque este alta es un POST atómico e irreversible que
 * además devuelve una clave que se muestra UNA sola vez: confirmarlo a ciegas
 * desde el fondo de un formulario largo era la parte más frágil del flujo.
 */
type Paso = 'tipo' | 'cliente' | 'ubicacion' | 'contrato' | 'revisar';

/**
 * `tipo` va PRIMERO y solo. Es la decisión de la que cuelga todo lo demás: si
 * es comunitaria no se pregunta cupo de barrios ni de técnicos ni jurisdicción,
 * y en cambio nace un barrio. Preguntándolo en el medio de un formulario, la
 * pantalla se reacomodaba abajo del que la estaba llenando.
 */
const PASOS: { id: Paso; label: string; icon: string }[] = [
  { id: 'tipo', label: 'Tipo', icon: 'icon-shapes' },
  { id: 'cliente', label: 'Cliente', icon: 'icon-briefcase' },
  { id: 'ubicacion', label: 'Ubicación', icon: 'icon-map-pin' },
  { id: 'contrato', label: 'Contrato', icon: 'icon-file-text' },
  { id: 'revisar', label: 'Revisar', icon: 'icon-circle-check-big' },
];

/**
 * Cuánto se acerca el mapa en cada nivel de la geografía. Los valores están
 * elegidos para que la unidad ENTRE en pantalla, no para que se vea linda:
 * una provincia argentina puede tener 300 km de lado y una localidad se marca
 * a escala de calles, porque lo que se va a clickear ahí es un edificio.
 */
const ZOOM_PROVINCIA = 7;
const ZOOM_DEPARTAMENTO = 9;
const ZOOM_LOCALIDAD = 13;

/** Los plazos de contrato que se ofrecen como atajo. */
type Plazo = { label: string; meses: number };

const PLAZOS: Plazo[] = [
  { label: 'Trimestral', meses: 3 },
  { label: 'Semestral', meses: 6 },
  { label: 'Anual', meses: 12 },
  { label: '2 años', meses: 24 },
  { label: '3 años', meses: 36 },
];

/** Hoy en AAAA-MM-DD, para los <input type="date"> del contrato. */
function hoy(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Suma meses a una fecha AAAA-MM-DD.
 *
 * El día se recorta al último del mes destino cuando no existe: 31/01 + 1 mes
 * es 28/02, no el 3/03 que devolvería `setMonth` por su desborde automático.
 */
function sumarMeses(fecha: string, meses: number): string {
  const [a, m, d] = fecha.split('-').map(Number);
  const destino = new Date(a, m - 1 + meses, 1);
  const ultimoDia = new Date(destino.getFullYear(), destino.getMonth() + 1, 0).getDate();
  destino.setDate(Math.min(d, ultimoDia));
  const mm = String(destino.getMonth() + 1).padStart(2, '0');
  const dd = String(destino.getDate()).padStart(2, '0');
  return `${destino.getFullYear()}-${mm}-${dd}`;
}

/**
 * El username sugerido para el OWNER, derivado del nombre de la cuenta.
 *
 * Espeja `backend/src/common/derive-username.ts`, que es la fuente de verdad y
 * tiene los tests. Acá es solo comodidad de tipeo: el campo queda EDITABLE y el
 * backend rebota con 409 si el usuario ya existe.
 */
const PALABRAS_VACIAS = new Set(['de', 'del', 'y']);
const LARGO_MAXIMO = 30;

function deriveUsername(name: string): string {
  const palabras = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length > 0 && !PALABRAS_VACIAS.has(p));

  const completo = palabras.join('_');
  if (completo.length <= LARGO_MAXIMO) return completo;

  const recortado: string[] = [];
  let largo = 0;
  for (const palabra of palabras) {
    const suma = recortado.length === 0 ? palabra.length : largo + 1 + palabra.length;
    if (suma > LARGO_MAXIMO) break;
    recortado.push(palabra);
    largo = suma;
  }
  return recortado.length > 0 ? recortado.join('_') : completo.slice(0, LARGO_MAXIMO);
}

/**
 * Alta de un cliente (solo CPS). Un solo acto atómico que termina en un OWNER
 * operativo:
 *
 *   cuenta + jurisdicción + plan/cupos + contrato + OWNER (+ barrio si es
 *   comunitaria)
 *
 * Las dos ÚNICAS diferencias entre municipal y comunitaria:
 *  - la comunitaria crea su único barrio acá mismo, y de ese barrio DERIVA su
 *    jurisdicción y su GPS (son el mismo lugar);
 *  - la comunitaria no tiene técnicos propios (cupo 0, no se pregunta).
 *
 * El CONTRATO va para las dos: es de la CUENTA, no del barrio, así que la muni
 * puede firmarlo el día 1 aunque todavía no tenga ningún barrio.
 *
 * El OWNER nace con una clave TEMPORAL generada por el backend: se muestra UNA
 * sola vez acá y hay que cambiarla en el primer login.
 */
@Component({
  selector: 'app-account-form',
  imports: [ReactiveFormsModule, RouterLink, Alert, PageHeader, Map],
  templateUrl: './account-form.html',
})
export class AccountForm {
  private readonly accounts = inject(AccountsService);
  private readonly geography = inject(GeographyService);
  private readonly plans = inject(PlansService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly created = signal<CreatedAccountResult | null>(null);
  protected readonly copied = signal(false);
  protected readonly plazos = PLAZOS;

  /**
   * El punto del cliente en el mapa. OBLIGATORIO para los dos tipos desde la
   * migración `MandatoryCoordinates` — el tablero de clientes es un mapa y con
   * pines faltantes no se puede leer. Qué representa depende del tipo:
   *
   *   COMMUNITY -> el BARRIO. El backend lo copia también a la cuenta: el
   *                consorcio y su barrio son el mismo lugar.
   *   MUNICIPAL -> la SEDE de la municipalidad. Va aparte de la jurisdicción,
   *                que es un límite territorial y no un edificio.
   *
   * No vive en el form group porque no se tipea: sale de un click en el mapa.
   * Por eso el "falta el punto" lo avisa `puntoFaltante` y no un
   * Validators.required — sin ese aviso el botón quedaría habilitado (el form
   * no ve este dato) y el click no haría nada.
   */
  protected readonly latitude = signal<number | null>(null);
  protected readonly longitude = signal<number | null>(null);

  protected readonly tienePunto = computed(
    () => this.latitude() !== null && this.longitude() !== null,
  );

  /** Qué es el punto que se está marcando, según el tipo de cliente. */
  protected readonly puntoLabel = () =>
    this.isCommunity() ? 'el barrio' : 'la sede de la municipalidad';

  /** Se prende al intentar crear sin haber marcado el punto. */
  protected readonly puntoFaltante = signal(false);

  /**
   * A dónde vuela el mapa mientras se elige la geografía: provincia →
   * departamento → localidad, acercándose en cada paso.
   *
   * Es ACOMPAÑAMIENTO, no ubicación: el punto del cliente lo sigue marcando una
   * persona con un click. Sin esto, elegir "Jujuy" te dejaba el mapa en Córdoba
   * (el centro por defecto) y había que arrastrar medio país a mano antes de
   * poder marcar nada — el trabajo más tonto de todo el alta.
   *
   * El zoom sube con el nivel: la provincia entra entera, la localidad se ve a
   * escala de calles, que es donde recién se puede marcar un edificio.
   */
  protected readonly focoGeo = signal<{
    latitude: number;
    longitude: number;
    zoom: number;
  } | null>(null);

  private volarA(centro: Centroide | undefined, zoom: number): void {
    if (!centro || centro.latitude === null || centro.longitude === null) return;
    this.focoGeo.set({ latitude: centro.latitude, longitude: centro.longitude, zoom });
  }

  protected setPosition(position: { latitude: number; longitude: number }): void {
    this.latitude.set(position.latitude);
    this.longitude.set(position.longitude);
    this.puntoFaltante.set(false);
  }

  /**
   * No hay "quitar el punto": es obligatorio, y un botón para dejarlo vacío
   * solo sirve para invalidar el formulario. Para corregirlo se vuelve a
   * clickear el mapa.
   *
   * Sí se limpia al cambiar de tipo, porque ahí cambia QUÉ representa: la sede
   * de una muni no es el barrio de un consorcio.
   */
  private resetPunto(): void {
    this.latitude.set(null);
    this.longitude.set(null);
    this.puntoFaltante.set(false);
  }

  /** Solo los VIGENTES: un plan discontinuado no se puede vender (el backend lo rechaza). */
  private readonly plansCatalog = signal<Plan[]>([]);

  /**
   * El buscador es un ATAJO: al elegir un resultado precarga los tres combos.
   * Se puede ignorar y bajar a mano por provincia -> departamento -> localidad.
   */
  protected readonly localityResults = signal<Locality[]>([]);
  protected readonly searchingLocality = signal(false);

  /** Los tres niveles de la geografía, en cascada. */
  protected readonly provinces = signal<Province[]>([]);
  protected readonly departments = signal<Department[]>([]);
  protected readonly localities = signal<Locality[]>([]);

  private readonly geoVersion = signal(0);

  /**
   * El texto de la localidad elegida, para el cartel de confirmación.
   *
   * Se COMPONE de los tres combos y no del árbol de la localidad: el endpoint
   * en cascada (`/departments/:id/localities`) devuelve localidades PLANAS, sin
   * `department.province`. Solo el buscador trae el árbol completo.
   */
  protected readonly selectedLocalityText = computed(() => {
    this.geoVersion();
    const localityId = this.form.controls.localityId.value;
    if (!localityId) return '';

    const locality = this.localities().find((l) => l.id === Number(localityId));
    if (!locality) return '';

    const department = this.departments().find(
      (d) => d.id === Number(this.form.controls.departmentId.value),
    );
    const province = this.provinces().find(
      (p) => p.id === Number(this.form.controls.provinceId.value),
    );

    return [locality.name, department?.name, province?.name].filter(Boolean).join(', ');
  });

  protected readonly form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    subtype: ['MUNICIPAL' as OrgSubtype, Validators.required],
    planId: [null as number | null],
    // No existe "sin límite" (2026-07-23) para los barrios. Los de personal
    // admiten 0, que significa "esta cuenta no tiene ese rol".
    maxNeighborhoods: [null as number | null, [Validators.required, Validators.min(1)]],
    maxAdminUsers: [null as number | null, [Validators.required, Validators.min(0)]],
    maxTechnicianUsers: [null as number | null, [Validators.required, Validators.min(0)]],
    maxMonitorUsers: [null as number | null, [Validators.required, Validators.min(0)]],

    // Jurisdicción — solo MUNICIPAL. La comunitaria la deriva de su barrio.
    jurisdictionLevel: ['LOCALITY' as JurisdictionLevel],
    // Geografía en cascada. La localidad la usan la comunitaria (su barrio) y
    // la muni con nivel LOCALITY; el departamento, la muni con nivel DEPARTMENT.
    provinceId: [null as number | null],
    departmentId: [null as number | null],
    localityId: [null as number | null],

    ownerUsername: ['', [Validators.required, Validators.minLength(3)]],
    ownerEmail: [''],

    // Solo COMMUNITY. El NOMBRE del barrio no está acá: se deriva del nombre
    // del cliente (ver `nombreDelBarrio`), porque son la misma cosa.
    managedBy: ['CPS' as ManagedBy],
    localitySearch: [''],

    // El contrato va para los DOS tipos: es de la cuenta.
    contractPrice: [null as number | null, [Validators.required, Validators.min(0)]],
    contractStartDate: [hoy(), Validators.required],
    contractEndDate: ['', Validators.required],
    contractDescription: [''],
  });

  protected readonly isCommunity = () => this.form.controls.subtype.value === 'COMMUNITY';

  /** La muni con nivel DEPARTMENT elige provincia + departamento; con LOCALITY, busca la localidad. */
  protected readonly isDepartmentLevel = () =>
    !this.isCommunity() && this.form.controls.jurisdictionLevel.value === 'DEPARTMENT';

  protected readonly needsLocality = () =>
    this.isCommunity() || this.form.controls.jurisdictionLevel.value === 'LOCALITY';

  /** El combo de planes se recorta por subtipo: un plan municipal no se le vende a una comunitaria. */
  protected readonly plansForSubtype = () =>
    this.plansCatalog().filter((p) => p.appliesTo === this.form.controls.subtype.value);

  /** Cuánto dura el contrato, DERIVADO de las dos fechas: no se guarda en ningún lado. */
  protected readonly duracion = computed(() => this.duracionTexto());
  private readonly fechasVersion = signal(0);

  // ─────────────────────────── EL WIZARD ───────────────────────────

  protected readonly pasos = PASOS;
  protected readonly paso = signal<Paso>('tipo');

  /**
   * Se prende al intentar avanzar con algo incompleto, y es lo que hace que el
   * panel de faltantes aparezca. Antes de eso no se muestra nada en rojo: nadie
   * quiere ver un formulario recién abierto lleno de errores por campos que
   * todavía no llegó a llenar.
   */
  protected readonly intentoAvanzar = signal(false);

  /**
   * Pulso que obliga a recalcular los `faltantes`. El form no es una señal, así
   * que sin esto la lista de "qué falta" queda congelada.
   *
   * OJO: `form.valueChanges` NO alcanza. Media pantalla escribe con
   * `{ emitEvent: false }` —el plan al precargar los cupos, el subtipo al poner
   * técnicos en 0— y esas escrituras no emiten nada, así que llaman a
   * `revalidar()` a mano. La GEOGRAFÍA va por su propio `geoVersion`, que
   * `faltantesDe` también lee.
   *
   * No es un detalle: con solo `valueChanges`, cargar la localidad con el ATAJO
   * del buscador dejaba el panel diciendo "falta la localidad" y, como
   * `siguiente()` lee esa misma lista, el wizard quedaba TRABADO.
   */
  private readonly formVersion = signal(0);

  private revalidar(): void {
    this.formVersion.update((v) => v + 1);
  }

  protected readonly indicePaso = computed(() =>
    PASOS.findIndex((p) => p.id === this.paso()),
  );

  /**
   * QUÉ FALTA en un paso, en castellano y no como nombres de campo.
   *
   * Es la pieza central del rediseño. Antes el botón se apagaba con
   * `[disabled]="form.invalid"` y había que cazar el campo rojo en un scroll de
   * 560 líneas; peor todavía, la geografía NO tenía validador y el submit hacía
   * un `return` mudo, así que el botón quedaba habilitado y el click no hacía
   * NADA. Las dos cosas se arreglan acá: nada bloquea sin decir qué falta.
   */
  protected faltantesDe(paso: Paso): string[] {
    // Las dos versiones: `formVersion` para lo que se tipea, `geoVersion` para
    // la geografía, que se escribe entera con `emitEvent: false` y no dispara
    // `valueChanges`. Leer solo la primera dejaba el wizard trabado tras usar
    // el buscador de localidad.
    this.formVersion();
    this.geoVersion();
    const c = this.form.controls;
    const faltan: string[] = [];

    if (paso === 'cliente') {
      if (!c.name.value?.trim()) faltan.push('El nombre del cliente');
      // El de barrios no se pide a la comunitaria: lo fija el backend en 1.
      if (!this.isCommunity() && c.maxNeighborhoods.invalid) {
        faltan.push('El cupo de barrios (al menos 1)');
      }
      if (c.maxAdminUsers.invalid) faltan.push('El cupo de administradores');
      if (!this.isCommunity() && c.maxTechnicianUsers.invalid) {
        faltan.push('El cupo de técnicos');
      }
      if (c.maxMonitorUsers.invalid) faltan.push('El cupo de monitores');
    }

    if (paso === 'ubicacion') {
      // El nombre del barrio NO se pide: en una comunitaria el barrio y el
      // cliente son la misma cosa, así que se deriva del nombre del cliente.
      // Acá vivía el agujero: sin validador, faltar la localidad no invalidaba
      // el form y el submit se iba en silencio.
      if (this.needsLocality() && !c.localityId.value) {
        faltan.push('La localidad');
      }
      if (this.isDepartmentLevel() && !c.departmentId.value) {
        faltan.push('El departamento');
      }
      if (!this.tienePunto()) {
        faltan.push(`El punto en el mapa (${this.puntoLabel()})`);
      }
    }

    if (paso === 'contrato') {
      if (c.contractPrice.invalid) faltan.push('El precio del contrato');
      if (!c.contractStartDate.value) faltan.push('La fecha de inicio');
      if (!c.contractEndDate.value) faltan.push('La fecha de fin');
      // Cruce de fechas: antes no lo frenaba nadie — la duración quedaba vacía
      // y el contrato se mandaba al revés.
      if (
        c.contractStartDate.value &&
        c.contractEndDate.value &&
        c.contractEndDate.value < c.contractStartDate.value
      ) {
        faltan.push('La fecha de fin tiene que ser posterior a la de inicio');
      }
      if (c.ownerUsername.invalid) {
        faltan.push('El usuario del OWNER (al menos 3 caracteres)');
      }
    }

    return faltan;
  }

  /**
   * Un paso está completo cuando no le falta nada. `tipo` siempre lo está (el
   * subtipo arranca elegido) y `revisar` no pide nada propio.
   */
  protected pasoCompleto(paso: Paso): boolean {
    return paso === 'tipo' || paso === 'revisar' || this.faltantesDe(paso).length === 0;
  }

  protected readonly faltantesActuales = computed(() => this.faltantesDe(this.paso()));

  /** Todo lo que falta, mirado desde el paso final. */
  protected readonly faltantesTodos = computed(() => [
    ...this.faltantesDe('cliente'),
    ...this.faltantesDe('ubicacion'),
    ...this.faltantesDe('contrato'),
  ]);

  /**
   * El nombre del BARRIO de una comunitaria: el mismo que el del cliente.
   *
   * No se pregunta aparte porque en un consorcio la cuenta y el barrio son la
   * misma cosa — pedirlo dos veces daba dos campos que el que carga llenaba
   * igual, y habilitaba que quedaran distintos por una errata. Se puede
   * renombrar después desde la ficha del barrio, que es donde tiene sentido.
   */
  protected readonly nombreDelBarrio = computed(() => {
    this.formVersion();
    return this.form.controls.name.value?.trim() ?? '';
  });

  /** El campo "nombre" cambia de etiqueta según el tipo elegido en el paso 1. */
  protected readonly nombreLabel = computed(() => {
    this.formVersion();
    return this.isCommunity() ? 'Nombre de la comunidad' : 'Nombre de la municipalidad';
  });

  protected readonly nombrePlaceholder = computed(() => {
    this.formVersion();
    return this.isCommunity() ? 'Barrio Los Lapachos' : 'Municipalidad de San Pedro';
  });

  /** El pin que se marca en el mapa muestra lo que se está creando. */
  protected readonly pickVariant = computed<MapMarkerVariant>(() => {
    this.formVersion();
    return this.isCommunity() ? 'community' : 'municipal';
  });

  protected siguiente(): void {
    if (this.faltantesActuales().length > 0) {
      this.intentoAvanzar.set(true);
      this.form.markAllAsTouched();
      if (!this.tienePunto()) this.puntoFaltante.set(true);
      return;
    }
    this.intentoAvanzar.set(false);
    const siguiente = PASOS[this.indicePaso() + 1];
    if (siguiente) this.paso.set(siguiente.id);
  }

  protected anterior(): void {
    this.intentoAvanzar.set(false);
    const anterior = PASOS[this.indicePaso() - 1];
    if (anterior) this.paso.set(anterior.id);
  }

  /**
   * Saltar directo a un paso desde la barra de arriba. Para ATRÁS siempre se
   * puede; para adelante, solo si todo lo anterior está completo — si no, el
   * wizard dejaría de garantizar lo único que justifica partirlo en pasos.
   */
  protected irA(paso: Paso): void {
    const destino = PASOS.findIndex((p) => p.id === paso);
    if (destino <= this.indicePaso()) {
      this.intentoAvanzar.set(false);
      this.paso.set(paso);
      return;
    }
    const anteriores = PASOS.slice(0, destino).map((p) => p.id);
    if (anteriores.every((p) => this.pasoCompleto(p))) {
      this.intentoAvanzar.set(false);
      this.paso.set(paso);
    }
  }

  protected alcanzable(paso: Paso): boolean {
    const destino = PASOS.findIndex((p) => p.id === paso);
    if (destino <= this.indicePaso()) return true;
    return PASOS.slice(0, destino).every((p) => this.pasoCompleto(p.id));
  }

  // ───────────────────── Textos para el resumen ─────────────────────

  protected readonly resumenTipo = computed(() => {
    this.formVersion();
    return this.isCommunity()
      ? 'Comunitaria (un solo barrio)'
      : 'Municipal (varios barrios)';
  });

  protected readonly resumenPlan = computed(() => {
    this.formVersion();
    return this.selectedPlan()?.name ?? 'Sin plan — cupos a mano';
  });

  /** Dónde queda el cliente, según el tipo y el nivel de jurisdicción. */
  protected readonly resumenUbicacion = computed(() => {
    this.formVersion();
    this.geoVersion();
    if (this.needsLocality()) return this.selectedLocalityText();

    const department = this.departments().find(
      (d) => d.id === Number(this.form.controls.departmentId.value),
    );
    const province = this.provinces().find(
      (p) => p.id === Number(this.form.controls.provinceId.value),
    );
    return [department?.name, province?.name].filter(Boolean).join(', ');
  });

  /**
   * Un cupo de personal, en castellano. El 0 se dice distinto y no es un
   * capricho: cupo 0 significa que ese ROL NO EXISTE en la cuenta, no que se
   * quedó sin lugar. Es el último cartel que ve el operador antes de crear, así
   * que "0 técnicos" —que se lee como "se le acabaron"— sería engañoso.
   */
  protected cupoTexto(cantidad: number | null, singular: string): string {
    // Terminada en vocal suma "s", en consonante "es": técnico -> técnicos,
    // pero administrador -> administradores.
    const plural = /[aeiouáéíóú]$/i.test(singular) ? `${singular}s` : `${singular}es`;
    if (cantidad === 0) return `sin ${plural}`;
    return `${cantidad} ${cantidad === 1 ? singular : plural}`;
  }

  protected readonly resumenModalidad = computed(() => {
    this.formVersion();
    return this.form.controls.managedBy.value === 'CPS'
      ? 'Llave en mano — lo opera CPS'
      : 'Autogestión — lo opera la comunidad';
  });

  constructor() {
    // El caso normal: alguien tipea. Los `emitEvent: false` van aparte, con
    // `revalidar()` explícito (ver `formVersion`).
    this.form.valueChanges.subscribe(() => this.revalidar());

    this.plans.list({ active: true }).subscribe({
      next: (plans) => this.plansCatalog.set(plans),
      // Sin catálogo el alta sigue andando con los cupos a mano: no vale la
      // pena bloquear una venta porque no cargó un combo de conveniencia.
      error: () => this.plansCatalog.set([]),
    });

    this.geography.provinces().subscribe({
      next: (provinces) => this.provinces.set(provinces),
      error: () => this.provinces.set([]),
    });

    // El username se SUGIERE del nombre mientras se tipea, y deja de sugerirse
    // apenas alguien lo toca a mano: pisarle lo que escribió sería peor que no
    // sugerir nada.
    this.form.controls.name.valueChanges.subscribe((name) => {
      if (this.form.controls.ownerUsername.dirty) return;
      this.form.controls.ownerUsername.setValue(deriveUsername(name ?? ''), {
        emitEvent: false,
      });
    });

    this.form.controls.subtype.valueChanges.subscribe((subtype) => {
      const community = subtype === 'COMMUNITY';

      // El punto cambia de significado con el tipo (barrio vs sede): se limpia
      // para no dejar la sede de una muni marcando el barrio de un consorcio.
      this.resetPunto();

      if (community) {
        // COMMUNITY gestiona un único barrio, que se crea acá mismo: el cupo lo
        // fija el backend en 1 y el de técnicos va en 0 (el campo lo hace CPS).
        this.form.controls.maxNeighborhoods.disable();
        this.form.controls.maxNeighborhoods.clearValidators();
        this.form.controls.maxTechnicianUsers.setValue(0, { emitEvent: false });
      } else {
        this.form.controls.maxNeighborhoods.enable();
        this.form.controls.maxNeighborhoods.setValidators([Validators.required, Validators.min(1)]);
        // Cambiar de tipo cambia qué significa la geografía cargada: la de una
        // comunitaria es la de su barrio, la de una muni es su jurisdicción.
        this.resetGeografia();
      }
      this.form.controls.maxNeighborhoods.updateValueAndValidity();

      // El plan elegido puede no aplicar al subtipo nuevo: se limpia en vez de
      // quedar seleccionado en un combo donde ya no figura.
      const plan = this.selectedPlan();
      if (plan && plan.appliesTo !== subtype) this.form.controls.planId.setValue(null);

      // El subtipo cambia QUÉ campos se piden (barrios y técnicos desaparecen
      // en la comunitaria), así que la lista de faltantes es otra.
      this.revalidar();
    });

    // Cambiar de nivel de jurisdicción limpia la geografía: si no, se manda una
    // localidad Y un departamento y el backend rebota (el CHECK exige uno solo).
    this.form.controls.jurisdictionLevel.valueChanges.subscribe(() => this.resetGeografia());

    // Los combos hijos arrancan deshabilitados. OJO: con `formControlName`,
    // Angular IGNORA el binding [disabled] del template — hay que hacerlo acá.
    this.form.controls.departmentId.disable({ emitEvent: false });
    this.form.controls.localityId.disable({ emitEvent: false });

    this.form.controls.provinceId.valueChanges.subscribe((provinceId) => {
      this.resetDesde('department');
      if (!provinceId) return;

      // Vuela apenas se elige, sin esperar la lista de departamentos: el
      // movimiento del mapa es la confirmación de que el combo hizo algo.
      this.volarA(
        this.provinces().find((p) => p.id === Number(provinceId)),
        ZOOM_PROVINCIA,
      );

      this.geography.departments(Number(provinceId)).subscribe({
        next: (departments) => {
          this.departments.set(departments);
          this.form.controls.departmentId.enable({ emitEvent: false });
          this.geoVersion.update((v) => v + 1);
        },
        error: () => this.departments.set([]),
      });
    });

    this.form.controls.departmentId.valueChanges.subscribe((departmentId) => {
      this.resetDesde('locality');
      if (!departmentId) return;

      this.volarA(
        this.departments().find((d) => d.id === Number(departmentId)),
        ZOOM_DEPARTAMENTO,
      );

      this.geography.localities(Number(departmentId)).subscribe({
        next: (localities) => {
          this.localities.set(localities);
          this.form.controls.localityId.enable({ emitEvent: false });
          this.geoVersion.update((v) => v + 1);
        },
        error: () => this.localities.set([]),
      });
    });

    this.form.controls.localityId.valueChanges.subscribe((localityId) => {
      this.geoVersion.update((v) => v + 1);
      if (!localityId) return;

      this.volarA(
        this.localities().find((l) => l.id === Number(localityId)),
        ZOOM_LOCALIDAD,
      );
    });

    // Elegir un plan PRECARGA los cupos, no los congela: quedan editables para
    // el ajuste puntual de esa venta. Se manda igual el planId, para dejar
    // registrado con qué se vendió aunque los números finales sean otros.
    this.form.controls.planId.valueChanges.subscribe(() => {
      const plan = this.selectedPlan();
      if (!plan) return;
      this.form.patchValue(
        {
          maxNeighborhoods: plan.maxNeighborhoods,
          maxAdminUsers: plan.maxAdminUsers,
          maxTechnicianUsers: plan.maxTechnicianUsers,
          maxMonitorUsers: plan.maxMonitorUsers,
        },
        { emitEvent: false },
      );
      this.revalidar();
    });

    for (const control of [
      this.form.controls.contractStartDate,
      this.form.controls.contractEndDate,
    ]) {
      control.valueChanges.subscribe(() => this.fechasVersion.update((v) => v + 1));
    }

    this.form.controls.localitySearch.valueChanges
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((term) => {
          if ((term ?? '').trim().length < 2) {
            this.localityResults.set([]);
            this.searchingLocality.set(false);
            return [];
          }
          this.searchingLocality.set(true);
          return this.geography.searchLocalities((term ?? '').trim());
        }),
      )
      .subscribe({
        next: (localities) => {
          this.localityResults.set(localities);
          this.searchingLocality.set(false);
        },
        error: () => this.searchingLocality.set(false),
      });
  }

  /** Atajo de plazo: calcula la fecha de fin. El período NO se guarda. */
  protected aplicarPlazo(meses: number): void {
    const desde = this.form.controls.contractStartDate.value || hoy();
    this.form.controls.contractEndDate.setValue(sumarMeses(desde, meses));
  }

  private duracionTexto(): string {
    this.fechasVersion();
    const desde = this.form.controls.contractStartDate.value;
    const hasta = this.form.controls.contractEndDate.value;
    if (!desde || !hasta || hasta < desde) return '';

    const [a1, m1, d1] = desde.split('-').map(Number);
    const [a2, m2, d2] = hasta.split('-').map(Number);
    let meses = (a2 - a1) * 12 + (m2 - m1);
    if (d2 < d1) meses -= 1;

    if (meses < 1) return 'menos de un mes';
    if (meses % 12 === 0) {
      const anios = meses / 12;
      return anios === 1 ? '1 año' : `${anios} años`;
    }
    return meses === 1 ? '1 mes' : `${meses} meses`;
  }

  /** El `<select>` devuelve string aunque el valor sea numérico: se normaliza acá. */
  private selectedPlan(): Plan | null {
    const raw = this.form.controls.planId.value;
    if (raw === null || raw === undefined || String(raw) === 'null') return null;
    return this.plansCatalog().find((p) => p.id === Number(raw)) ?? null;
  }

  /** Limpia los tres niveles a la vez. */
  private resetGeografia(): void {
    this.form.controls.localitySearch.setValue('', { emitEvent: false });
    this.form.controls.provinceId.setValue(null, { emitEvent: false });
    this.resetDesde('department');
  }

  /** Limpia de un nivel para abajo: cambiar el padre invalida a los hijos. */
  private resetDesde(nivel: 'department' | 'locality'): void {
    if (nivel === 'department') {
      this.form.controls.departmentId.setValue(null, { emitEvent: false });
      this.form.controls.departmentId.disable({ emitEvent: false });
      this.departments.set([]);
    }
    this.form.controls.localityId.setValue(null, { emitEvent: false });
    this.form.controls.localityId.disable({ emitEvent: false });
    this.localities.set([]);
    this.geoVersion.update((v) => v + 1);
  }

  /**
   * El buscador es un atajo: elegir un resultado PRECARGA los tres combos, así
   * quedan coherentes y el que carga puede seguir ajustando a mano desde ahí.
   *
   * El resultado ya trae el árbol completo (localidad -> depto -> provincia),
   * así que los ids salen de ahí; lo que hay que pedir son las LISTAS, para que
   * los combos tengan qué mostrar.
   */
  protected selectLocality(locality: Locality): void {
    this.localityResults.set([]);
    this.form.controls.localitySearch.setValue(this.fullLocalityName(locality), {
      emitEvent: false,
    });

    const department = locality.department;
    const provinceId = department.province.id;

    // El atajo salta los tres niveles de una, así que vuela DIRECTO a la
    // localidad: encadenar provincia → depto → localidad acá sería una animación
    // de tres tramos para una sola decisión.
    this.volarA(locality, ZOOM_LOCALIDAD);

    this.form.controls.provinceId.setValue(provinceId, { emitEvent: false });

    // Cada id se setea DESPUÉS de que llegó su lista: un <select> no puede
    // quedarse con un valor cuya <option> todavía no existe — se ve vacío.
    this.geography.departments(provinceId).subscribe({
      next: (departments) => {
        this.departments.set(departments);
        this.form.controls.departmentId.enable({ emitEvent: false });
        this.form.controls.departmentId.setValue(department.id, { emitEvent: false });
        this.geoVersion.update((v) => v + 1);
      },
      error: () => this.departments.set([]),
    });

    this.geography.localities(department.id).subscribe({
      next: (localities) => {
        this.localities.set(localities);
        this.form.controls.localityId.enable({ emitEvent: false });
        this.form.controls.localityId.setValue(locality.id, { emitEvent: false });
        this.geoVersion.update((v) => v + 1);
      },
      error: () => this.localities.set([]),
    });
  }

  /** Localidad + departamento + provincia: hay 3 "Villa María" en el país. */
  protected fullLocalityName(locality: Locality): string {
    return `${locality.name}, ${locality.department.name}, ${locality.department.province.name}`;
  }

  /**
   * Crear. Solo se llega acá desde el paso `revisar`, y ese paso solo se
   * alcanza con todo completo — pero el chequeo se repite igual: es la última
   * puerta antes de un POST irreversible, y sale gratis.
   *
   * Si algo falta (por ejemplo porque se volvió atrás y se borró un campo), NO
   * hace un return mudo: manda al paso que tiene el problema.
   */
  protected submit(): void {
    if (this.saving()) return;

    for (const paso of ['cliente', 'ubicacion', 'contrato'] as const) {
      if (this.faltantesDe(paso).length > 0) {
        this.intentoAvanzar.set(true);
        this.form.markAllAsTouched();
        if (!this.tienePunto()) this.puntoFaltante.set(true);
        this.paso.set(paso);
        return;
      }
    }

    const latitude = this.latitude()!;
    const longitude = this.longitude()!;

    const value = this.form.getRawValue();
    const planId = this.selectedPlan()?.id;

    const contract = {
      price: Number(value.contractPrice),
      startDate: value.contractStartDate,
      endDate: value.contractEndDate,
      ...(value.contractDescription ? { description: value.contractDescription } : {}),
    };

    const owner = {
      ownerUsername: value.ownerUsername,
      ...(value.ownerEmail ? { ownerEmail: value.ownerEmail } : {}),
    };

    if (this.isCommunity()) {
      // Ya lo garantizó `faltantesDe('ubicacion')`; el `!` es para el tipo.
      const localityId = Number(value.localityId);

      this.saving.set(true);
      this.error.set(null);

      // Todo en un solo POST atómico: el backend lo hace todo o nada, así
      // nunca queda una cuenta comunitaria sin su barrio ni sin su contrato.
      this.accounts
        .onboardCommunity({
          name: value.name,
          managedBy: value.managedBy,
          ...(planId ? { planId } : {}),
          maxAdminUsers: value.maxAdminUsers!,
          maxTechnicianUsers: value.maxTechnicianUsers!,
          maxMonitorUsers: value.maxMonitorUsers!,
          ...owner,
          neighborhood: {
            // Igual que el cliente: en un consorcio son la misma cosa.
            name: this.nombreDelBarrio(),
            localityId,
            // El punto del barrio, que el backend copia también a la cuenta.
            latitude,
            longitude,
          },
          contract,
        })
        .subscribe({
          next: (result) =>
            this.onCreated(result.account.id, result.ownerUsername, result.temporaryPassword),
          error: (err) => this.onError(err),
        });
      return;
    }

    // MUNICIPAL: la jurisdicción se elige. Va exactamente UNO de los dos ids,
    // el que corresponde al nivel: el CHECK de la base no admite los dos. Que
    // el id correcto esté cargado ya lo garantizó `faltantesDe('ubicacion')`.
    const level = value.jurisdictionLevel;

    this.saving.set(true);
    this.error.set(null);

    this.accounts
      .onboardMunicipal({
        name: value.name,
        jurisdiction:
          level === 'LOCALITY'
            ? { level, localityId: Number(value.localityId) }
            : { level, departmentId: Number(value.departmentId) },
        // La SEDE, aparte de la jurisdicción: un edificio no es un límite.
        latitude,
        longitude,
        contract,
        ...(planId ? { planId } : {}),
        // El form ya validó que no son null (Validators.required + min).
        maxNeighborhoods: value.maxNeighborhoods!,
        maxAdminUsers: value.maxAdminUsers!,
        maxTechnicianUsers: value.maxTechnicianUsers!,
        maxMonitorUsers: value.maxMonitorUsers!,
        ...owner,
      })
      .subscribe({
        next: (result) =>
          this.onCreated(result.account.id, result.ownerUsername, result.temporaryPassword),
        error: (err) => this.onError(err),
      });
  }

  private onCreated(accountId: number, ownerUsername: string, temporaryPassword: string): void {
    this.saving.set(false);
    this.created.set({ accountId, ownerUsername, temporaryPassword });
  }

  private onError(err: unknown): void {
    this.error.set(apiErrorMessage(err));
    this.saving.set(false);
  }

  protected copyTemporaryPassword(value: string): void {
    void navigator.clipboard.writeText(value).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    });
  }

  protected continueToAccount(accountId: number): void {
    void this.router.navigate(['/clientes', accountId]);
  }
}
