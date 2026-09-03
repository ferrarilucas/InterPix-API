import { query } from '../shared/db';

export interface ReceiptClaim {
  id: string;
  isNew: boolean;
  processable: boolean;
}

export async function insertReceipt(
  dedupeKey: string,
  payload: unknown,
): Promise<ReceiptClaim> {
  const rows = await query<{ id: string }>(
    `INSERT INTO inter_webhook_receipts (dedupe_key, raw_payload)
     VALUES ($1, $2)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id::text AS id`,
    [dedupeKey, JSON.stringify(payload)],
  );

  if (rows[0]) {
    return { id: rows[0].id, isNew: true, processable: true };
  }

  const existing = await query<{ id: string; processed_at: string | null }>(
    'SELECT id::text AS id, processed_at FROM inter_webhook_receipts WHERE dedupe_key = $1',
    [dedupeKey],
  );
  return {
    id: existing[0].id,
    isNew: false,
    processable: existing[0].processed_at === null,
  };
}

export async function markReceiptProcessed(id: string): Promise<void> {
  await query('UPDATE inter_webhook_receipts SET processed_at = now() WHERE id = $1', [id]);
}
