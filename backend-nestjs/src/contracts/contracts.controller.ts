import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AccountType, UserRole } from '../common/enums';
import { ScopeService } from '../common/scope.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireMembership } from '../auth/decorators/roles.decorator';
import { ContractsService } from './contracts.service';
import { CreateContractDto, UpdateContractDto } from './dto/contract.dto';
import { ServiceContract } from './entities/service-contract.entity';

/**
 * Contratos de servicio.
 *
 * Los firma SOLO CPS: es la empresa la que contrata con el municipio o con el
 * vecino, no al revÃ©s. El resto los puede LEER (los suyos), porque un titular
 * tiene derecho a ver quÃ© contratÃ³.
 */
@ApiTags('contracts')
@ApiBearerAuth()
@Controller('contracts')
export class ContractsController {
  constructor(
    private readonly contracts: ContractsService,
    private readonly scopes: ScopeService,
  ) {}

  /** GET /api/contracts -> los contratos de los barrios/viviendas que alcanzÃ¡s */
  @Get()
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ServiceContract[]> {
    return this.contracts.findAll(await this.scopes.forUser(user));
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ServiceContract> {
    return this.contracts.findOne(id, await this.scopes.forUser(user));
  }

  /**
   * POST /api/contracts
   *
   * v2: SIEMPRE organización -> barrio (los hogares no contratan). COMPANY no
   * puede contratar (CPS presta el servicio). Un solo contrato ACTIVE por
   * barrio: el segundo da 409.
   */
  @Post()
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  create(
    @Body() dto: CreateContractDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ServiceContract> {
    return this.contracts.create(dto, user.id);
  }

  /**
   * PATCH /api/contracts/:id
   *
   * Solo estado, descripciÃ³n y fecha de fin. Precio, tope, cuenta y destino estÃ¡n
   * CONGELADOS: para cambiarlos se cancela este contrato y se firma otro, asÃ­
   * queda el historial (un barrio acumula contratos vencidos).
   */
  @Patch(':id')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateContractDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ServiceContract> {
    return this.contracts.update(id, dto, user.id);
  }
}
