import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from '../shared/db';
import { createSubscription } from '../test/factories';
import { insertCycle } from './cycles';
import { insertEvent, listEventsBySubscription } from './events';

afterAll(async () => {
  await closePool();
});

describe('events repository', () => {
  it('insere evento com subscriptionId e devolve id, tipo e payload intactos', async () => {
    const subscription = await createSubscription();

    const inserted = await insertEvent({
      subscriptionId: subscription.id,
      type: 'SUBSCRIPTION_CREATED',
      payload: { plan: 'mensal_29_90', amount: '29.90' },
    });

    expect(inserted.id).toBeTruthy();

    const events = await listEventsBySubscription(subscription.id);

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(inserted.id);
    expect(events[0].type).toBe('SUBSCRIPTION_CREATED');
    expect(events[0].payload).toEqual({ plan: 'mensal_29_90', amount: '29.90' });
    expect(typeof events[0].payload).toBe('object');
  });

  it('aceita evento com cycleId e sem subscriptionId', async () => {
    const subscription = await createSubscription();
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-15',
      amount: '29.90',
    });

    const inserted = await insertEvent({
      cycleId: cycle.id,
      type: 'CYCLE_SENT',
      payload: { txid: 'txid-evento-1' },
    });

    expect(inserted.id).toBeTruthy();
  });

  it('lista apenas os eventos da assinatura pedida, em ordem crescente de id', async () => {
    const subscriptionA = await createSubscription();
    const subscriptionB = await createSubscription();

    const first = await insertEvent({
      subscriptionId: subscriptionA.id,
      type: 'SUBSCRIPTION_CREATED',
      payload: { step: 1 },
    });
    const second = await insertEvent({
      subscriptionId: subscriptionA.id,
      type: 'SUBSCRIPTION_AUTHORIZED',
      payload: { step: 2 },
    });
    await insertEvent({
      subscriptionId: subscriptionB.id,
      type: 'SUBSCRIPTION_CREATED',
      payload: { step: 1 },
    });

    const events = await listEventsBySubscription(subscriptionA.id);

    expect(events.map((event) => event.id)).toEqual([first.id, second.id]);
    expect(events.every((event) => event.type.startsWith('SUBSCRIPTION_'))).toBe(true);
  });
});
