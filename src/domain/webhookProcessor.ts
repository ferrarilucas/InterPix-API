import { createHash } from 'crypto';
import * as inter from '../providers/inter/pixAutomatico';
import { Logger, logger } from '../shared/logger';
import { findCycleByTxid } from '../repositories/cycles';
import {
  findSubscriptionByRecId,
  updateSubscriptionStatusIf,
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

async function processCharge(txid: string, log: Logger): Promise<void> {
  const cycle = await findCycleByTxid(txid);

  if (!cycle) {
    log.warn('webhook para txid desconhecido', { txid });
    return;
  }

  const charge = await inter.getChargeByTxid(txid);
  log.info('cobranca consultada no inter pelo webhook', {
    txid,
    cycleId: cycle.id,
    cycleStatus: cycle.status,
    interStatus: charge.status,
    rawStatus: charge.rawStatus,
  });
  await applyChargeStatus(cycle, charge);
}

async function processRecurrence(recId: string, log: Logger): Promise<void> {
  const subscription = await findSubscriptionByRecId(recId);

  if (!subscription) {
    log.warn('webhook para rec desconhecida', { recId });
    return;
  }

  const recurrence = await inter.getRecurrence(recId);
  log.info('recorrencia consultada no inter pelo webhook', {
    recId,
    subscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    interStatus: recurrence.status,
    rawStatus: recurrence.rawStatus,
  });

  if (recurrence.status === 'APPROVED' && subscription.status === 'PENDING_AUTH') {
    assertSubscriptionTransition(subscription.status, 'ACTIVE');
    const updated = await updateSubscriptionStatusIf(subscription.id, 'PENDING_AUTH', 'ACTIVE', {
      authorizedAt: new Date().toISOString(),
    });

    if (!updated) {
      log.info('autorizacao ja aplicada por outro caminho', { recId, subscriptionId: subscription.id });
      return;
    }

    const event = await insertEvent({
      subscriptionId: subscription.id,
      type: 'subscription.authorized',
      payload: { recId },
    });
    await enqueueDelivery(event.id, 'subscription.authorized', {
      subscriptionId: subscription.id,
      externalUserId: subscription.externalUserId,
    });
    log.info('autorizacao aplicada pelo webhook', {
      recId,
      subscriptionId: subscription.id,
      eventId: event.id,
    });
    return;
  }

  if (recurrence.status === 'DENIED' && subscription.status === 'PENDING_AUTH') {
    assertSubscriptionTransition(subscription.status, 'AUTH_DENIED');
    const updated = await updateSubscriptionStatusIf(subscription.id, 'PENDING_AUTH', 'AUTH_DENIED');

    if (!updated) {
      log.info('negativa ja aplicada por outro caminho', { recId, subscriptionId: subscription.id });
      return;
    }

    log.info('negativa de autorizacao aplicada pelo webhook', {
      recId,
      subscriptionId: subscription.id,
      rawStatus: recurrence.rawStatus,
    });

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

export async function processInterEvent(
  payload: InterWebhookPayload,
  log: Logger = logger,
): Promise<void> {
  const receipt = await insertReceipt(dedupeKeyFor(payload), payload);

  if (!receipt.processable) {
    log.info('webhook do inter ja processado antes, ignorado', { receiptId: receipt.id });
    return;
  }

  if (payload.txid) {
    await processCharge(payload.txid, log);
  } else if (payload.idRec) {
    await processRecurrence(payload.idRec, log);
  }

  await markReceiptProcessed(receipt.id);
  log.info('webhook do inter processado', { receiptId: receipt.id });
}
