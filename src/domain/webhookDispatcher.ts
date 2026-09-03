import axios from 'axios';
import { createHmac } from 'crypto';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import {
  insertDelivery,
  listDueDeliveries,
  markDelivered,
  markFailed,
  markRetry,
} from '../repositories/webhookDeliveries';

export const RETRY_SCHEDULE_MINUTES = [1, 5, 15, 60, 360, 1440];

export function signPayload(body: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export async function enqueueDelivery(
  eventId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  await insertDelivery({
    eventId,
    targetUrl: config.saasWebhookUrl,
    payload: { type, data, eventId },
  });
}

export async function deliverPending(now?: Date): Promise<{ delivered: number; failed: number }> {
  const pending = await listDueDeliveries(50);
  let delivered = 0;
  let failed = 0;

  for (const delivery of pending) {
    const timestamp = (now ?? new Date()).getTime().toString();
    const body = JSON.stringify(delivery.payload);
    const signature = signPayload(body, timestamp, config.saasWebhookSecret);

    try {
      await axios.post(delivery.targetUrl, body, {
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Timestamp': timestamp,
        },
      });
      await markDelivered(delivery.id);
      delivered += 1;
    } catch (error) {
      const message = (error as Error).message;
      const nextDelay = RETRY_SCHEDULE_MINUTES[delivery.attempts];

      if (nextDelay === undefined) {
        await markFailed(delivery.id, message);
        failed += 1;
        logger.error('entrega de webhook esgotou as tentativas', {
          deliveryId: delivery.id,
          message,
        });
      } else {
        await markRetry(delivery.id, message, nextDelay);
        logger.warn('entrega de webhook falhou, reagendada', {
          deliveryId: delivery.id,
          nextDelay,
        });
      }
    }
  }

  return { delivered, failed };
}
