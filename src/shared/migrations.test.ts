import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from './migrations';

const TEST_SCHEMA = 'migrations_test';
const baseConnectionString = process.env.DATABASE_URL_TEST as string;

function isolatedConnectionString(): string {
  const url = new URL(baseConnectionString);
  url.searchParams.set('options', `-c search_path=${TEST_SCHEMA}`);
  return url.toString();
}

const connectionString = isolatedConnectionString();
let pool: Pool;
let sentinelId: string;

beforeAll(async () => {
  pool = new Pool({ connectionString: baseConnectionString });

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO public.subscriptions
       (external_user_id, plan_code, amount, debtor_tax_id, debtor_name, next_due_date)
     VALUES ('sentinela_migrations', 'mensal', '1.00', '12345678901', 'Sentinela', '2026-12-01')
     RETURNING id::text AS id`,
  );
  sentinelId = inserted.rows[0].id;

  await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await pool.query('DELETE FROM public.subscriptions WHERE id = $1', [sentinelId]);
  await pool.end();
});

describe('runMigrations', () => {
  it('cria as tabelas do schema inicial', async () => {
    await runMigrations(connectionString);

    const result = await pool.query<{ table_name: string }>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
      [TEST_SCHEMA],
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

  it('nao destroi os dados que o restante da suite tem no schema public', async () => {
    await runMigrations(connectionString);

    const result = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.subscriptions WHERE id = $1',
      [sentinelId],
    );

    expect(result.rows[0].count).toBe('1');
  });
});
