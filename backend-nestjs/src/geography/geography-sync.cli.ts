import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import {
  GeographySyncService,
  LevelReport,
  SyncReport,
} from './geography-sync.service';

/**
 * `npm run geography:sync`
 *
 * Levanta el contexto de Nest sin servidor HTTP, corre la sincronización y sale.
 * Es idempotente: se puede correr las veces que haga falta.
 */
async function main(): Promise<void> {
  const logger = new Logger('GeographySync');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const report: SyncReport = await app.get(GeographySyncService).run();

    logger.log('Sincronización terminada:');
    for (const [nivel, r] of Object.entries<LevelReport>({ ...report })) {
      const huerfanas = r.huerfanas.length
        ? `, ${r.huerfanas.length} huérfana(s) conservada(s)`
        : '';
      logger.log(`  ${nivel}: ${r.guardadas} guardadas${huerfanas}`);
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  new Logger('GeographySync').error(
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
