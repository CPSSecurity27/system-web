import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { AccountsService } from '../../core/api/accounts.service';
import { GeographyService } from '../../core/api/geography.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Account } from '../../core/models/api.models';
import { Locality } from '../../core/models/neighborhood';
import { Map } from '../../shared/map/map';

/**
 * Escala de calles: es donde se distingue una manzana de otra, que es lo que
 * hace falta para marcar un barrio. Mismo criterio que el alta de cliente.
 */
const ZOOM_LOCALIDAD = 13;
/** Un departamento entero no entra a escala de calles. */
const ZOOM_DEPARTAMENTO = 10;

/**
 * v2: el alta ya no es solo-CPS. CPS crea barrios para cualquier organización;
 * el OWNER/ADMIN de una organización crea los SUYOS, contra su cupo (el 400
 * comercial se muestra tal cual: es la tarifa, no un error).
 *
 * LA LOCALIDAD NO SE BUSCA A MANO. Sale de la JURISDICCIÓN del cliente, que es
 * lo que se le vendió y lo que decide dónde puede tener barrios:
 *
 *   jurisdicción LOCALITY   -> hay UNA sola localidad posible: se muestra, no
 *                              se pregunta. Preguntarla era pedir un dato con
 *                              una única respuesta válida que el sistema ya
 *                              conoce, y dejaba elegir cualquier localidad del
 *                              país para que el backend la rechazara después.
 *   jurisdicción DEPARTMENT -> hay varias: se elige de un combo acotado a ESE
 *                              departamento.
 *
 * `assertDentroDeJurisdiccion` en el backend sigue siendo la autoridad; esto
 * hace que el formulario no ofrezca puertas que dan a un 400.
 */
@Component({
  selector: 'app-neighborhood-form',
  imports: [ReactiveFormsModule, RouterLink, Map],
  templateUrl: './neighborhood-form.html',
})
export class NeighborhoodForm {
  private readonly geography = inject(GeographyService);
  private readonly neighborhoods = inject(NeighborhoodsService);
  private readonly accounts = inject(AccountsService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  protected readonly auth = inject(AuthService);

  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly cargandoCuentas = signal(true);

  /**
   * Las cuentas que el usuario alcanza. CPS ve todas (y elige); una
   * organización recibe SOLO la suya del backend, así que no elige nada — pero
   * igual la necesitamos, porque de su jurisdicción sale la localidad.
   *
   * SOLO MUNICIPALES en el combo: una comunitaria gestiona UN único barrio y
   * ese barrio nace con la cuenta (onboarding atómico), así que su cupo ya está
   * consumido el día 1. Ofrecerla sería una puerta que siempre da al 400 de
   * cupo — la misma razón por la que `neighborhoodManagerGuard` no deja entrar
   * acá al admin de una comunitaria.
   */
  protected readonly accountList = signal<Account[]>([]);
  protected readonly organizations = computed(() =>
    this.accountList().filter((a) => a.type === 'ORGANIZATION' && a.subtype === 'MUNICIPAL'),
  );

  protected readonly form = this.fb.group({
    name: ['', Validators.required],
    organizationId: [null as number | null],
    /** Solo con jurisdicción DEPARTMENT: cuál de sus localidades. */
    localityId: [null as number | null],
    /**
     * ACTIVACIÓN COMUNITARIA con la que nace el barrio. Solo CPS la fija: es un
     * cupo (regla 4) y el backend rechaza con 403 a quien no sea CPS. Para una
     * organización el campo ni se manda — su barrio hereda el de su cuenta.
     */
    communityScopeEnabled: [true],
  });

  /** Las localidades del departamento del cliente (solo jurisdicción DEPARTMENT). */
  protected readonly localidadesDelDepartamento = signal<Locality[]>([]);

  /**
   * El punto en el mapa. OBLIGATORIO desde la migración `MandatoryCoordinates`:
   * el barrio sale en el tablero de clientes y en el mapa del monitoreo, y un
   * punto opcional deja los dos a medias. También cierra una incoherencia — la
   * VIVIENDA ya estaba obligada a tener GPS y el barrio que la contiene, no.
   *
   * Ubica, no valida: quien decide dónde PUEDE estar el barrio es la LOCALIDAD.
   *
   * Nadie tipea coordenadas: se clickea el mapa, igual que en el alta de
   * vivienda y en la instalación de un equipo. Como no vive en el form group,
   * el "falta el punto" lo avisa `puntoFaltante` — sin eso el botón quedaría
   * habilitado y el click no haría nada.
   */
  protected readonly latitude = signal<number | null>(null);
  protected readonly longitude = signal<number | null>(null);
  protected readonly puntoFaltante = signal(false);

  protected readonly tienePunto = computed(
    () => this.latitude() !== null && this.longitude() !== null,
  );

  /** A dónde vuela el mapa. Acompaña la elección; el punto lo marca la persona. */
  protected readonly focoGeo = signal<{
    latitude: number;
    longitude: number;
    zoom: number;
  } | null>(null);

  protected setPosition(position: { latitude: number; longitude: number }): void {
    this.latitude.set(position.latitude);
    this.longitude.set(position.longitude);
    this.puntoFaltante.set(false);
  }

  /** Se recalcula al cambiar el combo; para una organización es su única cuenta. */
  private readonly organizationIdVersion = signal(0);

  protected readonly organizacion = computed<Account | null>(() => {
    this.organizationIdVersion();
    const lista = this.organizations();
    if (!this.auth.isCps()) return lista[0] ?? null;

    const id = this.form.controls.organizationId.value;
    return id ? (lista.find((a) => a.id === Number(id)) ?? null) : null;
  });

  /** Con jurisdicción LOCALITY la localidad está DETERMINADA: no se pregunta. */
  protected readonly localidadFijada = computed<Locality | null>(() => {
    const org = this.organizacion();
    if (!org || org.jurisdictionLevel !== 'LOCALITY') return null;
    return org.locality;
  });

  protected readonly eligeLocalidad = computed(
    () => this.organizacion()?.jurisdictionLevel === 'DEPARTMENT',
  );

  /** La localidad final del barrio, venga de donde venga. */
  protected readonly localidadElegida = computed<Locality | null>(() => {
    const fijada = this.localidadFijada();
    if (fijada) return fijada;

    const id = this.form.controls.localityId.value;
    if (!id) return null;
    return this.localidadesDelDepartamento().find((l) => l.id === Number(id)) ?? null;
  });

  constructor() {
    // La lista se pide SIEMPRE, no solo para CPS: una organización no elige
    // cuenta, pero su jurisdicción es la que determina la localidad del barrio.
    // El backend ya recorta por alcance, así que le llega solo la suya.
    if (this.auth.isCps()) {
      this.form.controls.organizationId.addValidators(Validators.required);
    }

    this.accounts.list().subscribe({
      next: (accounts) => {
        this.accountList.set(accounts);
        this.cargandoCuentas.set(false);
        // Una organización tiene una sola cuenta: se aplica de una, sin que
        // haya que elegir nada.
        if (!this.auth.isCps()) this.aplicarOrganizacion();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.cargandoCuentas.set(false);
      },
    });

    this.form.controls.organizationId.valueChanges.subscribe(() => {
      this.organizationIdVersion.update((v) => v + 1);
      this.aplicarOrganizacion();
    });
  }

  /**
   * Al saber de qué cliente es el barrio: vuela el mapa hasta él y resuelve la
   * localidad según su jurisdicción.
   *
   * El vuelo es lo que faltaba: antes elegías la municipalidad y el mapa se
   * quedaba en Córdoba capital, así que para un barrio de Jujuy había que
   * arrastrar medio país antes de poder marcar el punto.
   */
  private aplicarOrganizacion(): void {
    this.organizationIdVersion.update((v) => v + 1);

    const org = this.organizacion();
    // El switch arranca en lo que el barrio HEREDARÍA de su cuenta: así CPS ve
    // lo vendido antes de decidir si este barrio se aparta.
    if (org?.communityScopeEnabled !== null && org?.communityScopeEnabled !== undefined) {
      this.form.controls.communityScopeEnabled.setValue(org.communityScopeEnabled, {
        emitEvent: false,
      });
    }
    this.form.controls.localityId.setValue(null, { emitEvent: false });
    this.localidadesDelDepartamento.set([]);
    if (!org) return;

    // Con jurisdicción DEPARTMENT hay que elegir entre SUS localidades: el
    // combo se carga acotado, así no se puede elegir una fuera del límite.
    if (org.jurisdictionLevel === 'DEPARTMENT' && org.departmentId) {
      this.geography.localities(org.departmentId).subscribe({
        next: (localidades) => this.localidadesDelDepartamento.set(localidades),
        error: () => this.localidadesDelDepartamento.set([]),
      });
    }

    // Se vuela al PUNTO del cliente (su sede) si lo tiene; si no, al centroide
    // de su jurisdicción, que siempre existe.
    const jurisdiccion = org.locality ?? org.department;
    const destino =
      org.latitude !== null && org.longitude !== null
        ? { latitude: org.latitude, longitude: org.longitude }
        : jurisdiccion && jurisdiccion.latitude !== null && jurisdiccion.longitude !== null
          ? { latitude: jurisdiccion.latitude, longitude: jurisdiccion.longitude }
          : null;

    if (destino) {
      this.focoGeo.set({
        ...destino,
        zoom: org.jurisdictionLevel === 'DEPARTMENT' ? ZOOM_DEPARTAMENTO : ZOOM_LOCALIDAD,
      });
    }
  }

  /** Al elegir una localidad del departamento, el mapa se acerca a ella. */
  protected onLocalidad(): void {
    const locality = this.localidadElegida();
    if (locality?.latitude != null && locality.longitude != null) {
      this.focoGeo.set({
        latitude: locality.latitude,
        longitude: locality.longitude,
        zoom: ZOOM_LOCALIDAD,
      });
    }
  }

  /** Localidad + departamento + provincia: hay 3 "Villa María" en el país. */
  protected fullName(locality: Locality): string {
    return `${locality.name}, ${locality.department.name}, ${locality.department.province.name}`;
  }

  /**
   * Qué falta para crear, en castellano. Igual que en el alta de cliente: nada
   * bloquea sin decir por qué.
   */
  protected readonly faltantes = computed<string[]>(() => {
    this.organizationIdVersion();
    const faltan: string[] = [];

    if (!this.form.controls.name.value?.trim()) faltan.push('El nombre del barrio');
    if (this.auth.isCps() && !this.organizacion()) {
      faltan.push('La municipalidad dueña del barrio');
    }
    if (this.eligeLocalidad() && !this.localidadElegida()) {
      faltan.push('La localidad dentro del departamento del cliente');
    }
    if (!this.tienePunto()) faltan.push('El punto del barrio en el mapa');

    return faltan;
  });

  protected readonly intento = signal(false);

  protected submit(): void {
    if (this.saving()) return;

    if (this.faltantes().length > 0) {
      this.intento.set(true);
      this.form.markAllAsTouched();
      if (!this.tienePunto()) this.puntoFaltante.set(true);
      return;
    }

    const { name, organizationId, communityScopeEnabled } = this.form.getRawValue();
    const locality = this.localidadElegida()!;

    this.saving.set(true);
    this.error.set(null);

    this.neighborhoods
      .create({
        name: name as string,
        localityId: locality.id,
        // La organización solo la manda CPS: una org crea para sí misma.
        ...(this.auth.isCps() && organizationId ? { organizationId } : {}),
        // La activación comunitaria TAMBIÉN solo la manda CPS: es un cupo y el
        // backend responde 403 a cualquier otro. Una organización la omite y su
        // barrio hereda la de su cuenta.
        ...(this.auth.isCps()
          ? { communityScopeEnabled: communityScopeEnabled ?? true }
          : {}),
        latitude: this.latitude()!,
        longitude: this.longitude()!,
      })
      .subscribe({
        next: () => void this.router.navigate(['/barrios']),
        error: (err) => {
          // El 400 de cupo trae el mensaje comercial: se muestra tal cual.
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }
}
