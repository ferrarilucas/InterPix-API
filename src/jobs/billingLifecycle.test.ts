import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../shared/db';
import * as inter from '../providers/inter/pixAutomatico';
import {
  createSubscription as createFixture,
  listDeliveredEventTypes,
} from '../test/factories';
import {
  countCycleAttempts,
  findCycleById,
  insertCycle,
  insertCycleAttempt,
  listCyclesByStatus,
  listCyclesByStatusInRange,
  listCyclesBySubscription,
  updateCycleStatus,
} from '../repositories/cycles';
import { findSubscriptionById, updateSubscriptionStatus } from '../repositories/subscriptions';
import { applyChargeStatus } from '../domain/chargeOutcome';
import { addDays, MAX_LEAD_DAYS } from '../domain/schedule';
import { config } from '../shared/config';
import { Cycle, CycleStatus } from '../domain/types';
import { expireOverdue, generateCycles, reconcile, retryFailed, sendCharges } from './billingJobs';

beforeEach(() => {
  vi.spyOn(inter, 'getRecurrence').mockResolvedValue({
    recId: 'inert',
    status: 'UNKNOWN',
    rawStatus: 'INERTE',
  });
  vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
    txid: 'inert',
    status: 'UNKNOWN',
    rawStatus: 'INERTE',
  });
  vi.spyOn(inter, 'createCharge').mockResolvedValue({
    txid: 'inert',
    status: 'CREATED',
    rawStatus: 'CRIADA',
  });
  vi.spyOn(inter, 'cancelRecurrence').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe('ciclo de vida completo atravessando varios jobs', () => {
  it('gera, envia, falha, retenta e liquida mantendo os estados coerentes', async () => {
    const subscription = await createFixture({ nextDueDate: '2027-03-10' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });

    await generateCycles('2027-03-01');
    const [generated] = await listCyclesBySubscription(subscription.id);
    expect(generated.status).toBe('SCHEDULED');
    expect(generated.dueDate).toBe('2027-03-10');

    await sendCharges('2027-03-07');
    const afterSend = await findCycleById(generated.id);
    expect(afterSend?.status).toBe('SENT');
    expect(afterSend?.interTxid).toBeTruthy();
    expect(await countCycleAttempts(generated.id)).toBe(1);

    vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
      txid: afterSend!.interTxid!,
      status: 'FAILED',
      rawStatus: 'REJEITADA',
      failureReason: 'SALDO_INSUFICIENTE',
    });
    await reconcile('2027-03-10');
    expect((await findCycleById(generated.id))?.status).toBe('FAILED');

    await retryFailed('2027-03-11');
    expect((await findCycleById(generated.id))?.status).toBe('RETRYING');
    expect(await countCycleAttempts(generated.id)).toBe(2);
    expect((await findSubscriptionById(subscription.id))?.status).toBe('PAST_DUE');

    vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
      txid: afterSend!.interTxid!,
      status: 'PAID',
      rawStatus: 'CONCLUIDA',
      endToEndId: 'E-lifecycle',
      paidAt: '2027-03-12T10:00:00Z',
    });
    await reconcile('2027-03-12');

    const paid = await findCycleById(generated.id);
    expect(paid?.status).toBe('PAID');
    expect(paid?.endToEndId).toBe('E-lifecycle');
    expect((await findSubscriptionById(subscription.id))?.status).toBe('ACTIVE');

    const delivered = await listDeliveredEventTypes(subscription.id);
    expect(delivered).toContain('cycle.failed');
    expect(delivered).toContain('subscription.past_due');
    expect(delivered).toContain('cycle.paid');
  });
});

describe('nenhum status nao-terminal fica invisivel para os jobs', () => {
  const today = '2027-08-10';
  const dueDate = '2027-08-12';
  const nonTerminal: CycleStatus[] = ['SCHEDULED', 'SENT', 'FAILED', 'RETRYING'];

  async function jobQueries(): Promise<Cycle[][]> {
    return Promise.all([
      listCyclesByStatus(['SCHEDULED']),
      listCyclesByStatus(['FAILED']),
      listCyclesByStatus(['FAILED', 'RETRYING']),
      listCyclesByStatusInRange(
        ['SENT', 'RETRYING'],
        addDays(today, -(config.dunningWindowDays + 3)),
        addDays(today, MAX_LEAD_DAYS),
      ),
    ]);
  }

  for (const status of nonTerminal) {
    it(`algum job enxerga um ciclo em ${status}`, async () => {
      const subscription = await createFixture({ nextDueDate: dueDate });
      await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
      const cycle = await insertCycle({
        subscriptionId: subscription.id,
        seq: 1,
        dueDate,
        amount: '29.90',
      });

      if (status !== 'SCHEDULED') {
        await updateCycleStatus(cycle.id, 'SENT', { interTxid: randomUUID() });
      }
      if (status === 'FAILED' || status === 'RETRYING') {
        await updateCycleStatus(cycle.id, 'FAILED');
      }
      if (status === 'RETRYING') {
        await updateCycleStatus(cycle.id, 'RETRYING');
      }

      const results = await jobQueries();
      const seen = results.some((rows) => rows.some((row) => row.id === cycle.id));
      expect(seen).toBe(true);
    });
  }
});

describe('corrida entre webhook e reconciliacao', () => {
  it('entrega cycle.paid uma unica vez', async () => {
    const txid = randomUUID();
    const subscription = await createFixture({ nextDueDate: '2027-05-10' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2027-05-10',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });

    const staleSnapshot = await findCycleById(cycle.id);

    vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
      txid,
      status: 'PAID',
      rawStatus: 'CONCLUIDA',
      endToEndId: 'E-race',
      paidAt: '2027-05-10T10:00:00Z',
    });

    await reconcile('2027-05-10');
    await applyChargeStatus(staleSnapshot!, {
      txid,
      status: 'PAID',
      rawStatus: 'CONCLUIDA',
      endToEndId: 'E-race',
      paidAt: '2027-05-10T10:00:00Z',
    });

    expect((await findCycleById(cycle.id))?.status).toBe('PAID');
    const paidDeliveries = (await listDeliveredEventTypes(subscription.id)).filter(
      (type) => type === 'cycle.paid',
    );
    expect(paidDeliveries).toHaveLength(1);
  });
});

describe('instrucao de pagamento nunca sai para assinatura fora de ACTIVE', () => {
  it('nao envia a primeira cobranca de assinatura cancelada', async () => {
    const subscription = await createFixture({ nextDueDate: '2027-06-10' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2027-06-10',
      amount: '29.90',
    });
    await updateSubscriptionStatus(subscription.id, 'CANCELED');

    await sendCharges('2027-06-07');

    const untouched = await findCycleById(cycle.id);
    expect(untouched?.status).toBe('SCHEDULED');
    expect(untouched?.interTxid).toBeNull();
  });

  it('nao retenta cobranca de assinatura cancelada na vespera', async () => {
    const subscription = await createFixture({ nextDueDate: '2027-06-20' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2027-06-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: randomUUID() });
    await updateCycleStatus(cycle.id, 'FAILED');
    await updateSubscriptionStatus(subscription.id, 'CANCELED');

    await retryFailed('2027-06-21');

    expect((await findCycleById(cycle.id))?.status).toBe('FAILED');
    expect(await countCycleAttempts(cycle.id)).toBe(0);
  });
});

describe('expireOverdue respeita o ultimo dia da janela', () => {
  it('nao abandona no ultimo dia da janela de sete dias', async () => {
    const subscription = await createFixture({ nextDueDate: '2027-07-01' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2027-07-01',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: randomUUID() });
    await updateCycleStatus(cycle.id, 'FAILED');
    await updateCycleStatus(cycle.id, 'RETRYING');
    await insertCycleAttempt({ cycleId: cycle.id, attemptNumber: 1, scheduledFor: '2027-07-08' });

    await expireOverdue('2027-07-08');

    expect((await findCycleById(cycle.id))?.status).toBe('RETRYING');
    expect((await findSubscriptionById(subscription.id))?.status).toBe('ACTIVE');
  });

  it('nao abandona ciclo com liquidacao ainda prevista para hoje ou depois', async () => {
    const subscription = await createFixture({ nextDueDate: '2027-07-10' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2027-07-10',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: randomUUID() });
    await updateCycleStatus(cycle.id, 'FAILED');
    await updateCycleStatus(cycle.id, 'RETRYING');
    await insertCycleAttempt({ cycleId: cycle.id, attemptNumber: 1, scheduledFor: '2027-07-20' });

    await expireOverdue('2027-07-20');

    expect((await findCycleById(cycle.id))?.status).toBe('RETRYING');
    expect((await findSubscriptionById(subscription.id))?.status).toBe('ACTIVE');
  });

  it('abandona e suspende em D+8 quando nao ha mais liquidacao prevista', async () => {
    const subscription = await createFixture({ nextDueDate: '2027-07-15' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2027-07-15',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: randomUUID() });
    await updateCycleStatus(cycle.id, 'FAILED');
    await insertCycleAttempt({ cycleId: cycle.id, attemptNumber: 1, scheduledFor: '2027-07-15' });
    await updateSubscriptionStatus(subscription.id, 'PAST_DUE');

    await expireOverdue('2027-07-23');

    expect((await findCycleById(cycle.id))?.status).toBe('ABANDONED');
    expect((await findSubscriptionById(subscription.id))?.status).toBe('SUSPENDED');
    expect(await listDeliveredEventTypes(subscription.id)).toContain('subscription.suspended');
  });
});
