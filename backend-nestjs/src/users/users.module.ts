import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { AccountUser } from '../accounts/entities/account-user.entity';
import { HomeMember } from '../homes/entities/home-member.entity';
import { User } from './entities/user.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // AuthModule exporta PasswordService: el hash de la contraseña se calcula en un
  // solo lugar del sistema.
  imports: [
    TypeOrmModule.forFeature([User, AccountUser, HomeMember]),
    AuthModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
