import * as inter from '../providers/inter/pixAutomatico';
import { logger } from '../shared/logger';
import {
  findCycleByTxid,
  markAttemptOutcome,
  countCycleAttempts,
  updateCycleStatus,
} from '../repositories/cycles';
import {
  findSubscriptionById,
  findSubscriptionByRecId,
  updateSubscriptionStatus,
} from '../repositories/subscriptions';
import { insertEvent } from '../repositories/events';
import { insertReceipt, markReceiptProcessed } from '../repositories/webhookReceipts';
import { assertCycleTransition, assertSubscriptionTransition } from './stateMachine';
import { enqueueDelivery } from './webhookDispatcher';

export interface InterWebhookPayload {
  txid?: string;
  idRec?: string;
  eventId?: string;
}

function dedupeKeyFor(payload: InterWebhookPayload): string {
  if (payload.eventId) {
    return `evt:${payload.eventId}`;
  }
  return `raw:${JSON.stringify(payload)}`;
}

async function processCharge(txid: string): Promise<void> {
  const cycle = await findCycleByTxid(txid);

  if (!cycle) {
    logger.warn('webhook para txid desconhecido', { txid });
    return;
  }

  const charge = await inter.getChargeByTxid(txid);

  if (charge.status === 'PAID') {
    assertCycleTransition(cycle.status, 'PAID');
    await updateCycleStatus(cycle.id, 'PAID', {
      endToEndId: charge.endToEndId,
      paidAt: charge.paidAt ?? new Date().toISOString(),
    });

    const subscription = await findSubscriptionById(cycle.subscriptionId);
    if (subscription && subscription.status === 'PAST_DUE') {
      await updateSubscriptionStatus(subscription.id, 'ACTIVE');
    }

    const event = await insertEvent({
      subscriptionId: cycle.subscriptionId,
      cycleId: cycle.id,
      type: 'cycle.paid',
      payload: { txid, endToEndId: charge.endToEndId, amount: cycle.amount, seq: cycle.seq },
    });
    await enqueueDelivery(event.id, 'cycle.paid', {
      subscriptionId: cycle.subscriptionId,
      cycleSeq: cycle.seq,
      amount: cycle.amount,
      paidAt: charge.paidAt,
    });
    return;
  }

  if (charge.status === 'FAILED' && (cycle.status === 'SENT' || cycle.status === 'RETRYING')) {
    assertCycleTransition(cycle.status, 'FAILED');
    await updateCycleStatus(cycle.id, 'FAILED');

    const attempts = await countCycleAttempts(cycle.id);
    if (attempts > 0) {
      await markAttemptOutcome(cycle.id, attempts, 'FAILED', charge.failureReason);
    }

    const event = await insertEvent({
      subscriptionId: cycle.subscriptionId,
      cycleId: cycle.id,
      type: 'cycle.failed',
      payload: { txid, reason: charge.failureReason, seq: cycle.seq },
    });
    await enqueueDelivery(event.id, 'cycle.failed', {
      subscriptionId: cycle.subscriptionId,
      cycleSeq: cycle.seq,
      reason: charge.failureReason,
    });
  }
}

async function processRecurrence(recId: string): Promise<void> {
  const subscription = await findSubscriptionByRecId(recId);

  if (!subscription) {
    logger.warn('webhook para rec desconhecida', { recId });
    return;
  }

  const recurrence = await inter.getRecurrence(recId);

  if (recurrence.status === 'APPROVED') {
    assertSubscriptionTransition(subscription.status, 'ACTIVE');
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', {
      authorizedAt: new Date().toISOString(),
    });

    const event = await insertEvent({
      subscriptionId: subscription.id,
      type: 'subscription.authorized',
      payload: { recId },
    });
    await enqueueDelivery(event.id, 'subscription.authorized', {
      subscriptionId: subscription.id,
      externalUserId: subscription.externalUserId,
    });
    return;
  }

  if (recurrence.status === 'DENIED' && subscription.status === 'PENDING_AUTH') {
    assertSubscriptionTransition(subscription.status, 'AUTH_DENIED');
    await updateSubscriptionStatus(subscription.id, 'AUTH_DENIED');

    const event = await insertEvent({
      subscriptionId: subscription.id,
      type: 'subscription.auth_denied',
      payload: { recId, status: recurrence.rawStatus },
    });
    await enqueueDelivery(event.id, 'subscription.auth_denied', {
      subscriptionId: subscription.id,
      externalUserId: subscription.externalUserId,
    });
  }
}

export async function processInterEvent(payload: InterWebhookPayload): Promise<void> {
  const receipt = await insertReceipt(dedupeKeyFor(payload), payload);

  if (!receipt.isNew) {
    return;
  }

  if (payload.txid) {
    await processCharge(payload.txid);
  } else if (payload.idRec) {
    await processRecurrence(payload.idRec);
  }

  await markReceiptProcessed(receipt.id);
}
