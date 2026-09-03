import { AppError } from '../shared/errors';
import { withTransaction } from '../shared/db';
import * as inter from '../providers/inter/pixAutomatico';
import { RecurrenceResponse } from '../providers/inter/types';
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
import { enqueueDelivery } from './webhookDispatcher';
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

async function denyAuthorization(
  subscription: Subscription,
  recId: string | undefined,
  error: unknown,
): Promise<void> {
  assertSubscriptionTransition(subscription.status, 'AUTH_DENIED');
  await updateSubscriptionStatus(
    subscription.id,
    'AUTH_DENIED',
    recId ? { interRecId: recId } : {},
  );
  await insertEvent({
    subscriptionId: subscription.id,
    type: 'subscription.auth_denied',
    payload: {
      reason: 'FALHA_AO_CRIAR_AUTORIZACAO',
      recId: recId ?? null,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

async function authorizeAtInter(
  subscription: Subscription,
  input: CreateSubscriptionInput,
): Promise<{ recurrence: RecurrenceResponse; authorization: RecurrenceResponse }> {
  let recId: string | undefined;

  try {
    const recurrence = await inter.createRecurrence({
      amount: input.amount,
      intervalMonths: input.intervalMonths,
      firstDueDate: input.firstDueDate,
      debtorTaxId: input.debtor.taxId,
      debtorName: input.debtor.name,
      planCode: input.planCode,
    });
    recId = recurrence.recId;

    const authorization = await inter.requestAuthorization(recurrence.recId, {
      payerRequest: input.planCode,
    });

    return { recurrence, authorization };
  } catch (error) {
    await denyAuthorization(subscription, recId, error);
    throw error;
  }
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

  const { recurrence, authorization } = await authorizeAtInter(subscription, input);

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
  let cycleToCancel: Cycle | null = null;

  if (current) {
    if (current.status === 'FAILED' || current.status === 'RETRYING') {
      pendingCycle = current;
    } else if (
      ['SCHEDULED', 'SENT'].includes(current.status) &&
      canCancelCycle(current.dueDate, today)
    ) {
      assertCycleTransition(current.status, 'CANCELED');
      cycleToCancel = current;
    } else if (['SCHEDULED', 'SENT'].includes(current.status)) {
      pendingCycle = current;
    }
  }

  if (subscription.interRecId) {
    await inter.cancelRecurrence(subscription.interRecId);
  }

  const updated = await withTransaction(async (client) => {
    if (cycleToCancel) {
      await updateCycleStatus(cycleToCancel.id, 'CANCELED', {}, client);
    }

    const result = await updateSubscriptionStatus(
      id,
      'CANCELED',
      { canceledAt: new Date().toISOString() },
      client,
    );

    const event = await insertEvent(
      {
        subscriptionId: id,
        type: 'subscription.canceled',
        payload: { pendingCycleId: pendingCycle?.id ?? null },
      },
      client,
    );

    await enqueueDelivery(
      event.id,
      'subscription.canceled',
      {
        subscriptionId: id,
        externalUserId: subscription.externalUserId,
        pendingCycleSeq: pendingCycle?.seq ?? null,
      },
      client,
    );

    return result;
  });

  return { subscription: updated, pendingCycle };
}
