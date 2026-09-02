import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from './migrations';

const connectionString = process.env.DATABASE_URL_TEST as string;
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});

afterAll(async () => {
  await pool.end();
});

describe('runMigrations', () => {
  it('cria as tabelas do schema inicial', async () => {
    await runMigrations(connectionString);

    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tables = result.rows.map((row) => row.table_name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'subscriptions',
        'cycles',
        'cycle_attempts',
        'events',
        'inter_webhook_receipts',
        'webhook_deliveries',
        'schema_migrations',
      ]),
    );
  });

  it('e idempotente: rodar de novo nao aplica nada', async () => {
    const applied = await runMigrations(connectionString);
    expect(applied).toEqual([]);
  });
});
