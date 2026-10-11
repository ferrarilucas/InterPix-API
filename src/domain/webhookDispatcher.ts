import axios from 'axios';
import { createHmac } from 'crypto';
import { PoolClient } from 'pg';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { LOCK_KEYS, withAdvisoryLock } from '../jobs/lock';
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
  client?: PoolClient,
): Promise<void> {
  await insertDelivery(
    {
      eventId,
      targetUrl: config.saasWebhookUrl,
      payload: { type, data, eventId },
    },
    client,
  );
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
      const response = await axios.post(delivery.targetUrl, body, {
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Timestamp': timestamp,
        },
      });
      await markDelivered(delivery.id);
      delivered += 1;
      logger.info('webhook entregue ao saas', {
        deliveryId: delivery.id,
        type: (delivery.payload as { type?: string }).type ?? null,
        attempt: delivery.attempts + 1,
        status: response.status,
        responseBody: response.data ?? null,
      });
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
          type: (delivery.payload as { type?: string }).type ?? null,
          attempt: delivery.attempts + 1,
          status: axios.isAxiosError(error) ? error.response?.status ?? null : null,
          responseBody: axios.isAxiosError(error) ? error.response?.data ?? null : null,
          nextDelay,
          message,
        });
      }
    }
  }

  return { delivered, failed };
}

export async function deliverNow(): Promise<void> {
  try {
    await withAdvisoryLock(LOCK_KEYS.deliveries, () => deliverPending());
  } catch (error) {
    logger.error('falha na entrega imediata de webhooks', {
      message: (error as Error).message,
    });
  }
}
