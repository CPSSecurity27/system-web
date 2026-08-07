import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Home } from '../homes/entities/home.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import { DeviceCommandsService } from './device-commands.service';
import { DeviceConfigService } from './device-config.service';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { ProvisioningService } from './provisioning.service';
import { BoardModel } from './entities/board-model.entity';
import { DeviceMaintenance } from './entities/device-maintenance.entity';
import { DeviceState } from './entities/device-state.entity';
import { Device } from './entities/device.entity';
import { Account } from '../accounts/entities/account.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Device,
      DeviceState,
      DeviceMaintenance,
      BoardModel,
      Neighborhood,
      Home,
      // La entrega de lote valida que la organización destino exista.
      Account,
    ]),
  ],
  controllers: [DevicesController],
  providers: [
    DevicesService,
    DeviceConfigService,
    DeviceCommandsService,
    ProvisioningService,
  ],
  // `DeviceCommandsService` lo usa el gestor de actualizaciones para mandar el
  // OTA a varios equipos. Sale exportado y no duplicado a propósito: es la
  // puerta única a `gtd.enqueue_command`, con su validación de alcance y su
  // audit_log adentro.
  exports: [DevicesService, DeviceCommandsService],
})
export class DevicesModule {}
