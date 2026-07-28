import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AccountType, ContractStatus } from '../common/enums';
import { AuditService } from '../common/audit.service';
import { AccessScope } from '../common/scope.service';
import { Account } from '../accounts/entities/account.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import { CreateContractDto, UpdateContractDto } from './dto/contract.dto';
import { ServiceContract } from './entities/service-contract.entity';

/** Violación del índice único parcial (un solo contrato ACTIVE por barrio). */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Contratos (v2): SIEMPRE organización -> barrio. Ya no existen contratos por
 * vivienda (nadie paga a nivel hogar). El contrato es comercial PURO: precio y
 * fechas congelados al firmar. Los cupos viven en la cuenta y el barrio.
 */
@Injectable()
export class ContractsService {
  constructor(
    @InjectRepository(ServiceContract)
    private readonly contracts: Repository<ServiceContract>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @InjectRepository(Neighborhood)
    private readonly neighborhoods: Repository<Neighborhood>,
    private readonly audit: AuditService,
  ) {}

  async create(
    dto: CreateContractDto,
    createdBy: number,
  ): Promise<ServiceContract> {
    const account = await this.getAccount(dto.accountId);

    if (account.type !== AccountType.ORGANIZATION) {
      // La base impone lo mismo (chk_contract_org_only + FK compuesta); esto
      // devuelve un 400 legible en vez de un 500 de Postgres.
      throw new BadRequestException(
        'Solo una cuenta ORGANIZATION puede contratar: CPS presta el servicio',
      );
    }

    await this.assertNeighborhoodExists(dto.neighborhoodId);
    this.assertDates(dto.startDate, dto.endDate);

    try {
      const contract = await this.contracts.save(
        this.contracts.create({
          price: dto.price,
          description: dto.description ?? null,
          startDate: dto.startDate,
          endDate: dto.endDate ?? null,
          status: ContractStatus.ACTIVE,
          accountId: account.id,
          // Fijada en ORGANIZATION por el CHECK; la FK compuesta la verifica.
          accountType: AccountType.ORGANIZATION,
          neighborhoodId: dto.neighborhoodId,
          createdBy,
        }),
      );

      await this.audit.record({
        actorUserId: createdBy,
        action: 'contract.sign',
        entityType: 'service_contract',
        entityId: contract.id,
        accountId: account.id,
        neighborhoodId: dto.neighborhoodId,
        newValue: {
          price: dto.price,
          startDate: dto.startDate,
          endDate: dto.endDate ?? null,
        },
      });

      return contract;
    } catch (error) {
      // Un solo contrato ACTIVE por barrio: se deja fallar a la base (chequear
      // antes con SELECT sería una condición de carrera) y se traduce el error.
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Ese barrio ya tiene un contrato ACTIVE. Cerrá el anterior primero.',
        );
      }
      throw error;
    }
  }

  findAll(scope: AccessScope): Promise<ServiceContract[]> {
    if (scope.global) {
      return this.contracts.find({ order: { id: 'DESC' } });
    }

    if (scope.neighborhoodIds.length === 0) return Promise.resolve([]);

    return this.contracts.find({
      where: { neighborhoodId: In(scope.neighborhoodIds) },
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number, scope: AccessScope): Promise<ServiceContract> {
    const contract = await this.contracts.findOne({ where: { id } });
    if (!contract) throw new NotFoundException(`No existe el contrato ${id}`);

    if (
      !scope.global &&
      !scope.neighborhoodIds.includes(contract.neighborhoodId)
    ) {
      throw new NotFoundException(`No existe el contrato ${id}`);
    }

    return contract;
  }

  /**
   * NO se puede cambiar el destino, la cuenta ni el precio de un contrato
   * firmado: están CONGELADOS, como una factura. Para cambiar eso se cancela y
   * se firma otro — así queda el historial. Solo estado, descripción y fin.
   */
  async update(
    id: number,
    dto: UpdateContractDto,
    updatedBy: number,
  ): Promise<ServiceContract> {
    const contract = await this.findOne(id, {
      global: true,
      neighborhoodIds: [],
      homeIds: [],
    });

    if (dto.endDate) this.assertDates(contract.startDate, dto.endDate);

    try {
      await this.contracts.update(id, {
        status: dto.status ?? contract.status,
        description: dto.description ?? contract.description,
        endDate: dto.endDate ?? contract.endDate,
        updatedBy,
      });
    } catch (error) {
      // Reactivar un contrato viejo cuando ya hay otro ACTIVE sobre el mismo
      // barrio: lo frena el mismo índice único parcial.
      if (isUniqueViolation(error)) {
        throw new ConflictException('Ese barrio ya tiene otro contrato ACTIVE');
      }
      throw error;
    }

    if (dto.status && dto.status !== contract.status) {
      await this.audit.record({
        actorUserId: updatedBy,
        action: 'contract.status_change',
        entityType: 'service_contract',
        entityId: id,
        accountId: contract.accountId,
        neighborhoodId: contract.neighborhoodId,
        oldValue: { status: contract.status },
        newValue: { status: dto.status },
      });
    }

    return this.contracts.findOneOrFail({ where: { id } });
  }

  private assertDates(startDate: string, endDate?: string | null): void {
    if (endDate && endDate < startDate) {
      throw new BadRequestException(
        'La fecha de fin no puede ser anterior a la de inicio',
      );
    }
  }

  private async getAccount(id: number): Promise<Account> {
    const account = await this.accounts.findOne({ where: { id } });
    if (!account) throw new NotFoundException(`No existe la cuenta ${id}`);
    return account;
  }

  private async assertNeighborhoodExists(id: number): Promise<void> {
    const found = await this.neighborhoods.findOne({ where: { id } });
    if (!found) throw new NotFoundException(`No existe el barrio ${id}`);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
