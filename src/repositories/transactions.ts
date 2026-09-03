import { query } from '../shared/db';
import { CreateStoredTransaction, StoredTransaction, TransactionStatus } from '../types/transactions';

interface TransactionRow {
  id: string;
  txid: string;
  internal_id: string;
  tax_id: string | null;
  status: TransactionStatus;
  callback_url: string | null;
  amount: string;
  pix_copy_paste: string | null;
  created_at: string;
  updated_at: string;
}

function toDomain(row: TransactionRow): StoredTransaction {
  return {
    id: row.id,
    txid: row.txid,
    internalId: row.internal_id,
    taxId: row.tax_id ?? undefined,
    status: row.status,
    callbackUrl: row.callback_url ?? undefined,
    amount: row.amount,
    pixCopyPaste: row.pix_copy_paste ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertTransaction(payload: CreateStoredTransaction): Promise<StoredTransaction> {
  const rows = await query<TransactionRow>(
    `INSERT INTO transactions
       (txid, internal_id, tax_id, status, callback_url, amount, pix_copy_paste)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      payload.txid,
      payload.internalId,
      payload.taxId ?? null,
      payload.status,
      payload.callbackUrl ?? null,
      payload.amount,
      payload.pixCopyPaste ?? null,
    ],
  );
  return toDomain(rows[0]);
}

export async function updateTransactionStatus(txid: string, status: TransactionStatus): Promise<void> {
  await query(
    `UPDATE transactions SET status = $2, updated_at = now() WHERE txid = $1`,
    [txid, status],
  );
}

export async function markTransactionCompleted(txid: string): Promise<void> {
  await updateTransactionStatus(txid, 'COMPLETED');
}

export async function updateTransactionTaxId(txid: string, taxId: string): Promise<void> {
  await query(
    `UPDATE transactions SET tax_id = $2, updated_at = now() WHERE txid = $1`,
    [txid, taxId],
  );
}

export async function listRecentIncompleteTransactions(sinceIso: string): Promise<StoredTransaction[]> {
  const rows = await query<TransactionRow>(
    `SELECT * FROM transactions
     WHERE status = $1 AND created_at >= $2
     ORDER BY created_at DESC`,
    ['ACTIVE', sinceIso],
  );
  return rows.map(toDomain);
}
