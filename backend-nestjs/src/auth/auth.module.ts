import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountUser } from '../accounts/entities/account-user.entity';
import { Account } from '../accounts/entities/account.entity';
import { HomeMember } from '../homes/entities/home-member.entity';
import { User } from '../users/entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import { UserDevice } from './entities/user-device.entity';
import { UserToken } from './entities/user-token.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { MembershipGuard } from './guards/membership.guard';
import { MustChangePasswordGuard } from './guards/must-change-password.guard';
import { MailerService } from './mailer.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Account,
      AccountUser,
      HomeMember,
      RefreshToken,
      UserToken,
      UserDevice,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        // Access token CORTO: es stateless, no se puede revocar. La sesión larga
        // la sostiene el refresh token, que sí es revocable.
        // En segundos (number) y no "15m": el string obligaría a un cast, porque
        // @nestjs/jwt tipa expiresIn como number | StringValue.
        signOptions: {
          expiresIn: Number(config.get('JWT_ACCESS_TTL_MINUTES') ?? 15) * 60,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    MailerService,
    // Guards GLOBALES: todo endpoint exige token salvo que se marque @Public().
    // El default seguro es "cerrado"; abrir es lo que hay que hacer explícito.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Clave temporal sin cambiar: bloquea todo salvo @AllowPasswordPending().
    // Antes que MembershipGuard para que el 403 diga "cambiá tu clave", no
    // un error de permisos que no viene al caso.
    { provide: APP_GUARD, useClass: MustChangePasswordGuard },
    { provide: APP_GUARD, useClass: MembershipGuard },
  ],
  // MailerService también exportado: UsersService lo usa para el mail de
  // activación de cuenta del vecino (mismo servicio, un solo transporter).
  exports: [AuthService, PasswordService, TokenService, MailerService],
})
export class AuthModule {}
