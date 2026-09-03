import { PoolClient } from 'pg';
import { query } from '../shared/db';
import { Cycle, CycleAttempt, CycleStatus } from '../domain/types';

interface CycleRow {
  id: string;
  subscription_id: string;
  seq: number;
  due_date: string | Date;
  amount: string;
  status: CycleStatus;
  inter_txid: string | null;
  end_to_end_id: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  cycle_id: string;
  attempt_number: number;
  scheduled_for: string | Date;
  sent_at: string | null;
  outcome: string | null;
  failure_reason: string | null;
  created_at: string;
}

function toDateString(value: string | Date): string {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function toCycle(row: CycleRow): Cycle {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    seq: row.seq,
    dueDate: toDateString(row.due_date),
    amount: row.amount,
    status: row.status,
    interTxid: row.inter_txid,
    endToEndId: row.end_to_end_id,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAttempt(row: AttemptRow): CycleAttempt {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    attemptNumber: row.attempt_number,
    scheduledFor: toDateString(row.scheduled_for),
    sentAt: row.sent_at,
    outcome: row.outcome,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}

export async function insertCycle(input: {
  subscriptionId: string;
  seq: number;
  dueDate: string;
  amount: string;
}): Promise<Cycle> {
  const rows = await query<CycleRow>(
    `INSERT INTO cycles (subscription_id, seq, due_date, amount)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.subscriptionId, input.seq, input.dueDate, input.amount],
  );
  return toCycle(rows[0]);
}

export async function findCycleById(id: string): Promise<Cycle | null> {
  const rows = await query<CycleRow>('SELECT * FROM cycles WHERE id = $1', [id]);
  return rows[0] ? toCycle(rows[0]) : null;
}

export async function findCycleByTxid(txid: string): Promise<Cycle | null> {
  const rows = await query<CycleRow>('SELECT * FROM cycles WHERE inter_txid = $1', [txid]);
  return rows[0] ? toCycle(rows[0]) : null;
}

export async function findCurrentCycle(subscriptionId: string): Promise<Cycle | null> {
  const rows = await query<CycleRow>(
    `SELECT * FROM cycles WHERE subscription_id = $1 ORDER BY seq DESC LIMIT 1`,
    [subscriptionId],
  );
  return rows[0] ? toCycle(rows[0]) : null;
}

export async function listCyclesBySubscription(subscriptionId: string): Promise<Cycle[]> {
  const rows = await query<CycleRow>(
    'SELECT * FROM cycles WHERE subscription_id = $1 ORDER BY seq',
    [subscriptionId],
  );
  return rows.map(toCycle);
}

export async function listCyclesByStatus(statuses: CycleStatus[]): Promise<Cycle[]> {
  const rows = await query<CycleRow>(
    'SELECT * FROM cycles WHERE status = ANY($1::cycle_status[]) ORDER BY due_date',
    [statuses],
  );
  return rows.map(toCycle);
}

export interface CyclePatch {
  interTxid?: string;
  endToEndId?: string;
  paidAt?: string;
}

export async function updateCycleStatus(
  id: string,
  status: CycleStatus,
  patch: CyclePatch = {},
  client?: PoolClient,
): Promise<Cycle> {
  const rows = await query<CycleRow>(
    `UPDATE cycles SET
       status = $2,
       inter_txid = COALESCE($3, inter_txid),
       end_to_end_id = COALESCE($4, end_to_end_id),
       paid_at = COALESCE($5, paid_at),
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, status, patch.interTxid ?? null, patch.endToEndId ?? null, patch.paidAt ?? null],
    client,
  );
  return toCycle(rows[0]);
}

export async function patchCycleTxid(
  id: string,
  txid: string,
  client?: PoolClient,
): Promise<Cycle | null> {
  const rows = await query<CycleRow>(
    `UPDATE cycles SET
       inter_txid = $2,
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, txid],
    client,
  );
  return rows[0] ? toCycle(rows[0]) : null;
}

export async function updateCycleStatusIf(
  id: string,
  expectedStatus: CycleStatus,
  status: CycleStatus,
  patch: CyclePatch = {},
  client?: PoolClient,
): Promise<Cycle | null> {
  const rows = await query<CycleRow>(
    `UPDATE cycles SET
       status = $3,
       inter_txid = COALESCE($4, inter_txid),
       end_to_end_id = COALESCE($5, end_to_end_id),
       paid_at = COALESCE($6, paid_at),
       updated_at = now()
     WHERE id = $1 AND status = $2
     RETURNING *`,
    [
      id,
      expectedStatus,
      status,
      patch.interTxid ?? null,
      patch.endToEndId ?? null,
      patch.paidAt ?? null,
    ],
    client,
  );
  return rows[0] ? toCycle(rows[0]) : null;
}

export async function listCyclesByStatusInRange(
  statuses: CycleStatus[],
  fromDate: string,
  toDate: string,
): Promise<Cycle[]> {
  const rows = await query<CycleRow>(
    `SELECT * FROM cycles
     WHERE status = ANY($1::cycle_status[]) AND due_date >= $2 AND due_date <= $3
     ORDER BY due_date`,
    [statuses, fromDate, toDate],
  );
  return rows.map(toCycle);
}

export async function listCyclesByStatusBefore(
  statuses: CycleStatus[],
  beforeDate: string,
): Promise<Cycle[]> {
  const rows = await query<CycleRow>(
    `SELECT * FROM cycles
     WHERE status = ANY($1::cycle_status[]) AND due_date < $2
     ORDER BY due_date`,
    [statuses, beforeDate],
  );
  return rows.map(toCycle);
}

export async function findLatestCycleAttempt(cycleId: string): Promise<CycleAttempt | null> {
  const rows = await query<AttemptRow>(
    `SELECT * FROM cycle_attempts
     WHERE cycle_id = $1
     ORDER BY attempt_number DESC
     LIMIT 1`,
    [cycleId],
  );
  return rows[0] ? toAttempt(rows[0]) : null;
}

export async function insertCycleAttempt(input: {
  cycleId: string;
  attemptNumber: number;
  scheduledFor: string;
}): Promise<CycleAttempt> {
  const rows = await query<AttemptRow>(
    `INSERT INTO cycle_attempts (cycle_id, attempt_number, scheduled_for, sent_at)
     VALUES ($1, $2, $3, now())
     RETURNING *`,
    [input.cycleId, input.attemptNumber, input.scheduledFor],
  );
  return toAttempt(rows[0]);
}

export async function countCycleAttempts(cycleId: string): Promise<number> {
  const rows = await query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM cycle_attempts WHERE cycle_id = $1',
    [cycleId],
  );
  return Number(rows[0].count);
}

export async function markAttemptOutcome(
  cycleId: string,
  attemptNumber: number,
  outcome: string,
  failureReason?: string,
  client?: PoolClient,
): Promise<void> {
  await query(
    `UPDATE cycle_attempts SET outcome = $3, failure_reason = $4
     WHERE cycle_id = $1 AND attempt_number = $2`,
    [cycleId, attemptNumber, outcome, failureReason ?? null],
    client,
  );
}
