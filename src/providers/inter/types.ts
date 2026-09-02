export interface CreateRecurrenceInput {
  amount: string;
  intervalMonths: number;
  firstDueDate: string;
  debtorTaxId: string;
  debtorName: string;
  planCode: string;
}

export interface RecurrenceResponse {
  recId: string;
  status: string;
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

export interface ChargeResponse {
  txid: string;
  status: string;
  endToEndId?: string;
  paidAt?: string;
  failureReason?: string;
}
