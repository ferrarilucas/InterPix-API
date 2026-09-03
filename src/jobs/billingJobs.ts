import { randomUUID } from 'crypto';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import * as inter from '../providers/inter/pixAutomatico';
import {
  listActiveSubscriptionsDueFor,
  listPendingAuthWithRecId,
  findSubscriptionById,
  updateSubscriptionStatus,
  updateSubscriptionStatusIf,
} from '../repositories/subscriptions';
import {
  countCycleAttempts,
  findCurrentCycle,
  findLatestCycleAttempt,
  insertCycle,
  insertCycleAttempt,
  listCyclesByStatus,
  listCyclesByStatusInRange,
  listCyclesBySubscription,
  updateCycleStatus,
  updateCycleStatusIf,
} from '../repositories/cycles';
import { insertEvent } from '../repositories/events';
import { withTransaction } from '../shared/db';
import {
  addDays,
  addMonths,
  businessToday,
  isDunningWindowOver,
  isSendWindowMissed,
  MAX_LEAD_DAYS,
  nextRetryDate,
  shouldSendCharge,
} from '../domain/schedule';
import { applyChargeStatus } from '../domain/chargeOutcome';

const RECONCILE_GRACE_DAYS = 3;
const MAX_RETRIES_PER_CYCLE = 3;
import { assertCycleTransition, assertSubscriptionTransition } from '../domain/stateMachine';
import { enqueueDelivery } from '../domain/webhookDispatcher';

function newTxid(): string {
  return randomUUID().replace(/-/g, '');
}

export async function generateCycles(today: string): Promise<number> {
  const horizon = addMonths(today, 1);
  const subscriptions = await listActiveSubscriptionsDueFor(horizon);
  let created = 0;

  for (const subscription of subscriptions) {
    try {
      const current = await findCurrentCycle(subscription.id);

      if (current && ['SCHEDULED', 'SENT', 'FAILED', 'RETRYING'].includes(current.status)) {
        continue;
      }

      let dueDate: string | null;
      let seq: number;

      if (current) {
        const existingCycles = await listCyclesBySubscription(subscription.id);
        const firstCycle = existingCycles.find((cycle) => cycle.seq === 1);
        seq = current.seq + 1;
        dueDate = firstCycle
          ? addMonths(firstCycle.dueDate, (seq - 1) * subscription.intervalMonths)
          : null;
      } else {
        seq = 1;
        dueDate = subscription.nextDueDate;
      }

      if (!dueDate) {
        continue;
      }

      await insertCycle({
        subscriptionId: subscription.id,
        seq,
        dueDate,
        amount: subscription.amount,
      });
      await updateSubscriptionStatus(subscription.id, subscription.status, { nextDueDate: dueDate });
      created += 1;
    } catch (error) {
      logger.error('falha ao gerar ciclo', {
        subscriptionId: subscription.id,
        message: (error as Error).message,
      });
    }
  }

  return created;
}

export async function cancelUnsendableCycles(today: string): Promise<number> {
  const cycles = await listCyclesByStatus(['SCHEDULED']);
  let canceled = 0;

  for (const cycle of cycles) {
    if (!isSendWindowMissed(cycle.dueDate, today)) {
      continue;
    }

    try {
      assertCycleTransition(cycle.status, 'CANCELED');

      const applied = await withTransaction(async (client) => {
        const updated = await updateCycleStatusIf(cycle.id, 'SCHEDULED', 'CANCELED', {}, client);

        if (!updated) {
          return false;
        }

        const event = await insertEvent(
          {
            subscriptionId: cycle.subscriptionId,
            cycleId: cycle.id,
            type: 'cycle.failed',
            payload: {
              reason: 'JANELA_DE_ENVIO_EXPIRADA',
              dueDate: cycle.dueDate,
              seq: cycle.seq,
            },
          },
          client,
        );
        await enqueueDelivery(
          event.id,
          'cycle.failed',
          {
            subscriptionId: cycle.subscriptionId,
            cycleSeq: cycle.seq,
            reason: 'JANELA_DE_ENVIO_EXPIRADA',
          },
          client,
        );

        return true;
      });

      if (applied) {
        canceled += 1;
        logger.error('ciclo cancelado sem cobranca por perda da janela de envio', {
          cycleId: cycle.id,
          subscriptionId: cycle.subscriptionId,
          dueDate: cycle.dueDate,
        });
      }
    } catch (error) {
      logger.error('falha ao cancelar ciclo fora da janela', {
        cycleId: cycle.id,
        message: (error as Error).message,
      });
    }
  }

  return canceled;
}

export async function sendCharges(today: string): Promise<number> {
  const cycles = await listCyclesByStatus(['SCHEDULED']);
  let sent = 0;

  for (const cycle of cycles) {
    if (!shouldSendCharge(cycle.dueDate, today)) {
      continue;
    }

    const subscription = await findSubscriptionById(cycle.subscriptionId);

    if (!subscription?.interRecId) {
      continue;
    }

    if (subscription.status !== 'ACTIVE') {
      logger.warn('ciclo ignorado: assinatura nao esta ativa', {
        cycleId: cycle.id,
        subscriptionId: subscription.id,
        status: subscription.status,
      });
      continue;
    }

    const txid = cycle.interTxid ?? newTxid();

    try {
      if (!cycle.interTxid) {
        await updateCycleStatus(cycle.id, cycle.status, { interTxid: txid });
      }

      await inter.createCharge({
        recId: subscription.interRecId,
        txid,
        dueDate: cycle.dueDate,
        amount: cycle.amount,
      });

      assertCycleTransition(cycle.status, 'SENT');
      await updateCycleStatus(cycle.id, 'SENT');
      await insertCycleAttempt({
        cycleId: cycle.id,
        attemptNumber: 1,
        scheduledFor: cycle.dueDate,
      });
      await insertEvent({
        subscriptionId: cycle.subscriptionId,
        cycleId: cycle.id,
        type: 'cycle.sent',
        payload: { txid, dueDate: cycle.dueDate },
      });
      sent += 1;
    } catch (error) {
      logger.error('falha ao enviar cobranca', {
        cycleId: cycle.id,
        message: (error as Error).message,
      });
    }
  }

  return sent;
}

export async function retryFailed(today: string): Promise<number> {
  const cycles = await listCyclesByStatus(['FAILED']);
  let retried = 0;

  for (const cycle of cycles) {
    const scheduledFor = nextRetryDate(cycle.dueDate, today, config.dunningWindowDays);

    if (!scheduledFor || !cycle.interTxid) {
      continue;
    }

    const subscription = await findSubscriptionById(cycle.subscriptionId);

    if (!subscription?.interRecId) {
      continue;
    }

    if (subscription.status !== 'ACTIVE' && subscription.status !== 'PAST_DUE') {
      logger.warn('retentativa ignorada: assinatura nao esta ativa nem inadimplente', {
        cycleId: cycle.id,
        subscriptionId: subscription.id,
        status: subscription.status,
      });
      continue;
    }

    const attempts = await countCycleAttempts(cycle.id);

    if (Math.max(attempts - 1, 0) >= MAX_RETRIES_PER_CYCLE) {
      logger.warn('retentativa ignorada: limite de tentativas atingido', {
        cycleId: cycle.id,
        attempts,
      });
      continue;
    }

    try {
      await inter.createCharge({
        recId: subscription.interRecId,
        txid: cycle.interTxid,
        dueDate: scheduledFor,
        amount: cycle.amount,
      });

      assertCycleTransition(cycle.status, 'RETRYING');
      await updateCycleStatus(cycle.id, 'RETRYING');

      await insertCycleAttempt({
        cycleId: cycle.id,
        attemptNumber: attempts + 1,
        scheduledFor,
      });

      if (subscription.status === 'ACTIVE') {
        assertSubscriptionTransition(subscription.status, 'PAST_DUE');
        await updateSubscriptionStatus(subscription.id, 'PAST_DUE');
        const event = await insertEvent({
          subscriptionId: subscription.id,
          cycleId: cycle.id,
          type: 'subscription.past_due',
          payload: { retryDate: scheduledFor },
        });
        await enqueueDelivery(event.id, 'subscription.past_due', {
          subscriptionId: subscription.id,
          externalUserId: subscription.externalUserId,
          retryDate: scheduledFor,
        });
      }

      retried += 1;
    } catch (error) {
      logger.error('falha ao reenviar cobranca', {
        cycleId: cycle.id,
        message: (error as Error).message,
      });
    }
  }

  return retried;
}

export async function expireOverdue(today: string): Promise<number> {
  const cycles = await listCyclesByStatus(['FAILED', 'RETRYING']);
  let expired = 0;

  for (const cycle of cycles) {
    if (!isDunningWindowOver(cycle.dueDate, today, config.dunningWindowDays)) {
      continue;
    }

    const latestAttempt = await findLatestCycleAttempt(cycle.id);

    if (latestAttempt && latestAttempt.scheduledFor >= today) {
      logger.info('ciclo mantido: ainda ha liquidacao prevista', {
        cycleId: cycle.id,
        scheduledFor: latestAttempt.scheduledFor,
      });
      continue;
    }

    try {
      assertCycleTransition(cycle.status, 'ABANDONED');

      const subscription = await findSubscriptionById(cycle.subscriptionId);
      const toSuspend =
        subscription && ['ACTIVE', 'PAST_DUE'].includes(subscription.status) ? subscription : null;

      if (toSuspend?.interRecId) {
        try {
          await inter.cancelRecurrence(toSuspend.interRecId);
        } catch (error) {
          logger.error('falha ao cancelar recorrencia da assinatura suspensa', {
            subscriptionId: toSuspend.id,
            message: (error as Error).message,
          });
        }
      }

      const applied = await withTransaction(async (client) => {
        const updated = await updateCycleStatusIf(cycle.id, cycle.status, 'ABANDONED', {}, client);

        if (!updated) {
          return false;
        }

        if (toSuspend) {
          if (toSuspend.status === 'ACTIVE') {
            assertSubscriptionTransition(toSuspend.status, 'PAST_DUE');
            await updateSubscriptionStatus(toSuspend.id, 'PAST_DUE', {}, client);
          }

          assertSubscriptionTransition('PAST_DUE', 'SUSPENDED');
          await updateSubscriptionStatus(toSuspend.id, 'SUSPENDED', {}, client);

          const event = await insertEvent(
            {
              subscriptionId: toSuspend.id,
              cycleId: cycle.id,
              type: 'subscription.suspended',
              payload: { cycleSeq: cycle.seq },
            },
            client,
          );
          await enqueueDelivery(
            event.id,
            'subscription.suspended',
            {
              subscriptionId: toSuspend.id,
              externalUserId: toSuspend.externalUserId,
            },
            client,
          );
        }

        return true;
      });

      if (applied) {
        expired += 1;
      }
    } catch (error) {
      logger.error('falha ao expirar ciclo', {
        cycleId: cycle.id,
        message: (error as Error).message,
      });
    }
  }

  return expired;
}

async function reconcileCycles(today: string): Promise<number> {
  const from = addDays(today, -(config.dunningWindowDays + RECONCILE_GRACE_DAYS));
  const to = addDays(today, MAX_LEAD_DAYS);
  const cycles = await listCyclesByStatusInRange(['SENT', 'RETRYING'], from, to);
  let checked = 0;

  for (const cycle of cycles) {
    if (!cycle.interTxid) {
      continue;
    }

    try {
      const charge = await inter.getChargeByTxid(cycle.interTxid);
      await applyChargeStatus(cycle, charge);
      checked += 1;
    } catch (error) {
      logger.error('falha na reconciliacao', {
        cycleId: cycle.id,
        message: (error as Error).message,
      });
    }
  }

  return checked;
}

async function reconcilePendingAuth(): Promise<number> {
  const subscriptions = await listPendingAuthWithRecId();
  let checked = 0;

  for (const subscription of subscriptions) {
    if (!subscription.interRecId) {
      continue;
    }

    try {
      const recurrence = await inter.getRecurrence(subscription.interRecId);

      if (recurrence.status === 'APPROVED') {
        assertSubscriptionTransition(subscription.status, 'ACTIVE');
        const updated = await updateSubscriptionStatusIf(
          subscription.id,
          'PENDING_AUTH',
          'ACTIVE',
          { authorizedAt: new Date().toISOString() },
        );

        if (updated) {
          const event = await insertEvent({
            subscriptionId: subscription.id,
            type: 'subscription.authorized',
            payload: { recId: subscription.interRecId, source: 'reconcile' },
          });
          await enqueueDelivery(event.id, 'subscription.authorized', {
            subscriptionId: subscription.id,
            externalUserId: subscription.externalUserId,
          });
        }
      } else if (recurrence.status === 'DENIED') {
        assertSubscriptionTransition(subscription.status, 'AUTH_DENIED');
        const updated = await updateSubscriptionStatusIf(
          subscription.id,
          'PENDING_AUTH',
          'AUTH_DENIED',
        );

        if (updated) {
          const event = await insertEvent({
            subscriptionId: subscription.id,
            type: 'subscription.auth_denied',
            payload: { recId: subscription.interRecId, source: 'reconcile' },
          });
          await enqueueDelivery(event.id, 'subscription.auth_denied', {
            subscriptionId: subscription.id,
            externalUserId: subscription.externalUserId,
          });
        }
      }

      checked += 1;
    } catch (error) {
      logger.error('falha na reconciliacao de autorizacao', {
        subscriptionId: subscription.id,
        message: (error as Error).message,
      });
    }
  }

  return checked;
}

export async function reconcile(today: string = businessToday()): Promise<number> {
  const cyclesChecked = await reconcileCycles(today);
  const subscriptionsChecked = await reconcilePendingAuth();
  return cyclesChecked + subscriptionsChecked;
}
