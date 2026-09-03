import { ChargeResponse } from '../providers/inter/types';
import { withTransaction } from '../shared/db';
import {
  countCycleAttempts,
  markAttemptOutcome,
  updateCycleStatusIf,
} from '../repositories/cycles';
import { updateSubscriptionStatusIf } from '../repositories/subscriptions';
import { insertEvent } from '../repositories/events';
import { assertCycleTransition, assertSubscriptionTransition } from './stateMachine';
import { enqueueDelivery } from './webhookDispatcher';
import { Cycle } from './types';

export type ChargeOutcome = 'PAID' | 'FAILED' | null;

async function applyPaid(cycle: Cycle, charge: ChargeResponse): Promise<ChargeOutcome> {
  if (cycle.status === 'PAID') {
    return null;
  }

  assertCycleTransition(cycle.status, 'PAID');
  assertSubscriptionTransition('PAST_DUE', 'ACTIVE');

  const paidAt = charge.paidAt ?? new Date().toISOString();

  const applied = await withTransaction(async (client) => {
    const updated = await updateCycleStatusIf(
      cycle.id,
      cycle.status,
      'PAID',
      { endToEndId: charge.endToEndId, paidAt },
      client,
    );

    if (!updated) {
      return false;
    }

    await updateSubscriptionStatusIf(cycle.subscriptionId, 'PAST_DUE', 'ACTIVE', {}, client);

    const event = await insertEvent(
      {
        subscriptionId: cycle.subscriptionId,
        cycleId: cycle.id,
        type: 'cycle.paid',
        payload: {
          txid: cycle.interTxid,
          endToEndId: charge.endToEndId ?? null,
          amount: cycle.amount,
          seq: cycle.seq,
          paidAt,
        },
      },
      client,
    );

    await enqueueDelivery(
      event.id,
      'cycle.paid',
      {
        subscriptionId: cycle.subscriptionId,
        cycleSeq: cycle.seq,
        amount: cycle.amount,
        paidAt,
      },
      client,
    );

    return true;
  });

  return applied ? 'PAID' : null;
}

async function applyFailed(cycle: Cycle, charge: ChargeResponse): Promise<ChargeOutcome> {
  if (cycle.status !== 'SENT' && cycle.status !== 'RETRYING') {
    return null;
  }

  assertCycleTransition(cycle.status, 'FAILED');

  const attempts = await countCycleAttempts(cycle.id);

  const applied = await withTransaction(async (client) => {
    const updated = await updateCycleStatusIf(cycle.id, cycle.status, 'FAILED', {}, client);

    if (!updated) {
      return false;
    }

    if (attempts > 0) {
      await markAttemptOutcome(cycle.id, attempts, 'FAILED', charge.failureReason, client);
    }

    const event = await insertEvent(
      {
        subscriptionId: cycle.subscriptionId,
        cycleId: cycle.id,
        type: 'cycle.failed',
        payload: { txid: cycle.interTxid, reason: charge.failureReason ?? null, seq: cycle.seq },
      },
      client,
    );

    await enqueueDelivery(
      event.id,
      'cycle.failed',
      {
        subscriptionId: cycle.subscriptionId,
        cycleSeq: cycle.seq,
        reason: charge.failureReason ?? null,
      },
      client,
    );

    return true;
  });

  return applied ? 'FAILED' : null;
}

export async function applyChargeStatus(
  cycle: Cycle,
  charge: ChargeResponse,
): Promise<ChargeOutcome> {
  if (charge.status === 'PAID') {
    return applyPaid(cycle, charge);
  }

  if (charge.status === 'FAILED') {
    return applyFailed(cycle, charge);
  }

  return null;
}
