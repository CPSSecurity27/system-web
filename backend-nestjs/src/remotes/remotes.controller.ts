import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AccountType, UserRole } from '../common/enums';
import { ScopeService } from '../common/scope.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireMembership } from '../auth/decorators/roles.decorator';
import {
  CreateRemoteModelDto,
  EtiquetaControl,
  ManufactureRemoteDto,
  MarkReadyDto,
  RemoteFabricado,
  ResultadoBusqueda,
  UpdateRemoteModelDto,
} from './dto/remote-factory.dto';
import {
  AddRemoteCodeDto,
  AdoptRemoteDto,
  AssignRemoteDto,
  CreateRemoteDto,
  DeliverRemotesDto,
  FindRemotesQuery,
  UpdateRemoteDto,
} from './dto/remote.dto';
import { RemoteModel } from './entities/remote-model.entity';
import { Remote } from './entities/remote.entity';
import { RemoteFactoryService } from './remote-factory.service';
import {
  PagedRemotes,
  RemoteCodeSummary,
  RemotesService,
} from './remotes.service';

/** Fabricar, tocar el catálogo y ver los códigos en claro: SOLO CPS. */
const FABRICA_CPS = {
  accountType: AccountType.COMPANY,
  roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
};

/**
 * Controles remotos (v2): custodia fábrica -> stock org -> hogar.
 *
 * DUEÑO != PORTADOR: la vivienda es dueña (`homeId`, no se cambia), el
 * portador (`assignedToUserId`) se reasigna libre — y debe ser MIEMBRO del
 * hogar (home_member).
 *
 * El PATCH del titular (reasignar portador en su casa) no lleva
 * @RequireMembership: el titular ya no tiene cuenta; el servicio valida su
 * membresía de hogar vía scope. Los CÓDIGOS RF siguen siendo solo-CPS.
 */
@ApiTags('remotes')
@ApiBearerAuth()
@Controller('remotes')
export class RemotesController {
  constructor(
    private readonly remotes: RemotesService,
    private readonly factory: RemoteFactoryService,
    private readonly scopes: ScopeService,
  ) {}

  // --- Fábrica ---------------------------------------------------------------
  // Van ANTES de :id o "models" y "manufacture" entrarían por ahí y reventarían
  // el ParseIntPipe. Mismo orden que en devices, por la misma razón.

  /** GET /api/remotes/models — el desplegable de la pantalla de fábrica. */
  @Get('models')
  findModels(): Promise<RemoteModel[]> {
    return this.factory.findModels();
  }

  /** POST /api/remotes/models — un modelo nuevo cada tanto. Solo CPS. */
  @Post('models')
  @RequireMembership(FABRICA_CPS)
  createModel(
    @Body() dto: CreateRemoteModelDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RemoteModel> {
    return this.factory.createModel(dto, user.id);
  }

  /** PATCH /api/remotes/models/:id — renombrar o discontinuar. Solo CPS. */
  @Patch('models/:id')
  @RequireMembership(FABRICA_CPS)
  updateModel(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRemoteModelDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RemoteModel> {
    return this.factory.updateModel(id, dto, user.id);
  }

  /**
   * POST /api/remotes/manufacture — fabricar un control. Solo CPS.
   *
   * Atómica: serial, modelo y códigos entran juntos o no entra nada. Devuelve
   * los códigos EN CLARO porque hay que grabarlos en el control — es la única
   * respuesta del sistema que los trae sin pedirlos aparte.
   */
  @Post('manufacture')
  @RequireMembership(FABRICA_CPS)
  manufacture(
    @Body() dto: ManufactureRemoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RemoteFabricado> {
    return this.factory.manufacture(dto, user.id);
  }

  /** GET /api/remotes/manufactured — el registro de la fábrica. Solo CPS. */
  @Get('manufactured')
  @RequireMembership(FABRICA_CPS)
  fabricados(): Promise<ResultadoBusqueda[]> {
    return this.factory.fabricados();
  }

  /**
   * POST /api/remotes/:id/ready — el visto bueno de fábrica. Solo CPS.
   *
   * Hasta que no está, el control NO entra al stock: fabricarlo no es tenerlo
   * listo, falta grabarle los códigos y etiquetarlo. Se puede desmarcar
   * (`{ listo: false }`), porque el error más común es marcar de más.
   */
  @Post(':id/ready')
  @RequireMembership(FABRICA_CPS)
  marcarListo(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MarkReadyDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ResultadoBusqueda> {
    return this.factory.marcarListo(id, dto.listo ?? true, user.id);
  }

  // --- Papelera --------------------------------------------------------------
  // `removed` va ANTES de :id o entraría por ahí y reventaría el ParseIntPipe.

  /** GET /api/remotes/removed — los que están fuera de circulación. Solo CPS. */
  @Get('removed')
  @RequireMembership(FABRICA_CPS)
  removidos(): Promise<ResultadoBusqueda[]> {
    return this.factory.removidos();
  }

  /**
   * POST /api/remotes/:id/remove — a la papelera. Solo CPS.
   *
   * Lo saca de todas las listas y lo desvincula de la vivienda. **No deja el
   * control sin efecto**: sus códigos siguen grabados en la EEPROM de cada panel
   * y la web todavía no los sincroniza, así que el llavero sigue disparando.
   */
  @Post(':id/remove')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  remover(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ResultadoBusqueda> {
    return this.factory.remover(id, user.id);
  }

  /**
   * POST /api/remotes/:id/restore — de vuelta a circulación. Solo CPS.
   *
   * Vuelve al stock de fábrica y SIN el visto bueno: pasó por la papelera, así
   * que alguien tiene que revisarlo antes de que se lo pueda entregar.
   */
  @Post(':id/restore')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN],
  })
  restaurar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ResultadoBusqueda> {
    return this.factory.restaurar(id, user.id);
  }

  /**
   * DELETE /api/remotes/:id — borrado DEFINITIVO. Solo desde la papelera.
   *
   * Se lleva los códigos, y con ellos **la reserva de esos números: vuelven a
   * quedar disponibles** para otro control. Un control con EVENTOS no se puede
   * borrar: son append-only y la base lo rechaza.
   *
   * Solo OWNER: es la única operación del módulo que destruye algo sin vuelta.
   */
  @Delete(':id')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER],
  })
  borrarDefinitivo(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ mensaje: string }> {
    return this.factory.borrarDefinitivo(id, user.id);
  }

  /**
   * GET /api/remotes/search?q= — buscar por número de serie o por código.
   *
   * Por CÓDIGO funciona gracias al HMAC de la unicidad: es determinístico, así
   * que un código conocido se encuentra con un índice sin descifrar nada. Solo
   * con el número COMPLETO — no se puede enumerar ni buscar por prefijo — y la
   * respuesta NUNCA trae códigos: quien busca ya tiene el que tipeó.
   */
  @Get('search')
  @RequireMembership(FABRICA_CPS)
  buscar(@Query('q') q: string): Promise<ResultadoBusqueda[]> {
    return this.factory.buscar(q ?? '');
  }

  /**
   * POST /api/remotes/deliver — entrega de LOTE a una organización. Solo CPS.
   *
   * Existe por lo mismo que en alarmas: pasarle 50 controles a una muni eran 50
   * llamadas, cada una con su chance de fallar por la mitad.
   */
  @Post('deliver')
  @RequireMembership(FABRICA_CPS)
  deliver(
    @Body() dto: DeliverRemotesDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ delivered: number }> {
    return this.remotes.deliver(dto, user.id);
  }

  /**
   * POST /api/remotes/adopt — sumar un control al stock propio (serial + código).
   *
   * El otro camino al stock además del lote: la bolsa que alguien ya tiene en la
   * mano. Solo sobre controles SIN DUEÑO — uno que ya es de alguien se entrega.
   */
  @Post('adopt')
  @RequireMembership(
    {
      accountType: AccountType.COMPANY,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
    {
      accountType: AccountType.ORGANIZATION,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
  )
  adopt(
    @Body() dto: AdoptRemoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Remote> {
    return this.remotes.adopt(dto, user);
  }

  /**
   * GET /api/remotes — los controles ENTREGADOS, filtrados y paginados.
   *
   * Filtros: cliente, barrio, vivienda, alarma preferida, estado y un buscador
   * (`q`) por DNI, serial, dirección o portador. Todos se intersectan con el
   * alcance: el titular ve los de su casa y nada más.
   */
  @Get()
  async findAll(
    @Query() query: FindRemotesQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PagedRemotes> {
    return this.remotes.findAll(await this.scopes.forUser(user), query);
  }

  /** GET /api/remotes/inventory — CPS: todo el stock; organización: SU stock. */
  @Get('inventory')
  @RequireMembership(
    {
      accountType: AccountType.COMPANY,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
    {
      accountType: AccountType.ORGANIZATION,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
  )
  findInventory(@CurrentUser() user: AuthenticatedUser): Promise<Remote[]> {
    return this.remotes.findInventory(user);
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Remote> {
    return this.remotes.findOne(id, await this.scopes.forUser(user));
  }

  /**
   * POST /api/remotes — CPS o el gestor del barrio. Sin homeId: alta a stock
   * (solo CPS). Falla si el barrio no tiene controles habilitados (cupo).
   */
  @Post()
  @RequireMembership(
    {
      accountType: AccountType.COMPANY,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
    {
      accountType: AccountType.ORGANIZATION,
      roles: [UserRole.OWNER, UserRole.ADMIN],
    },
  )
  async create(
    @Body() dto: CreateRemoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Remote> {
    return this.remotes.create(dto, await this.scopes.forUser(user), user.id);
  }

  /** POST /api/remotes/:id/assign — entrega física: stock -> vivienda. */
  @Post(':id/assign')
  @RequireMembership(
    {
      accountType: AccountType.COMPANY,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
    {
      accountType: AccountType.ORGANIZATION,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
  )
  async assign(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignRemoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Remote> {
    return this.remotes.assign(id, dto, user, await this.scopes.forUser(user));
  }

  /**
   * POST /api/remotes/:id/return — devolver al stock. La familia lo entregó.
   *
   * Vuelve al inventario de quien opera el barrio y sin portador, listo para
   * asignarse a otra casa. **No borra sus códigos de los paneles**: mientras no
   * exista la sincronización de la base RF, el llavero devuelto sigue disparando.
   */
  @Post(':id/return')
  @RequireMembership(
    {
      accountType: AccountType.COMPANY,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
    {
      accountType: AccountType.ORGANIZATION,
      roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
    },
  )
  async devolver(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Remote> {
    return this.remotes.devolver(id, user, await this.scopes.forUser(user));
  }

  /**
   * PATCH /api/remotes/:id
   *
   * Gestores, o el TITULAR sobre los controles de SU casa (darle el llavero al
   * hijo, reportarlo perdido). El alcance lo resuelve el servicio; el portador
   * debe ser miembro del hogar.
   */
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRemoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Remote> {
    return this.remotes.update(
      id,
      dto,
      await this.scopes.forUser(user),
      user.id,
    );
  }

  // --- Códigos RF (SENSIBLE) -------------------------------------------------

  /** GET /api/remotes/:id/codes — posición y fecha, NUNCA el código. */
  @Get(':id/codes')
  async findCodes(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RemoteCodeSummary[]> {
    return this.remotes.findCodes(id, await this.scopes.forUser(user));
  }

  /** POST /api/remotes/:id/codes — solo CPS. Se cifra antes de insertar. */
  @Post(':id/codes')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  async addCode(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddRemoteCodeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RemoteCodeSummary> {
    return this.remotes.addCode(id, dto, await this.scopes.forUser(user));
  }

  /**
   * GET /api/remotes/:id/label — los datos de la etiqueta. Solo CPS, auditado.
   *
   * Trae los códigos EN CLARO porque la etiqueta los lleva en el QR, por
   * decisión explícita. El costo asumido es que una foto de la etiqueta alcanza
   * para clonar el control —el panel no valida nada más que el número— así que
   * lo que queda es la trazabilidad: cada impresión deja quién y cuándo.
   */
  @Get(':id/label')
  @RequireMembership(FABRICA_CPS)
  etiqueta(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EtiquetaControl> {
    return this.factory.etiqueta(id, user.id);
  }

  /**
   * GET /api/remotes/:id/codes/:codeId/reveal — ÚNICO endpoint que devuelve un
   * código RF EN CLARO. Solo CPS. Cada llamada queda en el log Y en audit_log.
   */
  @Get(':id/codes/:codeId/reveal')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  revealCode(
    @Param('id', ParseIntPipe) id: number,
    @Param('codeId', ParseIntPipe) codeId: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ position: number; code: string }> {
    return this.remotes.revealCode(id, codeId, user.id);
  }

  @Delete(':id/codes/:codeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  async removeCode(
    @Param('id', ParseIntPipe) id: number,
    @Param('codeId', ParseIntPipe) codeId: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.remotes.removeCode(id, codeId, await this.scopes.forUser(user));
  }
}
