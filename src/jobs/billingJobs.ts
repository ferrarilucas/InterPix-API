import { randomUUID } from 'crypto';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import * as inter from '../providers/inter/pixAutomatico';
import {
  listActiveSubscriptionsDueFor,
  listPendingAuthWithRecId,
  findSubscriptionById,
  updateSubscriptionStatus,
} from '../repositories/subscriptions';
import {
  countCycleAttempts,
  findCurrentCycle,
  insertCycle,
  insertCycleAttempt,
  listCyclesByStatus,
  listCyclesBySubscription,
  updateCycleStatus,
} from '../repositories/cycles';
import { insertEvent } from '../repositories/events';
import { addMonths, nextRetryDate, shouldSendCharge } from '../domain/schedule';
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
  }

  return created;
}

export async function sendCharges(today: string): Promise<number> {
  const cycles = await listCyclesByStatus(['SCHEDULED']);
  let sent = 0;

  for (const cycle of cycles) {
    if (!shouldSendCharge(cycle.dueDate, today, config.chargeLeadDays)) {
      continue;
    }

    const subscription = await findSubscriptionById(cycle.subscriptionId);

    if (!subscription?.interRecId) {
      continue;
    }

    const txid = cycle.interTxid ?? newTxid();

    try {
      await inter.createCharge({
        recId: subscription.interRecId,
        txid,
        dueDate: cycle.dueDate,
        amount: cycle.amount,
      });

      assertCycleTransition(cycle.status, 'SENT');
      await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });
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

    try {
      await inter.createCharge({
        recId: subscription.interRecId,
        txid: cycle.interTxid,
        dueDate: scheduledFor,
        amount: cycle.amount,
      });

      assertCycleTransition(cycle.status, 'RETRYING');
      await updateCycleStatus(cycle.id, 'RETRYING');

      const attempts = await countCycleAttempts(cycle.id);
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
    if (nextRetryDate(cycle.dueDate, today, config.dunningWindowDays)) {
      continue;
    }

    assertCycleTransition(cycle.status, 'ABANDONED');
    await updateCycleStatus(cycle.id, 'ABANDONED');

    const subscription = await findSubscriptionById(cycle.subscriptionId);

    if (subscription && ['ACTIVE', 'PAST_DUE'].includes(subscription.status)) {
      if (subscription.status === 'ACTIVE') {
        assertSubscriptionTransition(subscription.status, 'PAST_DUE');
        await updateSubscriptionStatus(subscription.id, 'PAST_DUE');
      }

      assertSubscriptionTransition('PAST_DUE', 'SUSPENDED');
      await updateSubscriptionStatus(subscription.id, 'SUSPENDED');

      const event = await insertEvent({
        subscriptionId: subscription.id,
        cycleId: cycle.id,
        type: 'subscription.suspended',
        payload: { cycleSeq: cycle.seq },
      });
      await enqueueDelivery(event.id, 'subscription.suspended', {
        subscriptionId: subscription.id,
        externalUserId: subscription.externalUserId,
      });
    }

    expired += 1;
  }

  return expired;
}

async function reconcileCycles(): Promise<number> {
  const cycles = await listCyclesByStatus(['SENT', 'RETRYING']);
  let checked = 0;

  for (const cycle of cycles) {
    if (!cycle.interTxid) {
      continue;
    }

    try {
      const charge = await inter.getChargeByTxid(cycle.interTxid);

      if (charge.status === 'PAID') {
        assertCycleTransition(cycle.status, 'PAID');
        await updateCycleStatus(cycle.id, 'PAID', {
          endToEndId: charge.endToEndId,
          paidAt: charge.paidAt ?? new Date().toISOString(),
        });

        const event = await insertEvent({
          subscriptionId: cycle.subscriptionId,
          cycleId: cycle.id,
          type: 'cycle.paid',
          payload: { txid: cycle.interTxid, source: 'reconcile' },
        });
        await enqueueDelivery(event.id, 'cycle.paid', {
          subscriptionId: cycle.subscriptionId,
          cycleSeq: cycle.seq,
          amount: cycle.amount,
        });
      }

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
        await updateSubscriptionStatus(subscription.id, 'ACTIVE', {
          authorizedAt: new Date().toISOString(),
        });

        const event = await insertEvent({
          subscriptionId: subscription.id,
          type: 'subscription.authorized',
          payload: { recId: subscription.interRecId, source: 'reconcile' },
        });
        await enqueueDelivery(event.id, 'subscription.authorized', {
          subscriptionId: subscription.id,
          externalUserId: subscription.externalUserId,
        });
      } else if (recurrence.status === 'DENIED') {
        assertSubscriptionTransition(subscription.status, 'AUTH_DENIED');
        await updateSubscriptionStatus(subscription.id, 'AUTH_DENIED');

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

export async function reconcile(): Promise<number> {
  const cyclesChecked = await reconcileCycles();
  const subscriptionsChecked = await reconcilePendingAuth();
  return cyclesChecked + subscriptionsChecked;
}
