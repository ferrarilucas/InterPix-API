import { randomUUID } from 'crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from '../shared/db';
import { createSubscription } from '../test/factories';
import {
  countCycleAttempts,
  findCycleById,
  findCycleByTxid,
  insertCycle,
  insertCycleAttempt,
  markAttemptOutcome,
  updateCycleStatus,
} from './cycles';

const runId = randomUUID();

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

    const interTxid = `txid-unico-1-${runId}`;
    await updateCycleStatus(cycle.id, 'SENT', { interTxid });
    const found = await findCycleByTxid(interTxid);

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
    const interTxid = `txid-unico-2-${runId}`;
    await updateCycleStatus(cycle.id, 'SENT', { interTxid });

    await insertCycleAttempt({ cycleId: cycle.id, attemptNumber: 1, scheduledFor: '2026-09-20' });
    await markAttemptOutcome(cycle.id, 1, 'FAILED', 'saldo insuficiente');
    await insertCycleAttempt({ cycleId: cycle.id, attemptNumber: 2, scheduledFor: '2026-09-22' });

    expect(await countCycleAttempts(cycle.id)).toBe(2);
    expect((await findCycleByTxid(interTxid))?.interTxid).toBe(interTxid);
  });

  it('mantem o due_date exato ao ler o ciclo de volta', async () => {
    const subscription = await createSubscription();
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-15',
      amount: '29.90',
    });

    const found = await findCycleById(cycle.id);

    expect(cycle.dueDate).toBe('2026-09-15');
    expect(found?.dueDate).toBe('2026-09-15');
    expect(found?.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('mantem o scheduled_for exato da tentativa', async () => {
    const subscription = await createSubscription();
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-15',
      amount: '29.90',
    });

    const attempt = await insertCycleAttempt({
      cycleId: cycle.id,
      attemptNumber: 1,
      scheduledFor: '2026-09-15',
    });

    expect(attempt.scheduledFor).toBe('2026-09-15');
    expect(attempt.scheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
