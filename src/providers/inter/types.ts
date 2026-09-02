export interface CreateRecurrenceInput {
  amount: string;
  intervalMonths: number;
  firstDueDate: string;
  debtorTaxId: string;
  debtorName: string;
  planCode: string;
}

export type RecurrenceStatus =
  | 'CREATED'
  | 'PENDING_AUTH'
  | 'APPROVED'
  | 'DENIED'
  | 'CANCELED'
  | 'UNKNOWN';

export interface RecurrenceResponse {
  recId: string;
  status: RecurrenceStatus;
  rawStatus: string;
  solicrecId?: string;
  pixCopyPaste?: string;
  url?: string;
}

export interface CreateChargeInput {
  recId: string;
  txid: string;
  dueDate: string;
  amount: string;
}

export type ChargeStatus = 'CREATED' | 'PAID' | 'FAILED' | 'CANCELED' | 'UNKNOWN';

export interface ChargeResponse {
  txid: string;
  status: ChargeStatus;
  rawStatus: string;
  endToEndId?: string;
  paidAt?: string;
  failureReason?: string;
}
