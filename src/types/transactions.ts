export type TransactionStatus = 'ACTIVE' | 'COMPLETED' | 'REMOVED_BY_USER' | 'REMOVED_BY_PSP';

export interface StoredTransaction {
  id: string;
  txid: string;
  internalId: string;
  taxId?: string;
  status: TransactionStatus;
  callbackUrl?: string;
  amount: string;
  pixCopyPaste?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStoredTransaction {
  txid: string;
  internalId: string;
  taxId?: string;
  status: TransactionStatus;
  callbackUrl?: string;
  amount: string;
  pixCopyPaste?: string;
}


