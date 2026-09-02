import { query } from '../shared/db';

export interface StoredEvent {
  id: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export async function insertEvent(input: {
  subscriptionId?: string;
  cycleId?: string;
  type: string;
  payload: unknown;
}): Promise<{ id: string }> {
  const rows = await query<{ id: string }>(
    `INSERT INTO events (subscription_id, cycle_id, type, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING id::text AS id`,
    [input.subscriptionId ?? null, input.cycleId ?? null, input.type, JSON.stringify(input.payload)],
  );
  return rows[0];
}

export async function listEventsBySubscription(subscriptionId: string): Promise<StoredEvent[]> {
  const rows = await query<{
    id: string;
    type: string;
    payload: unknown;
    created_at: string;
  }>(
    `SELECT id::text AS id, type, payload, created_at
     FROM events WHERE subscription_id = $1 ORDER BY id`,
    [subscriptionId],
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}
