import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Home } from '../homes/entities/home.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { DeviceMaintenance } from './entities/device-maintenance.entity';
import { DeviceState } from './entities/device-state.entity';
import { Device } from './entities/device.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Device,
      DeviceState,
      DeviceMaintenance,
      Neighborhood,
      Home,
    ]),
  ],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
