import { afterAll, describe, expect, it, vi } from 'vitest';
import { PoolClient } from 'pg';
import { closePool, pool, withTransaction } from './db';

afterAll(async () => {
  await closePool();
});

describe('withTransaction', () => {
  it('propaga o erro original quando o callback falha e o rollback funciona', async () => {
    const original = new Error('falha no callback');

    await expect(
      withTransaction(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it('propaga o erro original e descarta o client quando o rollback tambem falha', async () => {
    const original = new Error('falha no callback');
    const rollbackError = new Error('conexao perdida');
    const executedQueries: string[] = [];

    const fakeClient = {
      query: vi.fn(async (text: string) => {
        executedQueries.push(text);
        if (text === 'ROLLBACK') {
          throw rollbackError;
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    const connectSpy = vi
      .spyOn(pool, 'connect')
      .mockImplementationOnce(async () => fakeClient as unknown as PoolClient);

    await expect(
      withTransaction(async () => {
        throw original;
      }),
    ).rejects.toBe(original);

    expect((original as Error & { cause?: unknown }).cause).toBe(rollbackError);
    expect(fakeClient.release).toHaveBeenCalledWith(rollbackError);
    expect(fakeClient.release).toHaveBeenCalledTimes(1);
    expect(executedQueries).toEqual(['BEGIN', 'ROLLBACK']);

    connectSpy.mockRestore();
  });
});
