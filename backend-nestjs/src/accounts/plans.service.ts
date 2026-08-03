import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/auth.service';
import { AuditService } from '../common/audit.service';
import { OrgSubtype } from '../common/enums';
import { CreatePlanDto, FindPlansQuery, UpdatePlanDto } from './dto/plan.dto';
import { Account } from './entities/account.entity';
import { Plan } from './entities/plan.entity';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * El catálogo comercial. SOLO CPS (controller): es la definición de la tarifa.
 *
 * Lo que NO hace este servicio, y es a propósito: propagar cambios a las
 * cuentas. Un plan es una plantilla que se copia al vender (ver Plan y
 * AccountsService#resolveQuotas). Editar "Municipal Base" no le toca un cupo a
 * nadie que ya lo haya comprado — eso solo pasa por PATCH /accounts/:id/quotas,
 * cuenta por cuenta y con su fila en audit_log, que es lo que la regla 4 del
 * dominio exige.
 */
@Injectable()
export class PlansService {
  constructor(
    @InjectRepository(Plan) private readonly plans: Repository<Plan>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly audit: AuditService,
  ) {}

  findAll(query: FindPlansQuery): Promise<Plan[]> {
    return this.plans.find({
      where: {
        ...(query.active !== undefined ? { active: query.active } : {}),
        ...(query.appliesTo ? { appliesTo: query.appliesTo } : {}),
      },
      order: { appliesTo: 'ASC', name: 'ASC' },
    });
  }

  async findOne(id: number): Promise<Plan> {
    const plan = await this.plans.findOne({ where: { id } });
    if (!plan) throw new NotFoundException(`No existe el plan ${id}`);
    return plan;
  }

  /** Cuántas cuentas se vendieron con cada plan (la pregunta de la pantalla de planes). */
  async countAccounts(id: number): Promise<number> {
    return this.accounts.count({ where: { planId: id } });
  }

  async create(dto: CreatePlanDto, actor: AuthenticatedUser): Promise<Plan> {
    this.assertCommunityHasOneNeighborhood(dto.appliesTo, dto.maxNeighborhoods);

    try {
      const plan = await this.plans.save(
        this.plans.create({
          ...dto,
          description: dto.description ?? null,
          priceReference: dto.priceReference ?? null,
          active: true,
          createdBy: actor.id,
        }),
      );

      await this.audit.record({
        actorUserId: actor.id,
        action: 'plan.create',
        entityType: 'plan',
        entityId: plan.id,
        newValue: { code: plan.code, name: plan.name, ...quotasOf(plan) },
      });

      return plan;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `Ya existe un plan con el código "${dto.code}"`,
        );
      }
      throw error;
    }
  }

  async update(
    id: number,
    dto: UpdatePlanDto,
    actor: AuthenticatedUser,
  ): Promise<Plan> {
    const plan = await this.findOne(id);

    this.assertCommunityHasOneNeighborhood(
      plan.appliesTo,
      dto.maxNeighborhoods ?? plan.maxNeighborhoods,
    );

    const oldValue = {
      name: plan.name,
      active: plan.active,
      ...quotasOf(plan),
    };

    await this.plans.update(id, {
      name: dto.name ?? plan.name,
      description: dto.description ?? plan.description,
      priceReference: dto.priceReference ?? plan.priceReference,
      active: dto.active ?? plan.active,
      maxNeighborhoods: dto.maxNeighborhoods ?? plan.maxNeighborhoods,
      maxAdminUsers: dto.maxAdminUsers ?? plan.maxAdminUsers,
      maxTechnicianUsers: dto.maxTechnicianUsers ?? plan.maxTechnicianUsers,
      maxMonitorUsers: dto.maxMonitorUsers ?? plan.maxMonitorUsers,
      maxFamilyMembers: dto.maxFamilyMembers ?? plan.maxFamilyMembers,
      communityScopeEnabled:
        dto.communityScopeEnabled ?? plan.communityScopeEnabled,
      updatedBy: actor.id,
    });

    const updated = await this.findOne(id);

    await this.audit.record({
      actorUserId: actor.id,
      action: 'plan.update',
      entityType: 'plan',
      entityId: id,
      oldValue,
      newValue: {
        name: updated.name,
        active: updated.active,
        ...quotasOf(updated),
      },
    });

    return updated;
  }

  /**
   * La misma invariante que en las cuentas: una organización comunitaria
   * gestiona un solo barrio. Vale también acá para que un plan imposible se
   * rechace al definirlo y no recién al intentar venderlo, cuando el que
   * completa el alta no tiene forma de entender qué pasó.
   */
  private assertCommunityHasOneNeighborhood(
    appliesTo: OrgSubtype,
    maxNeighborhoods: number,
  ): void {
    if (appliesTo !== OrgSubtype.COMMUNITY) return;
    if (maxNeighborhoods === 1) return;

    throw new BadRequestException(
      'Un plan para organizaciones comunitarias tiene cupo de 1 barrio: ' +
        'para más de uno, el plan tiene que ser MUNICIPAL.',
    );
  }
}

function quotasOf(plan: Plan) {
  return {
    maxNeighborhoods: plan.maxNeighborhoods,
    maxAdminUsers: plan.maxAdminUsers,
    maxTechnicianUsers: plan.maxTechnicianUsers,
    maxMonitorUsers: plan.maxMonitorUsers,
    maxFamilyMembers: plan.maxFamilyMembers,
    communityScopeEnabled: plan.communityScopeEnabled,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
