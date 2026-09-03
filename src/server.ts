import { createApp } from './http/app';
import { startScheduler } from './jobs/scheduler';
import { runMigrations } from './shared/migrations';
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
  });

  startScheduler();
}

main().catch((error) => {
  logger.error('falha ao iniciar o servidor', { message: (error as Error).message });
  process.exit(1);
});
