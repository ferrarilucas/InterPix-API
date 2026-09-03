import { Pool, PoolClient } from 'pg';
import { config } from './config';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function query<T>(
  text: string,
  params: unknown[] = [],
  client?: PoolClient,
): Promise<T[]> {
  const result = client ? await client.query(text, params) : await pool.query(text, params);
  return result.rows as T[];
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (error) {
    let rollbackError: unknown;
    try {
      await client.query('ROLLBACK');
    } catch (err) {
      rollbackError = err;
    }

    if (rollbackError !== undefined) {
      client.release(rollbackError as Error);
      if (error instanceof Error) {
        (error as Error & { cause?: unknown }).cause = rollbackError;
      }
      throw error;
    }

    client.release();
    throw error;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
