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
import { Plan } from './entities/plan.entity';
import { StaffAssignment } from './entities/staff-assignment.entity';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';

// Los planes viven en este módulo y no en uno propio porque son la definición
// de los cupos de la cuenta: separarlos dejaría dos módulos que solo se
// entienden leyendo el otro.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Account,
      AccountUser,
      StaffAssignment,
      Plan,
      User,
      Neighborhood,
      Locality,
    ]),
    // Onboarding de comunidad crea al OWNER institucional con clave temporal:
    // AuthModule exporta PasswordService (único lugar donde se hashea).
    AuthModule,
  ],
  controllers: [AccountsController, PlansController],
  providers: [AccountsService, PlansService],
  exports: [AccountsService, PlansService],
})
export class AccountsModule {}
