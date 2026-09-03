import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../shared/db';
import * as inter from '../providers/inter/pixAutomatico';
import {
  createSubscription as createFixture,
  listDeliveredEventTypes,
} from '../test/factories';
import { insertCycle, updateCycleStatus } from '../repositories/cycles';
import { updateSubscriptionStatus } from '../repositories/subscriptions';
import { expireOverdue, retryFailed } from '../jobs/billingJobs';
import { processInterEvent } from './webhookProcessor';
import { cancelSubscription } from './subscriptionService';

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

async function authorized(): Promise<string> {
  const recId = randomUUID();
  const subscription = await createFixture({ nextDueDate: '2028-03-10' });
  await updateSubscriptionStatus(subscription.id, 'PENDING_AUTH', { interRecId: recId });
  vi.spyOn(inter, 'getRecurrence').mockResolvedValue({
    recId,
    status: 'APPROVED',
    rawStatus: 'APROVADA',
  });

  await processInterEvent({ idRec: recId, eventId: randomUUID() });
  return subscription.id;
}

async function authDenied(): Promise<string> {
  const recId = randomUUID();
  const subscription = await createFixture({ nextDueDate: '2028-03-11' });
  await updateSubscriptionStatus(subscription.id, 'PENDING_AUTH', { interRecId: recId });
  vi.spyOn(inter, 'getRecurrence').mockResolvedValue({
    recId,
    status: 'DENIED',
    rawStatus: 'REJEITADA',
  });

  await processInterEvent({ idRec: recId, eventId: randomUUID() });
  return subscription.id;
}

async function cyclePaid(): Promise<string> {
  const txid = randomUUID();
  const subscription = await createFixture({ nextDueDate: '2028-03-12' });
  await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
  const cycle = await insertCycle({
    subscriptionId: subscription.id,
    seq: 1,
    dueDate: '2028-03-12',
    amount: '29.90',
  });
  await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });
  vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
    txid,
    status: 'PAID',
    rawStatus: 'CONCLUIDA',
    endToEndId: 'E-contract',
    paidAt: '2028-03-12T10:00:00Z',
  });

  await processInterEvent({ txid, eventId: randomUUID() });
  return subscription.id;
}

async function cycleFailed(): Promise<string> {
  const txid = randomUUID();
  const subscription = await createFixture({ nextDueDate: '2028-03-13' });
  await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
  const cycle = await insertCycle({
    subscriptionId: subscription.id,
    seq: 1,
    dueDate: '2028-03-13',
    amount: '29.90',
  });
  await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });
  vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
    txid,
    status: 'FAILED',
    rawStatus: 'REJEITADA',
    failureReason: 'SALDO_INSUFICIENTE',
  });

  await processInterEvent({ txid, eventId: randomUUID() });
  return subscription.id;
}

async function pastDue(): Promise<string> {
  const subscription = await createFixture({ nextDueDate: '2028-04-10' });
  await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
  const cycle = await insertCycle({
    subscriptionId: subscription.id,
    seq: 1,
    dueDate: '2028-04-10',
    amount: '29.90',
  });
  await updateCycleStatus(cycle.id, 'SENT', { interTxid: randomUUID() });
  await updateCycleStatus(cycle.id, 'FAILED');

  await retryFailed('2028-04-11');
  return subscription.id;
}

async function suspended(): Promise<string> {
  const subscription = await createFixture({ nextDueDate: '2028-05-10' });
  await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
  const cycle = await insertCycle({
    subscriptionId: subscription.id,
    seq: 1,
    dueDate: '2028-05-10',
    amount: '29.90',
  });
  await updateCycleStatus(cycle.id, 'SENT', { interTxid: randomUUID() });
  await updateCycleStatus(cycle.id, 'FAILED');
  await updateSubscriptionStatus(subscription.id, 'PAST_DUE');

  await expireOverdue('2028-05-20');
  return subscription.id;
}

async function canceled(): Promise<string> {
  const subscription = await createFixture({ nextDueDate: '2028-06-10' });
  await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });

  await cancelSubscription(subscription.id, '2028-06-01');
  return subscription.id;
}

const OUTBOUND_EVENTS: Array<{ type: string; produce: () => Promise<string> }> = [
  { type: 'subscription.authorized', produce: authorized },
  { type: 'subscription.auth_denied', produce: authDenied },
  { type: 'cycle.paid', produce: cyclePaid },
  { type: 'cycle.failed', produce: cycleFailed },
  { type: 'subscription.past_due', produce: pastDue },
  { type: 'subscription.suspended', produce: suspended },
  { type: 'subscription.canceled', produce: canceled },
];

describe('contrato de eventos de saida', () => {
  for (const event of OUTBOUND_EVENTS) {
    it(`enfileira ${event.type} para o SaaS`, async () => {
      const subscriptionId = await event.produce();
      expect(await listDeliveredEventTypes(subscriptionId)).toContain(event.type);
    });
  }
});
