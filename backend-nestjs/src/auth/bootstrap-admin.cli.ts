import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { AccountUser } from '../accounts/entities/account-user.entity';
import { Account } from '../accounts/entities/account.entity';
import { AccountType, EntityStatus, UserKind, UserRole } from '../common/enums';
import { User } from '../users/entities/user.entity';
import { PasswordService } from './password.service';

/**
 * `npm run auth:bootstrap -- <owner_username> <owner_password> [admin_username] [admin_password] [admin_email]`
 *
 * Resuelve el huevo-y-la-gallina del modelo v2: crea la cuenta COMPANY (CPS
 * Security), su OWNER INSTITUCIONAL (ej. cps_root — patrón "cuenta root": solo
 * soberanía, 2FA cuando exista, poco uso) y, opcionalmente, el primer ADMIN
 * humano para la operación diaria.
 *
 * El OWNER queda con created_by NULL: el primer usuario del sistema no tiene
 * creador (para eso la columna es nullable).
 *
 * Idempotente: si ya existe la cuenta o un usuario, no los duplica.
 */
async function main(): Promise<void> {
  const logger = new Logger('BootstrapAdmin');
  const [
    ownerUsername,
    ownerPassword,
    adminUsername,
    adminPassword,
    adminEmail,
  ] = process.argv.slice(2);

  if (!ownerUsername || !ownerPassword) {
    logger.error(
      'Uso: npm run auth:bootstrap -- <owner_username> <owner_password> [admin_username] [admin_password] [admin_email]',
    );
    process.exitCode = 1;
    return;
  }
  if (adminUsername && !adminPassword) {
    logger.error('Si indicás admin_username, falta admin_password');
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  try {
    const dataSource = app.get(DataSource);
    const passwords = app.get(PasswordService);

    await dataSource.transaction(async (manager) => {
      let account = await manager.findOne(Account, {
        where: { type: AccountType.COMPANY },
      });

      if (!account) {
        account = await manager.save(
          manager.create(Account, {
            name: 'CPS Security',
            type: AccountType.COMPANY,
            subtype: null,
            status: EntityStatus.ACTIVE,
          }),
        );
        logger.log(`Cuenta COMPANY creada (id ${account.id})`);
      } else {
        logger.log(`Cuenta COMPANY ya existía (id ${account.id})`);
      }

      // --- OWNER institucional (la soberanía de CPS) -----------------------
      let owner = await manager.findOne(User, {
        where: { username: ownerUsername },
      });
      if (!owner) {
        owner = await manager.save(
          manager.create(User, {
            name: 'CPS Security (institucional)',
            kind: UserKind.INSTITUTIONAL,
            username: ownerUsername,
            passwordHash: await passwords.hash(ownerPassword),
            status: EntityStatus.ACTIVE,
            createdBy: null, // el primer usuario no tiene creador
          }),
        );
        await manager.save(
          manager.create(AccountUser, {
            accountId: account.id,
            userId: owner.id,
            role: UserRole.OWNER,
          }),
        );
        logger.log(
          `OWNER institucional "${ownerUsername}" creado (id ${owner.id})`,
        );
      } else {
        logger.warn(
          `El usuario "${ownerUsername}" ya existía (id ${owner.id})`,
        );
      }

      // --- Primer ADMIN humano (opcional, para la operación diaria) --------
      if (adminUsername) {
        const existing = await manager.findOne(User, {
          where: { username: adminUsername },
        });
        if (existing) {
          logger.warn(
            `El usuario "${adminUsername}" ya existía (id ${existing.id})`,
          );
          return;
        }

        const admin = await manager.save(
          manager.create(User, {
            name: 'Administrador CPS',
            kind: UserKind.PERSON,
            username: adminUsername,
            email: adminEmail ?? null,
            passwordHash: await passwords.hash(adminPassword),
            status: EntityStatus.ACTIVE,
            createdBy: owner.id,
          }),
        );
        await manager.save(
          manager.create(AccountUser, {
            accountId: account.id,
            userId: admin.id,
            role: UserRole.ADMIN,
            createdBy: owner.id,
          }),
        );
        logger.log(`ADMIN "${adminUsername}" creado (id ${admin.id})`);
        if (!adminEmail) {
          logger.warn(
            'ADMIN sin email: no va a poder verificar correo ni recuperar clave.',
          );
        }
      }
    });
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  new Logger('BootstrapAdmin').error(
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
