export type SubscriptionStatus =
  | 'PENDING_AUTH'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'SUSPENDED'
  | 'CANCELED'
  | 'AUTH_DENIED';

export type CycleStatus =
  | 'SCHEDULED'
  | 'SENT'
  | 'PAID'
  | 'FAILED'
  | 'RETRYING'
  | 'ABANDONED'
  | 'CANCELED';

export interface Subscription {
  id: string;
  externalUserId: string;
  planCode: string;
  amount: string;
  intervalMonths: number;
  status: SubscriptionStatus;
  interRecId: string | null;
  interSolicrecId: string | null;
  debtorTaxId: string;
  debtorName: string;
  nextDueDate: string | null;
  authorizedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Cycle {
  id: string;
  subscriptionId: string;
  seq: number;
  dueDate: string;
  amount: string;
  status: CycleStatus;
  interTxid: string | null;
  endToEndId: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CycleAttempt {
  id: string;
  cycleId: string;
  attemptNumber: number;
  scheduledFor: string;
  sentAt: string | null;
  outcome: string | null;
  failureReason: string | null;
  createdAt: string;
}
