import { randomUUID } from 'crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { closePool } from '../../shared/db';
import * as inter from '../../providers/inter/pixAutomatico';
import { createSubscription as createFixture } from '../../test/factories';
import { insertCycle, findCycleById, updateCycleStatus } from '../../repositories/cycles';
import { updateSubscriptionStatus, findSubscriptionById } from '../../repositories/subscriptions';

const app = createApp();

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe('POST /webhooks/inter', () => {
  it('nao exige o bearer token', async () => {
    const response = await request(app).post('/webhooks/inter').send({ txid: 'inexistente' });
    expect(response.status).toBe(200);
  });

  it('nunca confia no corpo: consulta o Inter antes de marcar como pago', async () => {
    const subscription = await createFixture();
    const recId = randomUUID();
    const txid = randomUUID();
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: recId });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });

    const getCharge = vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
      txid,
      status: 'PAID',
      rawStatus: 'CONCLUIDA',
      endToEndId: 'E1',
      paidAt: '2026-09-20T10:00:00Z',
    });

    await request(app)
      .post('/webhooks/inter')
      .send({ txid, status: 'MENTIRA_DO_ATACANTE' });

    expect(getCharge).toHaveBeenCalledWith(txid);
    const updated = await findCycleById(cycle.id);
    expect(updated?.status).toBe('PAID');
    expect(updated?.endToEndId).toBe('E1');
  });

  it('ignora corpo que diz pago quando o Inter diz que nao foi', async () => {
    const subscription = await createFixture();
    const recId = randomUUID();
    const txid = randomUUID();
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: recId });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });

    vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
      txid,
      status: 'FAILED',
      rawStatus: 'REJEITADA',
      failureReason: 'saldo insuficiente',
    });

    await request(app).post('/webhooks/inter').send({ txid, status: 'PAID' });

    const updated = await findCycleById(cycle.id);
    expect(updated?.status).toBe('FAILED');
  });

  it('nao faz nada quando o status retornado pelo Inter e desconhecido', async () => {
    const subscription = await createFixture();
    const recId = randomUUID();
    const txid = randomUUID();
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: recId });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });

    vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
      txid,
      status: 'UNKNOWN',
      rawStatus: 'ALGO_NOVO',
    });

    await request(app).post('/webhooks/inter').send({ txid, status: 'PAID' });

    const updated = await findCycleById(cycle.id);
    expect(updated?.status).toBe('SENT');
  });

  it('e idempotente: o mesmo evento duas vezes nao duplica efeito', async () => {
    const subscription = await createFixture();
    const recId = randomUUID();
    const txid = randomUUID();
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: recId });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });

    const getCharge = vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
      txid,
      status: 'PAID',
      rawStatus: 'CONCLUIDA',
      endToEndId: 'E3',
      paidAt: '2026-09-20T10:00:00Z',
    });

    const body = { txid, eventId: randomUUID() };
    await request(app).post('/webhooks/inter').send(body);
    await request(app).post('/webhooks/inter').send(body);

    expect(getCharge).toHaveBeenCalledTimes(1);
  });

  it('promove a assinatura para ACTIVE quando a recorrencia e aprovada', async () => {
    const subscription = await createFixture();
    const recId = randomUUID();
    await updateSubscriptionStatus(subscription.id, 'PENDING_AUTH', { interRecId: recId });

    vi.spyOn(inter, 'getRecurrence').mockResolvedValue({
      recId,
      status: 'APPROVED',
      rawStatus: 'APROVADA',
    });

    await request(app)
      .post('/webhooks/inter')
      .send({ idRec: recId, eventId: randomUUID() });

    const updated = await findSubscriptionById(subscription.id);
    expect(updated?.status).toBe('ACTIVE');
    expect(updated?.authorizedAt).toBeTruthy();
  });

  it('responde 200 mesmo quando o processamento falha, para o Inter nao reenviar em loop', async () => {
    const subscription = await createFixture();
    const recId = randomUUID();
    const txid = randomUUID();
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: recId });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });

    vi.spyOn(inter, 'getChargeByTxid').mockRejectedValue(new Error('inter fora do ar'));

    const response = await request(app)
      .post('/webhooks/inter')
      .send({ txid, eventId: randomUUID() });

    expect(response.status).toBe(200);
  });
});
