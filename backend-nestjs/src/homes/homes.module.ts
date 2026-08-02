import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Device } from '../devices/entities/device.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { HomeMember } from './entities/home-member.entity';
import { Home } from './entities/home.entity';
import { HomesController } from './homes.controller';
import { HomesService } from './homes.service';

@Module({
  // UsersModule aporta la creación del VECINO (`createResident`), que el alta
  // de vivienda corre dentro de su propia transacción. No hay ciclo: users no
  // depende de homes (solo usa la entidad HomeMember para leer).
  imports: [
    TypeOrmModule.forFeature([Home, HomeMember, Neighborhood, Device, User]),
    UsersModule,
  ],
  controllers: [HomesController],
  providers: [HomesService],
  exports: [HomesService],
})
export class HomesModule {}
