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
  listCyclesBySubscription,
  updateCycleStatus,
} from '../repositories/cycles';
import { listEventsBySubscription } from '../repositories/events';
import { findSubscriptionById, updateSubscriptionStatus } from '../repositories/subscriptions';
import * as subscriptionsRepo from '../repositories/subscriptions';
import * as cyclesRepo from '../repositories/cycles';
import * as webhookDispatcher from '../domain/webhookDispatcher';
import {
  cancelUnsendableCycles,
  expireOverdue,
  generateCycles,
  reconcile,
  retryFailed,
  sendCharges,
} from './billingJobs';
import { withAdvisoryLock } from './lock';

beforeEach(() => {
  vi.spyOn(inter, 'getRecurrence').mockResolvedValue({
    recId: 'leftover-inert',
    status: 'UNKNOWN',
    rawStatus: 'INERTE',
  });
  vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
    txid: 'leftover-inert',
    status: 'UNKNOWN',
    rawStatus: 'INERTE',
  });
  vi.spyOn(inter, 'createCharge').mockResolvedValue({
    txid: 'leftover-inert',
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

describe('generateCycles', () => {
  it('cria o primeiro ciclo de uma assinatura ativa sem ciclos', async () => {
    const subscription = await createFixture({ nextDueDate: '2026-11-20' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });

    await generateCycles('2026-11-20');

    const cycles = await listCyclesBySubscription(subscription.id);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].seq).toBe(1);
    expect(cycles[0].dueDate).toBe('2026-11-20');
  });

  it('nao duplica ciclo quando roda duas vezes no mesmo dia', async () => {
    const subscription = await createFixture({ nextDueDate: '2026-11-21' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });

    await generateCycles('2026-11-21');
    await generateCycles('2026-11-21');

    const cycles = await listCyclesBySubscription(subscription.id);
    expect(cycles).toHaveLength(1);
  });

  it('ancora a data de vencimento no primeiro ciclo em vez de encadear a partir do anterior', async () => {
    const subscription = await createFixture({ nextDueDate: '2026-01-31' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });

    await generateCycles('2026-01-31');
    const [firstCycle] = await listCyclesBySubscription(subscription.id);
    await updateCycleStatus(firstCycle.id, 'SENT', { interTxid: randomUUID() });
    await updateCycleStatus(firstCycle.id, 'PAID', { paidAt: new Date().toISOString() });

    await generateCycles('2026-02-28');

    const secondCycle = (await listCyclesBySubscription(subscription.id))[1];
    expect(secondCycle.dueDate).toBe('2026-02-28');

    await updateCycleStatus(secondCycle.id, 'SENT', { interTxid: randomUUID() });
    await updateCycleStatus(secondCycle.id, 'PAID', { paidAt: new Date().toISOString() });

    await generateCycles('2026-03-31');

    const thirdCycle = (await listCyclesBySubscription(subscription.id))[2];
    expect(thirdCycle.dueDate).toBe('2026-03-31');
  });

  it('continua para as demais assinaturas quando uma falha no meio do lote', async () => {
    const subscriptionA = await createFixture({ nextDueDate: '2026-04-10' });
    await updateSubscriptionStatus(subscriptionA.id, 'ACTIVE', { interRecId: randomUUID() });
    const subscriptionB = await createFixture({ nextDueDate: '2026-04-11' });
    await updateSubscriptionStatus(subscriptionB.id, 'ACTIVE', { interRecId: randomUUID() });

    vi.spyOn(cyclesRepo, 'insertCycle').mockImplementationOnce(() => {
      throw new Error('falha simulada na primeira assinatura');
    });

    const created = await generateCycles('2026-04-11');

    expect(created).toBe(1);
    expect(await listCyclesBySubscription(subscriptionA.id)).toHaveLength(0);
    expect(await listCyclesBySubscription(subscriptionB.id)).toHaveLength(1);
  });
});

describe('sendCharges', () => {
  it('envia cobr apenas dentro da janela e registra a primeira tentativa', async () => {
    const txid = randomUUID();
    const createCharge = vi
      .spyOn(inter, 'createCharge')
      .mockResolvedValue({ txid, status: 'CREATED', rawStatus: 'CRIADA' });

    const subscription = await createFixture({ nextDueDate: '2026-11-25' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-11-25',
      amount: '29.90',
    });

    await sendCharges('2026-11-22');

    expect(createCharge).toHaveBeenCalled();
    const updated = await findCycleById(cycle.id);
    expect(updated?.status).toBe('SENT');
    expect(updated?.interTxid).toBeTruthy();
    expect(await countCycleAttempts(cycle.id)).toBe(1);
  });

  it('nao envia fora da janela de 10 a 2 dias', async () => {
    const subscription = await createFixture({ nextDueDate: '2026-11-26' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const tooLate = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-11-26',
      amount: '29.90',
    });
    const tooEarly = await insertCycle({
      subscriptionId: subscription.id,
      seq: 2,
      dueDate: '2026-12-20',
      amount: '29.90',
    });

    await sendCharges('2026-11-25');

    expect((await findCycleById(tooLate.id))?.status).toBe('SCHEDULED');
    expect((await findCycleById(tooLate.id))?.interTxid).toBeNull();
    expect((await findCycleById(tooEarly.id))?.status).toBe('SCHEDULED');
  });

  it('envia no limite de 10 dias de antecedencia', async () => {
    const subscription = await createFixture({ nextDueDate: '2026-12-11' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-12-11',
      amount: '29.90',
    });

    await sendCharges('2026-12-01');

    expect((await findCycleById(cycle.id))?.status).toBe('SENT');
  });
});

describe('cancelUnsendableCycles', () => {
  it('cancela o ciclo SCHEDULED que perdeu a janela e avisa o SaaS', async () => {
    const subscription = await createFixture({ nextDueDate: '2026-12-01' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-12-01',
      amount: '29.90',
    });

    const canceled = await cancelUnsendableCycles('2026-11-30');

    expect(canceled).toBeGreaterThanOrEqual(1);
    expect((await findCycleById(cycle.id))?.status).toBe('CANCELED');
    expect(await listDeliveredEventTypes(subscription.id)).toContain('cycle.failed');
  });

  it('nao toca em ciclo que ainda pode ser enviado', async () => {
    const subscription = await createFixture({ nextDueDate: '2026-12-02' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-12-02',
      amount: '29.90',
    });

    await cancelUnsendableCycles('2026-11-29');

    expect((await findCycleById(cycle.id))?.status).toBe('SCHEDULED');
  });

  it('desbloqueia a geracao do proximo ciclo da assinatura', async () => {
    const subscription = await createFixture({ nextDueDate: '2026-12-03' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-12-03',
      amount: '29.90',
    });

    await cancelUnsendableCycles('2026-12-02');
    await generateCycles('2026-12-02');

    const cycles = await listCyclesBySubscription(subscription.id);
    expect(cycles).toHaveLength(2);
    expect(cycles[1].seq).toBe(2);
    expect(cycles[1].dueDate).toBe('2027-01-03');
  });
});

describe('retryFailed', () => {
  it('reenvia com o mesmo txid e incrementa a tentativa', async () => {
    const txid = randomUUID();
    const createCharge = vi
      .spyOn(inter, 'createCharge')
      .mockResolvedValue({ txid, status: 'CREATED', rawStatus: 'CRIADA' });

    const subscription = await createFixture({ nextDueDate: '2026-11-27' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-11-27',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });
    await updateCycleStatus(cycle.id, 'FAILED');

    await retryFailed('2026-11-28');

    expect(createCharge.mock.calls[0][0].txid).toBe(txid);
    const updated = await findCycleById(cycle.id);
    expect(updated?.status).toBe('RETRYING');
    expect(await countCycleAttempts(cycle.id)).toBe(1);
  });

  it('nao reenvia depois dos 7 dias de janela', async () => {
    const createCharge = vi.spyOn(inter, 'createCharge');

    const subscription = await createFixture({ nextDueDate: '2026-11-01' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-11-01',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: randomUUID() });
    await updateCycleStatus(cycle.id, 'FAILED');

    await retryFailed('2026-11-20');

    expect(createCharge).not.toHaveBeenCalled();
  });
});

describe('expireOverdue', () => {
  it('abandona o ciclo e suspende a assinatura apos a janela', async () => {
    const subscription = await createFixture({ nextDueDate: '2026-11-02' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-11-02',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: randomUUID() });
    await updateCycleStatus(cycle.id, 'FAILED');
    await updateSubscriptionStatus(subscription.id, 'PAST_DUE');

    await expireOverdue('2026-11-11');

    expect((await findCycleById(cycle.id))?.status).toBe('ABANDONED');
    expect((await findSubscriptionById(subscription.id))?.status).toBe('SUSPENDED');
  });
});

describe('reconcile', () => {
  it('marca o ciclo como pago quando o provider confirma PAID', async () => {
    const txid = randomUUID();
    vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
      txid,
      status: 'PAID',
      rawStatus: 'CONCLUIDA',
      endToEndId: 'E1',
      paidAt: '2026-11-05T10:00:00Z',
    });

    const subscription = await createFixture({ nextDueDate: '2026-11-05' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-11-05',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });

    await reconcile('2026-11-05');

    expect((await findCycleById(cycle.id))?.status).toBe('PAID');
  });

  it('nao marca como pago quando o provider devolve UNKNOWN', async () => {
    const txid = randomUUID();
    vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
      txid,
      status: 'UNKNOWN',
      rawStatus: 'ALGO_NOVO',
    });

    const subscription = await createFixture({ nextDueDate: '2026-11-06' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-11-06',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });

    await reconcile('2026-11-06');

    expect((await findCycleById(cycle.id))?.status).toBe('SENT');
  });

  it('recupera assinatura presa em PENDING_AUTH quando o Inter ja aprovou', async () => {
    const recId = randomUUID();
    vi.spyOn(inter, 'getRecurrence').mockResolvedValue({
      recId,
      status: 'APPROVED',
      rawStatus: 'APROVADA',
    });

    const subscription = await createFixture({ nextDueDate: '2026-11-07' });
    await updateSubscriptionStatus(subscription.id, 'PENDING_AUTH', { interRecId: recId });

    await reconcile();

    expect((await findSubscriptionById(subscription.id))?.status).toBe('ACTIVE');
  });

  it('recupera assinatura presa em PENDING_AUTH quando o Inter negou', async () => {
    const recId = randomUUID();
    vi.spyOn(inter, 'getRecurrence').mockResolvedValue({
      recId,
      status: 'DENIED',
      rawStatus: 'REJEITADA',
    });

    const subscription = await createFixture({ nextDueDate: '2026-11-08' });
    await updateSubscriptionStatus(subscription.id, 'PENDING_AUTH', { interRecId: recId });

    await reconcile();

    expect((await findSubscriptionById(subscription.id))?.status).toBe('AUTH_DENIED');
  });

  it('nao entrega evento duplicado quando a assinatura ja foi aprovada por outro caminho antes da escrita', async () => {
    const recId = randomUUID();
    const subscription = await createFixture({ nextDueDate: '2026-11-09' });
    await updateSubscriptionStatus(subscription.id, 'PENDING_AUTH', { interRecId: recId });
    const staleSnapshot = await findSubscriptionById(subscription.id);

    await updateSubscriptionStatus(subscription.id, 'ACTIVE', {
      authorizedAt: new Date().toISOString(),
    });

    vi.spyOn(subscriptionsRepo, 'listPendingAuthWithRecId').mockResolvedValueOnce([
      staleSnapshot!,
    ]);
    vi.spyOn(inter, 'getRecurrence').mockResolvedValue({
      recId,
      status: 'APPROVED',
      rawStatus: 'APROVADA',
    });
    const enqueueSpy = vi.spyOn(webhookDispatcher, 'enqueueDelivery');

    await reconcile();

    expect(enqueueSpy).not.toHaveBeenCalled();
    const events = await listEventsBySubscription(subscription.id);
    expect(events.filter((event) => event.type === 'subscription.authorized')).toHaveLength(0);
    expect((await findSubscriptionById(subscription.id))?.status).toBe('ACTIVE');
  });
});

describe('withAdvisoryLock', () => {
  it('impede execucao concorrente da mesma chave', async () => {
    let running = 0;
    let maxConcurrent = 0;

    const task = async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 50));
      running -= 1;
      return true;
    };

    await Promise.all([withAdvisoryLock(9001, task), withAdvisoryLock(9001, task)]);

    expect(maxConcurrent).toBe(1);
  });

  it('devolve null quando outra replica ja tem o lock', async () => {
    const holder = withAdvisoryLock(9002, () => new Promise((resolve) => setTimeout(resolve, 100)));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await withAdvisoryLock(9002, async () => 'nunca deveria rodar');

    expect(result).toBeNull();
    await holder;
  });
});
