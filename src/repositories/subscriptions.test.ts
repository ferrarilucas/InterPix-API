import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from '../shared/db';
import { createSubscription } from '../test/factories';
import {
  findSubscriptionById,
  findSubscriptionByRecId,
  listActiveSubscriptionsDueFor,
  updateSubscriptionStatus,
} from './subscriptions';

afterAll(async () => {
  await closePool();
});

describe('subscriptions repository', () => {
  it('insere com status PENDING_AUTH e devolve o registro mapeado', async () => {
    const subscription = await createSubscription();

    expect(subscription.id).toBeTruthy();
    expect(subscription.status).toBe('PENDING_AUTH');
    expect(subscription.amount).toBe('29.90');
    expect(subscription.externalUserId).toMatch(/^usr_/);
  });

  it('busca por id', async () => {
    const created = await createSubscription();
    const found = await findSubscriptionById(created.id);

    expect(found?.id).toBe(created.id);
  });

  it('devolve null para id inexistente', async () => {
    const found = await findSubscriptionById('00000000-0000-0000-0000-000000000000');
    expect(found).toBeNull();
  });

  it('atualiza status e campos do patch juntos', async () => {
    const created = await createSubscription();

    const updated = await updateSubscriptionStatus(created.id, 'ACTIVE', {
      interRecId: 'rec-123',
      authorizedAt: new Date().toISOString(),
    });

    expect(updated.status).toBe('ACTIVE');
    expect(updated.interRecId).toBe('rec-123');
    expect(updated.authorizedAt).toBeTruthy();
  });

  it('busca por rec id do Inter', async () => {
    const created = await createSubscription();
    await updateSubscriptionStatus(created.id, 'ACTIVE', { interRecId: 'rec-busca' });

    const found = await findSubscriptionByRecId('rec-busca');
    expect(found?.id).toBe(created.id);
  });

  it('lista apenas assinaturas ACTIVE com vencimento ate a data pedida', async () => {
    const dueSoon = await createSubscription({ nextDueDate: '2026-10-01' });
    const dueLater = await createSubscription({ nextDueDate: '2026-12-01' });
    const pending = await createSubscription({ nextDueDate: '2026-10-01' });

    await updateSubscriptionStatus(dueSoon.id, 'ACTIVE', { interRecId: 'rec-a' });
    await updateSubscriptionStatus(dueLater.id, 'ACTIVE', { interRecId: 'rec-b' });

    const result = await listActiveSubscriptionsDueFor('2026-10-01');
    const ids = result.map((item) => item.id);

    expect(ids).toContain(dueSoon.id);
    expect(ids).not.toContain(dueLater.id);
    expect(ids).not.toContain(pending.id);
  });
});
