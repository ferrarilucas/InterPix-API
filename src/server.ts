import { createApp } from './http/app';
import { startScheduler } from './jobs/scheduler';
import { runMigrations } from './shared/migrations';
import { ensureWebhooksAndLog } from './domain/webhookRegistration';
import { config } from './shared/config';
import { logger } from './shared/logger';

async function main(): Promise<void> {
  const applied = await runMigrations(config.databaseUrl);

  if (applied.length > 0) {
    logger.info('migrations aplicadas', { applied });
  }

  const app = createApp();

  app.listen(config.port, () => {
    logger.info('servidor iniciado', { port: config.port });

    ensureWebhooksAndLog().catch((error) => {
      logger.error('falha ao verificar os webhooks do inter na subida', {
        message: (error as Error).message,
      });
    });
  });

  startScheduler();
}

main().catch((error) => {
  logger.error('falha ao iniciar o servidor', { message: (error as Error).message });
  process.exit(1);
});
