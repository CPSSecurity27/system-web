import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { HomesService } from '../../core/api/homes.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Home } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';

@Component({
  selector: 'app-home-list',
  imports: [RouterLink, FormsModule],
  templateUrl: './home-list.html',
})
export class HomeList {
  private readonly homes = inject(HomesService);
  private readonly neighborhoods = inject(NeighborhoodsService);
  protected readonly auth = inject(AuthService);

  protected readonly items = signal<Home[]>([]);
  protected readonly barrios = signal<Neighborhood[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  /** Filtro por barrio. Vacío = todas las que el usuario puede ver. */
  protected filter: number | '' = '';

  constructor() {
    forkJoin({
      homes: this.homes.list(),
      barrios: this.neighborhoods.list(),
    }).subscribe({
      next: ({ homes, barrios }) => {
        this.items.set(homes);
        this.barrios.set(barrios);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected onFilterChange(): void {
    this.loading.set(true);
    this.error.set(null);

    this.homes.list(this.filter === '' ? undefined : Number(this.filter)).subscribe({
      next: (homes) => {
        this.items.set(homes);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected barrioName(id: number): string {
    return this.barrios().find((b) => b.id === id)?.name ?? `Barrio #${id}`;
  }
}
