import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Device } from '../devices/entities/device.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import { User } from '../users/entities/user.entity';
import { HomeMember } from './entities/home-member.entity';
import { Home } from './entities/home.entity';
import { HomesController } from './homes.controller';
import { HomesService } from './homes.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Home, HomeMember, Neighborhood, Device, User]),
  ],
  controllers: [HomesController],
  providers: [HomesService],
  exports: [HomesService],
})
export class HomesModule {}
