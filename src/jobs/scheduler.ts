import cron from 'node-cron';
import { logger } from '../shared/logger';
import { businessToday } from '../domain/schedule';
import { deliverPending } from '../domain/webhookDispatcher';
import { withAdvisoryLock } from './lock';
import {
  cancelUnsendableCycles,
  escalateStaleCycles,
  expireOverdue,
  generateCycles,
  reconcile,
  retryFailed,
  sendCharges,
} from './billingJobs';

const LOCK_KEYS = {
  daily: 1001,
  reconcile: 1002,
  deliveries: 1003,
};

async function runDaily(): Promise<void> {
  const date = businessToday();
  const unsendable = await cancelUnsendableCycles(date);
  const generated = await generateCycles(date);
  const sent = await sendCharges(date);
  const retried = await retryFailed(date);
  const escalated = await escalateStaleCycles(date);
  const expired = await expireOverdue(date);
  logger.info('jobs diarios concluidos', {
    unsendable,
    generated,
    sent,
    retried,
    escalated,
    expired,
  });
}

export function startScheduler(): void {
  cron.schedule('0 8 * * *', () => {
    withAdvisoryLock(LOCK_KEYS.daily, runDaily).catch((error) =>
      logger.error('falha nos jobs diarios', { message: (error as Error).message }),
    );
  });

  cron.schedule('0 * * * *', () => {
    withAdvisoryLock(LOCK_KEYS.reconcile, reconcile).catch((error) =>
      logger.error('falha na reconciliacao', { message: (error as Error).message }),
    );
  });

  cron.schedule('* * * * *', () => {
    withAdvisoryLock(LOCK_KEYS.deliveries, deliverPending).catch((error) =>
      logger.error('falha na entrega de webhooks', { message: (error as Error).message }),
    );
  });
}
