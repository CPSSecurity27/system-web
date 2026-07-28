import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { AccountsService } from '../../core/api/accounts.service';
import { ContractsService } from '../../core/api/contracts.service';
import { NeighborhoodsService } from '../../core/api/neighborhoods.service';
import { apiErrorMessage } from '../../core/http/api-error';
import { Account } from '../../core/models/api.models';
import { Neighborhood } from '../../core/models/neighborhood';

/**
 * v2: el contrato es SIEMPRE organización → barrio, comercial puro. Los cupos
 * ya no viven acá (van en la cuenta y en el barrio, solo CPS los toca).
 */
@Component({
  selector: 'app-contract-form',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './contract-form.html',
})
export class ContractForm {
  private readonly contracts = inject(ContractsService);
  private readonly accounts = inject(AccountsService);
  private readonly neighborhoods = inject(NeighborhoodsService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  protected readonly accountList = signal<Account[]>([]);
  protected readonly barrioList = signal<Neighborhood[]>([]);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly form = this.fb.group({
    accountId: [null as number | null, Validators.required],
    neighborhoodId: [null as number | null, Validators.required],
    price: [null as number | null, [Validators.required, Validators.min(0)]],
    startDate: ['', Validators.required],
    endDate: [''],
    description: [''],
  });

  /** COMPANY no contrata: se contrata a CPS, no al revés. */
  protected readonly selectableAccounts = computed(() =>
    this.accountList().filter((a) => a.type === 'ORGANIZATION'),
  );

  private readonly accountId = signal<number | null>(null);

  /** Solo los barrios DE la organización elegida: cruzar da 400. */
  protected readonly selectableBarrios = computed(() => {
    const accountId = this.accountId();
    return accountId ? this.barrioList().filter((b) => b.organizationId === accountId) : [];
  });

  constructor() {
    forkJoin({
      accounts: this.accounts.list(),
      barrios: this.neighborhoods.list(),
    }).subscribe({
      next: ({ accounts, barrios }) => {
        this.accountList.set(accounts);
        this.barrioList.set(barrios);
      },
      error: (err) => this.error.set(apiErrorMessage(err)),
    });

    this.form.controls.accountId.valueChanges.subscribe((id) => {
      this.accountId.set(id);
      // El barrio elegido para la cuenta anterior ya no vale.
      this.form.controls.neighborhoodId.setValue(null);
    });
  }

  protected submit(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();

    this.saving.set(true);
    this.error.set(null);

    this.contracts
      .create({
        accountId: value.accountId as number,
        neighborhoodId: value.neighborhoodId as number,
        price: Number(value.price),
        // 'YYYY-MM-DD', que es lo que el input date ya devuelve.
        startDate: value.startDate as string,
        endDate: value.endDate?.trim() ? value.endDate : undefined,
        description: value.description?.trim() ? value.description.trim() : undefined,
      })
      .subscribe({
        next: () => void this.router.navigate(['/contratos']),
        error: (err) => {
          // 409: ese barrio ya tiene un contrato ACTIVE (cerrar el anterior).
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }
}
