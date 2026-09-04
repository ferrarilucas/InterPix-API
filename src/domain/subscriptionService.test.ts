import { randomUUID } from 'crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../shared/db';
import { AppError } from '../shared/errors';
import * as inter from '../providers/inter/pixAutomatico';
import { insertCycle } from '../repositories/cycles';
import { listEventsBySubscription } from '../repositories/events';
import { findSubscriptionById } from '../repositories/subscriptions';
import { query } from '../shared/db';
import { createSubscription, getSubscriptionDetail } from './subscriptionService';

const runId = randomUUID();

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe('createSubscription', () => {
  it('cria a assinatura em PENDING_AUTH, grava o recId do Inter e registra o evento', async () => {
    const recId = `rec-svc-${runId}`;

    vi.spyOn(inter, 'createRecurrence').mockResolvedValue({
      recId,
      status: 'CREATED',
      rawStatus: 'CRIADA',
    });
    vi.spyOn(inter, 'getRecurrence').mockResolvedValue({
      recId,
      status: 'CREATED',
      rawStatus: 'CRIADA',
      pixCopyPaste: '00020126ccc',
      url: 'https://inter/autorizacao/svc',
    });

    const result = await createSubscription({
      externalUserId: `usr_svc_${runId}`,
      planCode: 'mensal_29_90',
      amount: '29.90',
      intervalMonths: 1,
      firstDueDate: '2026-12-20',
      debtor: { taxId: '12345678901', name: 'Fulano de Tal' },
    });

    expect(result.subscription.status).toBe('PENDING_AUTH');
    expect(result.subscription.interRecId).toBe(recId);
    expect(result.authorization.pixCopyPaste).toBe('00020126ccc');
    expect(result.authorization.url).toBe('https://inter/autorizacao/svc');

    const events = await listEventsBySubscription(result.subscription.id);
    expect(events.some((event) => event.type === 'subscription.created')).toBe(true);
  });

  it('propaga o erro do Inter sem gravar recId nenhum', async () => {
    vi.spyOn(inter, 'createRecurrence').mockRejectedValue(AppError.upstream());

    await expect(
      createSubscription({
        externalUserId: `usr_svc_fail_${runId}`,
        planCode: 'mensal_29_90',
        amount: '29.90',
        intervalMonths: 1,
        firstDueDate: '2026-12-20',
        debtor: { taxId: '12345678901', name: 'Fulano de Tal' },
      }),
    ).rejects.toThrow(AppError);
  });

  it('marca a assinatura como AUTH_DENIED quando o Inter falha, em vez de deixar orfa', async () => {
    vi.spyOn(inter, 'createRecurrence').mockRejectedValue(AppError.upstream());

    const externalUserId = `usr_svc_orphan_${runId}`;

    await expect(
      createSubscription({
        externalUserId,
        planCode: 'mensal_29_90',
        amount: '29.90',
        intervalMonths: 1,
        firstDueDate: '2026-12-20',
        debtor: { taxId: '12345678901', name: 'Fulano de Tal' },
      }),
    ).rejects.toThrow(AppError);

    const rows = await query<{ id: string }>(
      'SELECT id FROM subscriptions WHERE external_user_id = $1',
      [externalUserId],
    );
    expect(rows).toHaveLength(1);

    const stored = await findSubscriptionById(rows[0].id);
    expect(stored?.status).toBe('AUTH_DENIED');

    const events = await listEventsBySubscription(rows[0].id);
    expect(events.some((event) => event.type === 'subscription.auth_denied')).toBe(true);
  });

  it('guarda o recId quando a busca da recorrencia falha depois de criada', async () => {
    const recId = `rec-svc-half-${runId}`;
    vi.spyOn(inter, 'createRecurrence').mockResolvedValue({
      recId,
      status: 'CREATED',
      rawStatus: 'CRIADA',
    });
    vi.spyOn(inter, 'getRecurrence').mockRejectedValue(AppError.upstream());

    const externalUserId = `usr_svc_half_${runId}`;

    await expect(
      createSubscription({
        externalUserId,
        planCode: 'mensal_29_90',
        amount: '29.90',
        intervalMonths: 1,
        firstDueDate: '2026-12-20',
        debtor: { taxId: '12345678901', name: 'Fulano de Tal' },
      }),
    ).rejects.toThrow(AppError);

    const rows = await query<{ id: string }>(
      'SELECT id FROM subscriptions WHERE external_user_id = $1',
      [externalUserId],
    );
    const stored = await findSubscriptionById(rows[0].id);
    expect(stored?.status).toBe('AUTH_DENIED');
    expect(stored?.interRecId).toBe(recId);
  });
});

describe('getSubscriptionDetail', () => {
  it('devolve a assinatura junto com seus ciclos ordenados', async () => {
    const recId = `rec-detail-${runId}`;

    vi.spyOn(inter, 'createRecurrence').mockResolvedValue({
      recId,
      status: 'CREATED',
      rawStatus: 'CRIADA',
    });
    vi.spyOn(inter, 'getRecurrence').mockResolvedValue({
      recId,
      status: 'PENDING_AUTH',
      rawStatus: 'PENDENTE',
    });

    const created = await createSubscription({
      externalUserId: `usr_detail_${runId}`,
      planCode: 'mensal_29_90',
      amount: '29.90',
      intervalMonths: 1,
      firstDueDate: '2026-12-20',
      debtor: { taxId: '12345678901', name: 'Fulano de Tal' },
    });

    await insertCycle({
      subscriptionId: created.subscription.id,
      seq: 1,
      dueDate: '2026-12-20',
      amount: '29.90',
    });

    const detail = await getSubscriptionDetail(created.subscription.id);

    expect(detail.subscription.id).toBe(created.subscription.id);
    expect(detail.cycles).toHaveLength(1);
    expect(detail.cycles[0].seq).toBe(1);
  });

  it('lanca 404 quando a assinatura nao existe', async () => {
    await expect(
      getSubscriptionDetail('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
