import { AppError } from '../shared/errors';
import * as inter from '../providers/inter/pixAutomatico';
import {
  findSubscriptionById,
  insertSubscription,
  updateSubscriptionStatus,
} from '../repositories/subscriptions';
import {
  findCurrentCycle,
  listCyclesBySubscription,
  updateCycleStatus,
} from '../repositories/cycles';
import { insertEvent } from '../repositories/events';
import { assertCycleTransition, assertSubscriptionTransition } from './stateMachine';
import { businessToday, canCancelCycle } from './schedule';
import { Cycle, Subscription } from './types';

export interface CreateSubscriptionInput {
  externalUserId: string;
  planCode: string;
  amount: string;
  intervalMonths: number;
  firstDueDate: string;
  debtor: { taxId: string; name: string };
}

export interface CreateSubscriptionResult {
  subscription: Subscription;
  authorization: { pixCopyPaste?: string; url?: string };
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<CreateSubscriptionResult> {
  const subscription = await insertSubscription({
    externalUserId: input.externalUserId,
    planCode: input.planCode,
    amount: input.amount,
    intervalMonths: input.intervalMonths,
    debtorTaxId: input.debtor.taxId,
    debtorName: input.debtor.name,
    nextDueDate: input.firstDueDate,
  });

  const recurrence = await inter.createRecurrence({
    amount: input.amount,
    intervalMonths: input.intervalMonths,
    firstDueDate: input.firstDueDate,
    debtorTaxId: input.debtor.taxId,
    debtorName: input.debtor.name,
    planCode: input.planCode,
  });

  const authorization = await inter.requestAuthorization(recurrence.recId, {
    payerRequest: input.planCode,
  });

  assertSubscriptionTransition(subscription.status, 'PENDING_AUTH');

  const updated = await updateSubscriptionStatus(subscription.id, 'PENDING_AUTH', {
    interRecId: recurrence.recId,
    interSolicrecId: authorization.solicrecId,
  });

  await insertEvent({
    subscriptionId: updated.id,
    type: 'subscription.created',
    payload: { recId: recurrence.recId, planCode: input.planCode },
  });

  return {
    subscription: updated,
    authorization: {
      pixCopyPaste: authorization.pixCopyPaste,
      url: authorization.url,
    },
  };
}

export async function getSubscriptionDetail(
  id: string,
): Promise<{ subscription: Subscription; cycles: Cycle[] }> {
  const subscription = await findSubscriptionById(id);

  if (!subscription) {
    throw AppError.notFound('Assinatura');
  }

  const cycles = await listCyclesBySubscription(id);
  return { subscription, cycles };
}

export async function cancelSubscription(
  id: string,
  today: string = businessToday(),
): Promise<{ subscription: Subscription; pendingCycle: Cycle | null }> {
  const subscription = await findSubscriptionById(id);

  if (!subscription) {
    throw AppError.notFound('Assinatura');
  }

  if (subscription.status === 'CANCELED') {
    throw AppError.conflict('INVALID_TRANSITION', 'Assinatura ja esta cancelada.');
  }

  assertSubscriptionTransition(subscription.status, 'CANCELED');

  const current = await findCurrentCycle(id);
  let pendingCycle: Cycle | null = null;

  if (current) {
    if (current.status === 'FAILED' || current.status === 'RETRYING') {
      pendingCycle = current;
    } else if (
      ['SCHEDULED', 'SENT'].includes(current.status) &&
      canCancelCycle(current.dueDate, today)
    ) {
      assertCycleTransition(current.status, 'CANCELED');
      await updateCycleStatus(current.id, 'CANCELED');
    } else if (['SCHEDULED', 'SENT'].includes(current.status)) {
      pendingCycle = current;
    }
  }

  if (subscription.interRecId) {
    await inter.cancelRecurrence(subscription.interRecId);
  }

  const updated = await updateSubscriptionStatus(id, 'CANCELED', {
    canceledAt: new Date().toISOString(),
  });

  await insertEvent({
    subscriptionId: id,
    type: 'subscription.canceled',
    payload: { pendingCycleId: pendingCycle?.id ?? null },
  });

  return { subscription: updated, pendingCycle };
}
