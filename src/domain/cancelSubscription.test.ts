import { randomUUID } from 'crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../shared/db';
import * as inter from '../providers/inter/pixAutomatico';
import { createSubscription as createFixture } from '../test/factories';
import { insertCycle, updateCycleStatus } from '../repositories/cycles';
import { updateSubscriptionStatus } from '../repositories/subscriptions';
import { cancelSubscription } from './subscriptionService';

const runId = randomUUID();

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe('cancelSubscription', () => {
  it('cancela a assinatura e o ciclo agendado quando ainda ha vespera', async () => {
    vi.spyOn(inter, 'cancelRecurrence').mockResolvedValue(undefined);

    const subscription = await createFixture({ nextDueDate: '2026-09-20' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: `rec-c1-${runId}` });
    await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });

    const result = await cancelSubscription(subscription.id, '2026-09-18');

    expect(result.subscription.status).toBe('CANCELED');
    expect(result.pendingCycle).toBeNull();
  });

  it('cancela a assinatura mas devolve o ciclo que seguira seu curso apos a vespera', async () => {
    vi.spyOn(inter, 'cancelRecurrence').mockResolvedValue(undefined);

    const subscription = await createFixture({ nextDueDate: '2026-09-20' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: `rec-c2-${runId}` });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: `txid-c2-${runId}` });

    const result = await cancelSubscription(subscription.id, '2026-09-20');

    expect(result.subscription.status).toBe('CANCELED');
    expect(result.pendingCycle?.id).toBe(cycle.id);
    expect(result.pendingCycle?.status).toBe('SENT');
  });

  it('cancela o ciclo quando hoje e exatamente a vespera do vencimento', async () => {
    vi.spyOn(inter, 'cancelRecurrence').mockResolvedValue(undefined);

    const subscription = await createFixture({ nextDueDate: '2026-09-20' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: `rec-c4-${runId}` });
    await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });

    const result = await cancelSubscription(subscription.id, '2026-09-19');

    expect(result.subscription.status).toBe('CANCELED');
    expect(result.pendingCycle).toBeNull();
  });

  it('devolve o ciclo FAILED como pendente mesmo com vencimento futuro', async () => {
    vi.spyOn(inter, 'cancelRecurrence').mockResolvedValue(undefined);

    const subscription = await createFixture({ nextDueDate: '2026-09-20' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: `rec-c5-${runId}` });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: `txid-c5-${runId}` });
    await updateCycleStatus(cycle.id, 'FAILED');

    const result = await cancelSubscription(subscription.id, '2026-09-10');

    expect(result.subscription.status).toBe('CANCELED');
    expect(result.pendingCycle?.id).toBe(cycle.id);
    expect(result.pendingCycle?.status).toBe('FAILED');
  });

  it('devolve o ciclo RETRYING como pendente mesmo com vencimento futuro', async () => {
    vi.spyOn(inter, 'cancelRecurrence').mockResolvedValue(undefined);

    const subscription = await createFixture({ nextDueDate: '2026-09-20' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: `rec-c6-${runId}` });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: `txid-c6-${runId}` });
    await updateCycleStatus(cycle.id, 'FAILED');
    await updateCycleStatus(cycle.id, 'RETRYING');

    const result = await cancelSubscription(subscription.id, '2026-09-10');

    expect(result.subscription.status).toBe('CANCELED');
    expect(result.pendingCycle?.id).toBe(cycle.id);
    expect(result.pendingCycle?.status).toBe('RETRYING');
  });

  it('recusa cancelar assinatura ja cancelada', async () => {
    vi.spyOn(inter, 'cancelRecurrence').mockResolvedValue(undefined);

    const subscription = await createFixture();
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: `rec-c3-${runId}` });
    await cancelSubscription(subscription.id, '2026-09-01');

    await expect(cancelSubscription(subscription.id, '2026-09-01')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });
});
