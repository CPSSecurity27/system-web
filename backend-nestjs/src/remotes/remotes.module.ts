import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/account.entity';
import { Device } from '../devices/entities/device.entity';
import { HomeMember } from '../homes/entities/home-member.entity';
import { Home } from '../homes/entities/home.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import { RemoteCode } from './entities/remote-code.entity';
import { RemoteModel } from './entities/remote-model.entity';
import { Remote } from './entities/remote.entity';
import { DevicesModule } from '../devices/devices.module';
import { RemoteFactoryService } from './remote-factory.service';
import { RemotesController } from './remotes.controller';
import { RemotesService } from './remotes.service';
import { RfSyncController } from './rf-sync.controller';
import { RfSyncService } from './rf-sync.service';

@Module({
  imports: [
    // La sincronización de base RF es sobre un EQUIPO: reusa su validación de
    // alcance en vez de repetirla. No hay ciclo — devices no conoce a remotes.
    DevicesModule,
    TypeOrmModule.forFeature([
      Remote,
      RemoteCode,
      RemoteModel,
      Home,
      HomeMember,
      Neighborhood,
      Device,
      // El destino de una entrega o una adopción tiene que ser ORGANIZATION.
      Account,
    ]),
  ],
  controllers: [RemotesController, RfSyncController],
  providers: [RemotesService, RemoteFactoryService, RfSyncService],
  exports: [RemotesService],
})
export class RemotesModule {}
