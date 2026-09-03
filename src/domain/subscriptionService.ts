import { AppError } from '../shared/errors';
import * as inter from '../providers/inter/pixAutomatico';
import {
  findSubscriptionById,
  insertSubscription,
  updateSubscriptionStatus,
} from '../repositories/subscriptions';
import { listCyclesBySubscription } from '../repositories/cycles';
import { insertEvent } from '../repositories/events';
import { assertSubscriptionTransition } from './stateMachine';
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
