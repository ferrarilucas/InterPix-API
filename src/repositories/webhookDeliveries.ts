import { query } from '../shared/db';

export interface PendingDelivery {
  id: string;
  eventId: string;
  targetUrl: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function insertDelivery(input: {
  eventId: string;
  targetUrl: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO webhook_deliveries (event_id, target_url, payload, next_retry_at)
     VALUES ($1, $2, $3, now())`,
    [input.eventId, input.targetUrl, JSON.stringify(input.payload)],
  );
}

export async function listDueDeliveries(limit: number): Promise<PendingDelivery[]> {
  const rows = await query<{
    id: string;
    event_id: string;
    target_url: string;
    payload: Record<string, unknown>;
    attempts: number;
  }>(
    `SELECT id::text AS id, event_id::text AS event_id, target_url, payload, attempts
     FROM webhook_deliveries
     WHERE status = 'PENDING' AND (next_retry_at IS NULL OR next_retry_at <= now())
     ORDER BY id
     LIMIT $1`,
    [limit],
  );

  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    targetUrl: row.target_url,
    payload: row.payload,
    attempts: row.attempts,
  }));
}

export async function markDelivered(id: string): Promise<void> {
  await query(
    `UPDATE webhook_deliveries
     SET status = 'DELIVERED', delivered_at = now(), attempts = attempts + 1, last_error = NULL
     WHERE id = $1`,
    [id],
  );
}

export async function markRetry(
  id: string,
  error: string,
  delayMinutes: number,
): Promise<void> {
  await query(
    `UPDATE webhook_deliveries
     SET attempts = attempts + 1,
         last_error = $2,
         next_retry_at = now() + ($3 || ' minutes')::interval
     WHERE id = $1`,
    [id, error, String(delayMinutes)],
  );
}

export async function markFailed(id: string, error: string): Promise<void> {
  await query(
    `UPDATE webhook_deliveries
     SET status = 'FAILED', attempts = attempts + 1, last_error = $2, next_retry_at = NULL
     WHERE id = $1`,
    [id, error],
  );
}
