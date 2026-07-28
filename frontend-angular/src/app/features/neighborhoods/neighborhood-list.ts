import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Neighborhood } from '../../core/models/neighborhood';

@Component({
  selector: 'app-neighborhood-list',
  imports: [RouterLink],
  templateUrl: './neighborhood-list.html',
})
export class NeighborhoodList {
  private readonly neighborhoods = inject(NeighborhoodsService);
  protected readonly auth = inject(AuthService);

  protected readonly items = signal<Neighborhood[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);

    this.neighborhoods.list().subscribe({
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
}
