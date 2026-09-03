import { createHash } from 'crypto';
import * as inter from '../providers/inter/pixAutomatico';
import { logger } from '../shared/logger';
import { findCycleByTxid } from '../repositories/cycles';
import {
  findSubscriptionByRecId,
  updateSubscriptionStatus,
} from '../repositories/subscriptions';
import { insertEvent } from '../repositories/events';
import { insertReceipt, markReceiptProcessed } from '../repositories/webhookReceipts';
import { assertSubscriptionTransition } from './stateMachine';
import { applyChargeStatus } from './chargeOutcome';
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
  return `raw:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

async function processCharge(txid: string): Promise<void> {
  const cycle = await findCycleByTxid(txid);

  if (!cycle) {
    logger.warn('webhook para txid desconhecido', { txid });
    return;
  }

  const charge = await inter.getChargeByTxid(txid);
  await applyChargeStatus(cycle, charge);
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

  if (!receipt.processable) {
    return;
  }

  if (payload.txid) {
    await processCharge(payload.txid);
  } else if (payload.idRec) {
    await processRecurrence(payload.idRec);
  }

  await markReceiptProcessed(receipt.id);
}
