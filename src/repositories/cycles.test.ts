import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from '../shared/db';
import { createSubscription } from '../test/factories';
import {
  countCycleAttempts,
  findCycleByTxid,
  insertCycle,
  insertCycleAttempt,
  markAttemptOutcome,
  updateCycleStatus,
} from './cycles';

afterAll(async () => {
  await closePool();
});

describe('cycles repository', () => {
  it('insere ciclo com status SCHEDULED', async () => {
    const subscription = await createSubscription();
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });

    expect(cycle.status).toBe('SCHEDULED');
    expect(cycle.seq).toBe(1);
  });

  it('recusa dois ciclos com a mesma sequencia na mesma assinatura', async () => {
    const subscription = await createSubscription();
    await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });

    await expect(
      insertCycle({
        subscriptionId: subscription.id,
        seq: 1,
        dueDate: '2026-10-20',
        amount: '29.90',
      }),
    ).rejects.toThrow();
  });

  it('guarda o txid e permite buscar por ele', async () => {
    const subscription = await createSubscription();
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });

    await updateCycleStatus(cycle.id, 'SENT', { interTxid: 'txid-unico-1' });
    const found = await findCycleByTxid('txid-unico-1');

    expect(found?.id).toBe(cycle.id);
    expect(found?.status).toBe('SENT');
  });

  it('acumula tentativas do mesmo ciclo compartilhando o txid', async () => {
    const subscription = await createSubscription();
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: 'txid-unico-2' });

    await insertCycleAttempt({ cycleId: cycle.id, attemptNumber: 1, scheduledFor: '2026-09-20' });
    await markAttemptOutcome(cycle.id, 1, 'FAILED', 'saldo insuficiente');
    await insertCycleAttempt({ cycleId: cycle.id, attemptNumber: 2, scheduledFor: '2026-09-22' });

    expect(await countCycleAttempts(cycle.id)).toBe(2);
    expect((await findCycleByTxid('txid-unico-2'))?.interTxid).toBe('txid-unico-2');
  });
});
