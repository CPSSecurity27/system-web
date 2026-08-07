import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule } from '../common/common.module';
import { DevicesModule } from '../devices/devices.module';
import { FirmwareChannel } from './entities/firmware-channel.entity';
import { FirmwareRelease } from './entities/firmware-release.entity';
import { FirmwareController } from './firmware.controller';
import { FirmwareFleetService } from './firmware-fleet.service';
import { FirmwareService } from './firmware.service';

/**
 * El catálogo de firmwares y el gestor de actualizaciones.
 *
 * Importa `DevicesModule` por `DeviceCommandsService`: mandar el OTA desde acá
 * pasa por la MISMA puerta que desde la ficha del equipo. Duplicar el encolado
 * habría significado duplicar también la validación de alcance y el audit_log,
 * que es exactamente como se abre un agujero.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([FirmwareRelease, FirmwareChannel]),
    CommonModule,
    DevicesModule,
  ],
  controllers: [FirmwareController],
  providers: [FirmwareService, FirmwareFleetService],
  exports: [FirmwareService],
})
export class FirmwareModule {}
