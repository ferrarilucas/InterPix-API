import { query } from '../shared/db';

export async function insertReceipt(
  dedupeKey: string,
  payload: unknown,
): Promise<{ id: string; isNew: boolean }> {
  const rows = await query<{ id: string }>(
    `INSERT INTO inter_webhook_receipts (dedupe_key, raw_payload)
     VALUES ($1, $2)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id::text AS id`,
    [dedupeKey, JSON.stringify(payload)],
  );

  if (rows[0]) {
    return { id: rows[0].id, isNew: true };
  }

  const existing = await query<{ id: string }>(
    'SELECT id::text AS id FROM inter_webhook_receipts WHERE dedupe_key = $1',
    [dedupeKey],
  );
  return { id: existing[0].id, isNew: false };
}

export async function markReceiptProcessed(id: string): Promise<void> {
  await query('UPDATE inter_webhook_receipts SET processed_at = now() WHERE id = $1', [id]);
}
