import { insertSubscription } from '../repositories/subscriptions';
import { Subscription } from '../domain/types';

let counter = 0;

export async function createSubscription(
  overrides: Partial<Parameters<typeof insertSubscription>[0]> = {},
): Promise<Subscription> {
  counter += 1;
  return insertSubscription({
    externalUserId: `usr_${counter}`,
    planCode: 'mensal_29_90',
    amount: '29.90',
    intervalMonths: 1,
    debtorTaxId: '12345678901',
    debtorName: 'Fulano de Tal',
    nextDueDate: '2026-09-20',
    ...overrides,
  });
}
