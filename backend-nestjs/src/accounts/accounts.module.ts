import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Locality } from '../geography/entities/locality.entity';
import { Neighborhood } from '../neighborhoods/entities/neighborhood.entity';
import { User } from '../users/entities/user.entity';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { AccountUser } from './entities/account-user.entity';
import { Account } from './entities/account.entity';
import { StaffAssignment } from './entities/staff-assignment.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Account,
      AccountUser,
      StaffAssignment,
      User,
      Neighborhood,
      Locality,
    ]),
    // Onboarding de comunidad crea al OWNER institucional con clave temporal:
    // AuthModule exporta PasswordService (único lugar donde se hashea).
    AuthModule,
  ],
  controllers: [AccountsController],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
