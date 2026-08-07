import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AccountsModule } from './accounts/accounts.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { ContractsModule } from './contracts/contracts.module';
import { DatabaseModule } from './database/database.module';
import { DevicesModule } from './devices/devices.module';
import { EventsModule } from './events/events.module';
import { FirmwareModule } from './firmware/firmware.module';
import { GeographyModule } from './geography/geography.module';
import { HomesModule } from './homes/homes.module';
import { RemotesModule } from './remotes/remotes.module';
import { NeighborhoodsModule } from './neighborhoods/neighborhoods.module';
import { UsersModule } from './users/users.module';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    DatabaseModule,
    CommonModule,
    AuthModule,
    UsersModule,
    AccountsModule,
    GeographyModule,
    NeighborhoodsModule,
    HomesModule,
    ContractsModule,
    DevicesModule,
    RemotesModule,
    EventsModule,
    FirmwareModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
