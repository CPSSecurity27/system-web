import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AccountType, UserRole } from '../common/enums';
import { RequireMembership } from '../auth/decorators/roles.decorator';
import { SearchLocalitiesDto } from './dto/search-localities.dto';
import { Department } from './entities/department.entity';
import { Locality } from './entities/locality.entity';
import { Province } from './entities/province.entity';
import { GeographySyncService, SyncReport } from './geography-sync.service';
import { GeographyService } from './geography.service';

/**
 * GeografÃ­a: lectura para cualquier usuario logueado (el JwtAuthGuard global ya
 * lo exige), y sincronizaciÃ³n solo para el ADMIN de la cuenta COMPANY.
 *
 * No hay POST/PATCH/DELETE de provincias, departamentos ni localidades: no se
 * administran a mano, entran solo por el sync.
 */
@ApiTags('geography')
@ApiBearerAuth()
@Controller('geography')
export class GeographyController {
  constructor(
    private readonly geography: GeographyService,
    private readonly sync: GeographySyncService,
  ) {}

  @Get('provinces')
  findProvinces(): Promise<Province[]> {
    return this.geography.findProvinces();
  }

  /** Combo en cascada: departamentos de una provincia. */
  @Get('provinces/:id/departments')
  findDepartments(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Department[]> {
    return this.geography.findDepartmentsByProvince(id);
  }

  /** Combo en cascada: localidades de un departamento. */
  @Get('departments/:id/localities')
  findLocalities(@Param('id', ParseIntPipe) id: number): Promise<Locality[]> {
    return this.geography.findLocalitiesByDepartment(id);
  }

  /** Autocomplete por nombre, sin tener que bajar el Ã¡rbol entero. */
  @Get('localities/search')
  searchLocalities(@Query() dto: SearchLocalitiesDto): Promise<Locality[]> {
    return this.geography.searchLocalities(dto.search, dto.limit);
  }

  @Get('localities/:id')
  getLocality(@Param('id', ParseIntPipe) id: number): Promise<Locality> {
    return this.geography.getLocality(id);
  }

  /**
   * Dispara la sincronizaciÃ³n contra georef. Es la MISMA lÃ³gica que
   * `npm run geography:sync`: el servicio se escribiÃ³ una sola vez.
   *
   * Solo el ADMIN de la cuenta COMPANY: reescribe la geografÃ­a de todo el
   * sistema, no es algo que pueda tocar el admin de un barrio.
   */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.ADMIN],
  })
  runSync(): Promise<SyncReport> {
    return this.sync.run();
  }
}
