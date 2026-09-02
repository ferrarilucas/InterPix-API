import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

export async function runMigrations(connectionString: string): Promise<string[]> {
  const pool = new Pool({ connectionString });

  try {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );

    const applied = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(applied.rows.map((row) => row.name));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const executed: string[] = [];

    for (const file of files) {
      if (done.has(file)) {
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        client.release();
        executed.push(file);
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

    return executed;
  } finally {
    await pool.end();
  }
}
