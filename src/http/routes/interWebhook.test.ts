import { randomUUID } from 'crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { closePool } from '../../shared/db';
import { AppError } from '../../shared/errors';
import * as inter from '../../providers/inter/pixAutomatico';
import {
  createSubscription as createFixture,
  listDeliveredEventTypes,
} from '../../test/factories';
import { insertCycle, findCycleById, updateCycleStatus } from '../../repositories/cycles';
import { updateSubscriptionStatus, findSubscriptionById } from '../../repositories/subscriptions';
import * as webhookDispatcher from '../../domain/webhookDispatcher';
import * as webhookReceipts from '../../repositories/webhookReceipts';
import { logger } from '../../shared/logger';

const app = createApp();
const WAIT_FOR_OPTS = { timeout: 2000, interval: 20 };

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe('caminhos de callback do Bacen', () => {
  it('aceita POST em /webhooks/inter/rec', async () => {
    const response = await request(app).post('/webhooks/inter/rec').send({ idRec: 'rec-inexistente' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
  });

  it('aceita POST em /webhooks/inter/cobr', async () => {
    const response = await request(app).post('/webhooks/inter/cobr').send({ txid: 'txid-inexistente' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
  });

  it('mantem o caminho sem sufixo funcionando', async () => {
    const response = await request(app).post('/webhooks/inter').send({ txid: 'txid-inexistente' });
    expect(response.status).toBe(200);
  });

  it('nao exige bearer token nos caminhos com sufixo', async () => {
    const response = await request(app).post('/webhooks/inter/rec').send({});
    expect(response.status).not.toBe(401);
  });
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

    await vi.waitFor(async () => {
      expect(getCharge).toHaveBeenCalledWith(txid);
      const updated = await findCycleById(cycle.id);
      expect(updated?.status).toBe('PAID');
      expect(updated?.endToEndId).toBe('E1');
    }, WAIT_FOR_OPTS);
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

    await vi.waitFor(async () => {
      const updated = await findCycleById(cycle.id);
      expect(updated?.status).toBe('FAILED');
    }, WAIT_FOR_OPTS);
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

    const getCharge = vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
      txid,
      status: 'UNKNOWN',
      rawStatus: 'ALGO_NOVO',
    });

    await request(app).post('/webhooks/inter').send({ txid, status: 'PAID' });

    await vi.waitFor(async () => {
      expect(getCharge).toHaveBeenCalledWith(txid);
    }, WAIT_FOR_OPTS);

    const updated = await findCycleById(cycle.id);
    expect(updated?.status).toBe('SENT');

    const untouchedSubscription = await findSubscriptionById(subscription.id);
    expect(untouchedSubscription?.status).toBe('ACTIVE');
  });

  it('nao faz nada quando a cobranca ainda esta apenas criada (nao vencida)', async () => {
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
      status: 'CREATED',
      rawStatus: 'ATIVA',
    });
    const enqueueDelivery = vi.spyOn(webhookDispatcher, 'enqueueDelivery');

    await request(app).post('/webhooks/inter').send({ txid, status: 'PAID' });

    await vi.waitFor(async () => {
      expect(getCharge).toHaveBeenCalledWith(txid);
    }, WAIT_FOR_OPTS);

    const updated = await findCycleById(cycle.id);
    expect(updated?.status).toBe('SENT');

    const untouchedSubscription = await findSubscriptionById(subscription.id);
    expect(untouchedSubscription?.status).toBe('ACTIVE');
    expect(enqueueDelivery).not.toHaveBeenCalled();
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

    await vi.waitFor(async () => {
      const updated = await findCycleById(cycle.id);
      expect(updated?.status).toBe('PAID');
    }, WAIT_FOR_OPTS);

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

    await vi.waitFor(async () => {
      const updated = await findSubscriptionById(subscription.id);
      expect(updated?.status).toBe('ACTIVE');
      expect(updated?.authorizedAt).toBeTruthy();
    }, WAIT_FOR_OPTS);
  });

  it('nao entrega subscription.authorized duas vezes quando o Inter reenvia o mesmo evento', async () => {
    const subscription = await createFixture();
    const recId = randomUUID();
    const eventId = randomUUID();
    await updateSubscriptionStatus(subscription.id, 'PENDING_AUTH', { interRecId: recId });

    vi.spyOn(inter, 'getRecurrence').mockResolvedValue({
      recId,
      status: 'APPROVED',
      rawStatus: 'APROVADA',
    });
    const markProcessed = vi
      .spyOn(webhookReceipts, 'markReceiptProcessed')
      .mockRejectedValueOnce(new Error('queda antes de marcar o recibo'));
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    await request(app).post('/webhooks/inter').send({ idRec: recId, eventId });

    await vi.waitFor(async () => {
      expect((await findSubscriptionById(subscription.id))?.status).toBe('ACTIVE');
    }, WAIT_FOR_OPTS);

    await request(app).post('/webhooks/inter').send({ idRec: recId, eventId });

    await vi.waitFor(() => {
      expect(markProcessed).toHaveBeenCalledTimes(2);
    }, WAIT_FOR_OPTS);

    expect(
      (await listDeliveredEventTypes(subscription.id)).filter(
        (type) => type === 'subscription.authorized',
      ),
    ).toHaveLength(1);
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
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await request(app)
      .post('/webhooks/inter')
      .send({ txid, eventId: randomUUID() });

    expect(response.status).toBe(200);

    await vi.waitFor(() => {
      const lines = output.mock.calls.map((call) => JSON.parse(call[0] as string));
      const failure = lines.find((line) => line.message === 'falha ao processar webhook do inter');
      expect(failure?.level).toBe('error');
      expect(failure?.detail).toBe('inter fora do ar');
    }, WAIT_FOR_OPTS);
  });

  it('reprocessa a entrega repetida quando a primeira tentativa falhou no meio', async () => {
    const subscription = await createFixture();
    const txid = randomUUID();
    const eventId = randomUUID();
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: randomUUID() });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });

    const getCharge = vi
      .spyOn(inter, 'getChargeByTxid')
      .mockRejectedValueOnce(AppError.upstream())
      .mockResolvedValue({
        txid,
        status: 'PAID',
        rawStatus: 'CONCLUIDA',
        endToEndId: 'E-retry',
        paidAt: '2026-09-20T10:00:00Z',
      });

    await request(app).post('/webhooks/inter').send({ txid, eventId });

    await vi.waitFor(() => {
      expect(getCharge).toHaveBeenCalledTimes(1);
    }, WAIT_FOR_OPTS);
    expect((await findCycleById(cycle.id))?.status).toBe('SENT');

    await request(app).post('/webhooks/inter').send({ txid, eventId });

    await vi.waitFor(async () => {
      expect((await findCycleById(cycle.id))?.status).toBe('PAID');
    }, WAIT_FOR_OPTS);

    expect(
      (await listDeliveredEventTypes(subscription.id)).filter((type) => type === 'cycle.paid'),
    ).toHaveLength(1);
  });

  it('ignora corpo invalido sem fazer o Inter reenviar', async () => {
    const getCharge = vi.spyOn(inter, 'getChargeByTxid');

    const response = await request(app)
      .post('/webhooks/inter')
      .send({ txid: 12345, idRec: { nested: true } });

    expect(response.status).toBe(200);
    expect(getCharge).not.toHaveBeenCalled();
  });
});
describe('formato real do Inter (lista recs/cobsr do padrao Bacen)', () => {
  it('aplica a autorizacao quando o Inter manda recs com a recorrencia aprovada', async () => {
    const subscription = await createFixture();
    const recId = `RR${randomUUID().replace(/-/g, '')}`;
    await updateSubscriptionStatus(subscription.id, 'PENDING_AUTH', { interRecId: recId });

    const getRecurrence = vi.spyOn(inter, 'getRecurrence').mockResolvedValue({
      recId,
      status: 'APPROVED',
      rawStatus: 'APROVADA',
    });

    const response = await request(app)
      .post('/webhooks/inter')
      .send({ recs: [{ idRec: recId, status: 'APROVADA', ativacao: { tipoJornada: 'JORNADA_2' } }] });

    expect(response.status).toBe(200);
    await vi.waitFor(async () => {
      expect(getRecurrence).toHaveBeenCalledWith(recId);
      const updated = await findSubscriptionById(subscription.id);
      expect(updated?.status).toBe('ACTIVE');
      expect(await listDeliveredEventTypes(subscription.id)).toContain('subscription.authorized');
    }, WAIT_FOR_OPTS);
  });

  it('consulta a cobranca pelo txid quando o Inter manda cobsr', async () => {
    const subscription = await createFixture();
    const recId = `RR${randomUUID().replace(/-/g, '')}`;
    const txid = randomUUID().replace(/-/g, '');
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
      endToEndId: 'E00416968',
      paidAt: '2026-09-20T10:00:00Z',
    });

    await request(app)
      .post('/webhooks/inter')
      .send({
        cobsr: [
          {
            idRec: recId,
            txid,
            status: 'CONCLUIDA',
            atualizacao: [{ status: 'CONCLUIDA', data: '2026-09-20T07:00:00-03:00' }],
            tentativas: [],
            pix: [],
          },
        ],
      });

    await vi.waitFor(async () => {
      expect(getCharge).toHaveBeenCalledWith(txid);
      expect((await findCycleById(cycle.id))?.status).toBe('PAID');
    }, WAIT_FOR_OPTS);
  });

  it('processa cada item quando a lista traz mais de uma recorrencia', async () => {
    const first = await createFixture();
    const second = await createFixture();
    const firstRec = `RR${randomUUID().replace(/-/g, '')}`;
    const secondRec = `RR${randomUUID().replace(/-/g, '')}`;
    await updateSubscriptionStatus(first.id, 'PENDING_AUTH', { interRecId: firstRec });
    await updateSubscriptionStatus(second.id, 'PENDING_AUTH', { interRecId: secondRec });

    vi.spyOn(inter, 'getRecurrence').mockImplementation(async (recId: string) => ({
      recId,
      status: 'APPROVED',
      rawStatus: 'APROVADA',
    }));

    await request(app)
      .post('/webhooks/inter')
      .send({
        recs: [
          { idRec: firstRec, status: 'APROVADA' },
          { idRec: secondRec, status: 'APROVADA' },
        ],
      });

    await vi.waitFor(async () => {
      expect((await findSubscriptionById(first.id))?.status).toBe('ACTIVE');
      expect((await findSubscriptionById(second.id))?.status).toBe('ACTIVE');
    }, WAIT_FOR_OPTS);
  });

  it('ignora item da lista sem idRec nem txid sem consultar o Inter', async () => {
    const getRecurrence = vi.spyOn(inter, 'getRecurrence');
    const getCharge = vi.spyOn(inter, 'getChargeByTxid');

    const response = await request(app)
      .post('/webhooks/inter')
      .send({ recs: [{ status: 'APROVADA' }], cobsr: [{ status: 'ATIVA' }] });

    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(getRecurrence).not.toHaveBeenCalled();
    expect(getCharge).not.toHaveBeenCalled();
  });
});
