import { AppError } from '../shared/errors';
import { CycleStatus, SubscriptionStatus } from './types';

const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  PENDING_AUTH: ['ACTIVE', 'AUTH_DENIED', 'CANCELED'],
  ACTIVE: ['PAST_DUE', 'CANCELED'],
  PAST_DUE: ['ACTIVE', 'SUSPENDED', 'CANCELED'],
  SUSPENDED: ['ACTIVE', 'CANCELED'],
  CANCELED: [],
  AUTH_DENIED: [],
};

const CYCLE_TRANSITIONS: Record<CycleStatus, CycleStatus[]> = {
  SCHEDULED: ['SENT', 'CANCELED'],
  SENT: ['PAID', 'FAILED', 'CANCELED'],
  PAID: [],
  FAILED: ['RETRYING', 'ABANDONED'],
  RETRYING: ['PAID', 'FAILED', 'ABANDONED'],
  ABANDONED: [],
  CANCELED: [],
};

function assert<T extends string>(
  allowed: Record<T, T[]>,
  entity: string,
  from: T,
  to: T,
): void {
  if (from === to) {
    return;
  }

  if (!allowed[from].includes(to)) {
    throw AppError.conflict(
      'INVALID_TRANSITION',
      `Transicao de ${entity} nao permitida: ${from} -> ${to}.`,
    );
  }
}

export function assertSubscriptionTransition(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): void {
  assert(SUBSCRIPTION_TRANSITIONS, 'assinatura', from, to);
}

export function assertCycleTransition(from: CycleStatus, to: CycleStatus): void {
  assert(CYCLE_TRANSITIONS, 'ciclo', from, to);
}
