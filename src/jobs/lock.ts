import { pool } from '../shared/db';

export async function withAdvisoryLock<T>(
  key: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const client = await pool.connect();

  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key],
    );

    if (!result.rows[0].locked) {
      return null;
    }

    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
}
