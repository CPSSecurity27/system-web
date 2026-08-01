import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { debounceTime, distinctUntilChanged, switchMap } from 'rxjs';

import { AccountsService } from '../../core/api/accounts.service';
import { GeographyService } from '../../core/api/geography.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Account } from '../../core/models/api.models';
import { Locality } from '../../core/models/neighborhood';
import { Map } from '../../shared/map/map';

/**
 * v2: el alta ya no es solo-CPS. CPS crea barrios para cualquier organización;
 * el OWNER/ADMIN de una organización crea los SUYOS, contra su cupo (el 400
 * comercial se muestra tal cual: es la tarifa, no un error).
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

  /** Resultados del autocomplete. El backend ignora acentos: "cordoba" → "Córdoba". */
  protected readonly results = signal<Locality[]>([]);
  protected readonly searching = signal(false);
  protected readonly selected = signal<Locality | null>(null);

  /**
   * Solo CPS elige la organización dueña; una org siempre crea para sí.
   *
   * SOLO MUNICIPALES: una comunitaria gestiona UN único barrio y ese barrio
   * nace con la cuenta (onboarding atómico), así que su cupo ya está consumido
   * el día 1. Ofrecerla acá sería ofrecer una puerta que siempre da al 400 de
   * cupo. Es la misma razón por la que `neighborhoodManagerGuard` no deja
   * entrar a esta pantalla al admin de una comunitaria.
   */
  protected readonly accountList = signal<Account[]>([]);
  protected readonly organizations = computed(() =>
    this.accountList().filter((a) => a.type === 'ORGANIZATION' && a.subtype === 'MUNICIPAL'),
  );

  protected readonly form = this.fb.group({
    name: ['', Validators.required],
    search: [''],
    organizationId: [null as number | null],
  });

  /**
   * El punto en el mapa. OPCIONAL: sirve para ubicar el barrio, no para
   * validar nada — el que decide dónde puede estar es la LOCALIDAD, que se
   * chequea contra la jurisdicción del cliente en el backend.
   *
   * Nadie tipea coordenadas: se clickea el mapa, igual que en el alta de
   * vivienda y en la instalación de un equipo.
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

  constructor() {
    if (this.auth.isCps()) {
      this.form.controls.organizationId.addValidators(Validators.required);
      this.accounts.list().subscribe({
        next: (accounts) => this.accountList.set(accounts),
        error: (err) => this.error.set(apiErrorMessage(err)),
      });
    }

    this.form.controls.search.valueChanges
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((term) => {
          // El backend pide mínimo 2 caracteres.
          if ((term ?? '').trim().length < 2) {
            this.results.set([]);
            this.searching.set(false);
            return [];
          }
          this.searching.set(true);
          return this.geography.searchLocalities((term ?? '').trim());
        }),
      )
      .subscribe({
        next: (localities) => {
          this.results.set(localities);
          this.searching.set(false);
        },
        error: () => this.searching.set(false),
      });
  }

  protected select(locality: Locality): void {
    this.selected.set(locality);
    this.results.set([]);
    this.form.controls.search.setValue(this.fullName(locality), { emitEvent: false });
  }

  /** Localidad + departamento + provincia: hay 3 "Villa María" en el país. */
  protected fullName(locality: Locality): string {
    return `${locality.name}, ${locality.department.name}, ${locality.department.province.name}`;
  }

  protected submit(): void {
    const locality = this.selected();

    if (this.form.controls.name.invalid || !locality || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const { name, organizationId } = this.form.getRawValue();

    if (this.auth.isCps() && !organizationId) {
      this.form.markAllAsTouched();
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    const lat = this.latitude();
    const lng = this.longitude();

    this.neighborhoods
      .create({
        name: name as string,
        localityId: locality.id,
        // La organización solo la manda CPS: una org crea para sí misma.
        ...(this.auth.isCps() && organizationId ? { organizationId } : {}),
        // El punto es opcional: si no se marcó, no se manda.
        ...(lat !== null && lng !== null ? { latitude: lat, longitude: lng } : {}),
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
