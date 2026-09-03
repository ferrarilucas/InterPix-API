import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createHmac } from 'crypto';
import { closePool, query } from '../shared/db';
import { config } from '../shared/config';
import { insertEvent } from '../repositories/events';
import { createSubscription as createFixture } from '../test/factories';
import { deliverPending, enqueueDelivery, signPayload } from './webhookDispatcher';

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe('signPayload', () => {
  it('produz HMAC-SHA256 de timestamp.body', () => {
    const expected = createHmac('sha256', 'segredo').update('123.corpo').digest('hex');
    expect(signPayload('corpo', '123', 'segredo')).toBe(expected);
  });
});

describe('deliverPending', () => {
  it('envia com os headers de assinatura e marca como entregue', async () => {
    const subscription = await createFixture();
    const event = await insertEvent({
      subscriptionId: subscription.id,
      type: 'cycle.paid',
      payload: {},
    });
    await enqueueDelivery(event.id, 'cycle.paid', { subscriptionId: subscription.id });

    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200 } as never);

    const result = await deliverPending();

    expect(result.delivered).toBeGreaterThanOrEqual(1);
    const headers = post.mock.calls[0][2]?.headers as Record<string, string>;
    expect(headers['X-Signature']).toBeTruthy();
    expect(headers['X-Timestamp']).toBeTruthy();

    const body = post.mock.calls[0][1] as string;
    const expectedSignature = createHmac('sha256', config.saasWebhookSecret)
      .update(`${headers['X-Timestamp']}.${body}`)
      .digest('hex');
    expect(headers['X-Signature']).toBe(expectedSignature);
  });

  it('agenda retry crescente quando a entrega falha', async () => {
    const subscription = await createFixture();
    const event = await insertEvent({
      subscriptionId: subscription.id,
      type: 'cycle.failed',
      payload: {},
    });
    await enqueueDelivery(event.id, 'cycle.failed', { subscriptionId: subscription.id });

    vi.spyOn(axios, 'post').mockRejectedValue(new Error('saas fora do ar'));

    await deliverPending();

    const rows = await query<{ status: string; attempts: number; next_retry_at: string }>(
      'SELECT status, attempts, next_retry_at FROM webhook_deliveries WHERE event_id = $1',
      [event.id],
    );

    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].next_retry_at).toBeTruthy();
  });

  it('marca FAILED depois de esgotar a escala de retry', async () => {
    const subscription = await createFixture();
    const event = await insertEvent({
      subscriptionId: subscription.id,
      type: 'cycle.failed',
      payload: {},
    });
    await enqueueDelivery(event.id, 'cycle.failed', { subscriptionId: subscription.id });
    await query('UPDATE webhook_deliveries SET attempts = 6 WHERE event_id = $1', [event.id]);

    vi.spyOn(axios, 'post').mockRejectedValue(new Error('saas fora do ar'));

    await deliverPending();

    const rows = await query<{ status: string }>(
      'SELECT status FROM webhook_deliveries WHERE event_id = $1',
      [event.id],
    );
    expect(rows[0].status).toBe('FAILED');
  });

  it('nao entrega antes do next_retry_at', async () => {
    const subscription = await createFixture();
    const event = await insertEvent({
      subscriptionId: subscription.id,
      type: 'cycle.paid',
      payload: {},
    });
    await enqueueDelivery(event.id, 'cycle.paid', { subscriptionId: subscription.id });
    await query(
      "UPDATE webhook_deliveries SET next_retry_at = now() + interval '1 hour' WHERE event_id = $1",
      [event.id],
    );

    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200 } as never);

    await deliverPending();

    const called = post.mock.calls.some((call) => {
      const body = JSON.parse(call[1] as string) as { eventId: string };
      return body.eventId === event.id;
    });
    expect(called).toBe(false);
  });
});
