import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { debounceTime, distinctUntilChanged, switchMap } from 'rxjs';

import { AccountsService } from '../../core/api/accounts.service';
import { GeographyService } from '../../core/api/geography.service';
import { PlansService } from '../../core/api/plans.service';
import { apiErrorMessage } from '../../core/http/api-error';
import {
  JurisdictionLevel,
  ManagedBy,
  OrgSubtype,
  Plan,
} from '../../core/models/api.models';
import { Department, Locality, Province } from '../../core/models/neighborhood';
import { Map } from '../../shared/map/map';
import { Alert } from '../../shared/ui/alert/alert';
import { PageHeader } from '../../shared/ui/page-header/page-header';

/** Lo que queda para mostrar una sola vez tras crear la cuenta: la clave no se puede volver a leer. */
interface CreatedAccountResult {
  accountId: number;
  ownerUsername: string;
  temporaryPassword: string;
}

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
   * El punto del BARRIO de la comunitaria. Opcional, y solo aplica ahí: la
   * municipalidad no crea barrio en el alta.
   *
   * Es también el punto de la CUENTA: el consorcio y su barrio son el mismo
   * lugar, así que el backend copia estas coordenadas a la cuenta
   * (AccountsService#onboardCommunity).
   */
  protected readonly latitude = signal<number | null>(null);
  protected readonly longitude = signal<number | null>(null);

  protected setPosition(position: { latitude: number; longitude: number }): void {
    this.latitude.set(position.latitude);
    this.longitude.set(position.longitude);
  }

  protected clearPosition(): void {
    this.latitude.set(null);
    this.longitude.set(null);
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

    // Solo COMMUNITY (con validators, ver constructor).
    managedBy: ['CPS' as ManagedBy],
    neighborhoodName: [''],
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

  constructor() {
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

      if (community) {
        // COMMUNITY gestiona un único barrio, que se crea acá mismo: el cupo lo
        // fija el backend en 1 y el de técnicos va en 0 (el campo lo hace CPS).
        this.form.controls.maxNeighborhoods.disable();
        this.form.controls.maxNeighborhoods.clearValidators();
        this.form.controls.maxTechnicianUsers.setValue(0, { emitEvent: false });
        this.form.controls.neighborhoodName.setValidators(Validators.required);
      } else {
        this.form.controls.maxNeighborhoods.enable();
        this.form.controls.maxNeighborhoods.setValidators([Validators.required, Validators.min(1)]);
        this.form.controls.neighborhoodName.clearValidators();
        // Cambiar de tipo cambia qué significa la geografía cargada: la de una
        // comunitaria es la de su barrio, la de una muni es su jurisdicción.
        this.resetGeografia();
      }
      this.form.controls.maxNeighborhoods.updateValueAndValidity();
      this.form.controls.neighborhoodName.updateValueAndValidity();

      // El plan elegido puede no aplicar al subtipo nuevo: se limpia en vez de
      // quedar seleccionado en un combo donde ya no figura.
      const plan = this.selectedPlan();
      if (plan && plan.appliesTo !== subtype) this.form.controls.planId.setValue(null);
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

      this.geography.localities(Number(departmentId)).subscribe({
        next: (localities) => {
          this.localities.set(localities);
          this.form.controls.localityId.enable({ emitEvent: false });
          this.geoVersion.update((v) => v + 1);
        },
        error: () => this.localities.set([]),
      });
    });

    this.form.controls.localityId.valueChanges.subscribe(() =>
      this.geoVersion.update((v) => v + 1),
    );

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

  protected submit(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

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
      const localityId = value.localityId ? Number(value.localityId) : null;
      if (!localityId) {
        this.form.markAllAsTouched();
        return;
      }

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
            name: value.neighborhoodName,
            localityId,
            // El punto es opcional; si se marcó, va al barrio Y a la cuenta.
            ...(this.latitude() !== null && this.longitude() !== null
              ? { latitude: this.latitude()!, longitude: this.longitude()! }
              : {}),
          },
          contract,
        })
        .subscribe({
          next: (result) => this.onCreated(result.account.id, result.ownerUsername, result.temporaryPassword),
          error: (err) => this.onError(err),
        });
      return;
    }

    // MUNICIPAL: la jurisdicción se elige. Va exactamente UNO de los dos ids,
    // el que corresponde al nivel: el CHECK de la base no admite los dos.
    const level = value.jurisdictionLevel;
    if (level === 'LOCALITY' && !value.localityId) {
      this.form.markAllAsTouched();
      return;
    }
    if (level === 'DEPARTMENT' && !value.departmentId) {
      this.form.markAllAsTouched();
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    this.accounts
      .onboardMunicipal({
        name: value.name,
        jurisdiction:
          level === 'LOCALITY'
            ? { level, localityId: Number(value.localityId) }
            : { level, departmentId: Number(value.departmentId) },
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
        next: (result) => this.onCreated(result.account.id, result.ownerUsername, result.temporaryPassword),
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
