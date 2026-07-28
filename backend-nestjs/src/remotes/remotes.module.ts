import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Device } from '../devices/entities/device.entity';
import { HomeMember } from '../homes/entities/home-member.entity';
import { Home } from '../homes/entities/home.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import { RemoteCode } from './entities/remote-code.entity';
import { Remote } from './entities/remote.entity';
import { RemotesController } from './remotes.controller';
import { RemotesService } from './remotes.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Remote,
      RemoteCode,
      Home,
      HomeMember,
      Neighborhood,
      Device,
    ]),
  ],
  controllers: [RemotesController],
  providers: [RemotesService],
  exports: [RemotesService],
})
export class RemotesModule {}
