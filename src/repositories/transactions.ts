import { getSupabaseClient } from '../shared/supabase';
import { CreateStoredTransaction, StoredTransaction, TransactionStatus } from '../types/transactions';
import 'dotenv/config';

const TABLE = process.env.SUPABASE_TRANSACTIONS_TABLE || 'transactions';

export async function insertTransaction(payload: CreateStoredTransaction): Promise<StoredTransaction> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      txid: payload.txid,
      internal_id: payload.internalId,
      tax_id: payload.taxId,
      status: payload.status,
      callback_url: payload.callbackUrl,
      amount: payload.amount,
      pix_copy_paste: payload.pixCopyPaste,
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return mapRowToStoredTransaction(data);
}

export async function updateTransactionStatus(txid: string, status: TransactionStatus): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from(TABLE)
    .update({ status })
    .eq('txid', txid);
  if (error) {
    throw new Error(error.message);
  }
}

export async function markTransactionCompleted(txid: string): Promise<void> {
  await updateTransactionStatus(txid, 'COMPLETED');
}

export async function updateTransactionTaxId(txid: string, taxId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from(TABLE)
    .update({ tax_id: taxId })
    .eq('txid', txid);
  if (error) {
    throw new Error(error.message);
  }
}

export async function listRecentIncompleteTransactions(sinceIso: string): Promise<StoredTransaction[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .in('status', ['ACTIVE'])
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map(mapRowToStoredTransaction);
}

type TransactionRow = {
  id: string;
  txid: string;
  internal_id: string;
  tax_id?: string | null;
  status: TransactionStatus;
  callback_url?: string | null;
  amount: string;
  pix_copy_paste?: string | null;
  created_at: string;
  updated_at: string;
};

function mapRowToStoredTransaction(row: TransactionRow): StoredTransaction {
  return {
    id: String(row.id),
    txid: String(row.txid),
    internalId: String(row.internal_id),
    taxId: row.tax_id ? String(row.tax_id) : undefined,
    status: row.status as TransactionStatus,
    callbackUrl: row.callback_url ? String(row.callback_url) : undefined,
    amount: String(row.amount),
    pixCopyPaste: row.pix_copy_paste ? String(row.pix_copy_paste) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}


