import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Department } from './entities/department.entity';
import { Locality } from './entities/locality.entity';
import { Province } from './entities/province.entity';
import { GeographyController } from './geography.controller';
import { GeographySyncService } from './geography-sync.service';
import { GeographyService } from './geography.service';
import { GeorefClient } from './georef.client';

/**
 * La sincronización se dispara a mano: `npm run geography:sync` o
 * POST /api/geography/sync (ADMIN de la cuenta COMPANY). No hay cron.
 * Las dos vías llaman al MISMO GeographySyncService.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Province, Department, Locality])],
  controllers: [GeographyController],
  providers: [GeorefClient, GeographySyncService, GeographyService],
  exports: [GeographySyncService, GeographyService],
})
export class GeographyModule {}
