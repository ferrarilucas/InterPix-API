import { query } from '../shared/db';
import { Subscription, SubscriptionStatus } from '../domain/types';

interface SubscriptionRow {
  id: string;
  external_user_id: string;
  plan_code: string;
  amount: string;
  interval_months: number;
  status: SubscriptionStatus;
  inter_rec_id: string | null;
  inter_solicrec_id: string | null;
  debtor_tax_id: string;
  debtor_name: string;
  next_due_date: string | Date | null;
  authorized_at: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewSubscription {
  externalUserId: string;
  planCode: string;
  amount: string;
  intervalMonths: number;
  debtorTaxId: string;
  debtorName: string;
  nextDueDate: string;
}

export interface SubscriptionPatch {
  interRecId?: string;
  interSolicrecId?: string;
  nextDueDate?: string;
  authorizedAt?: string;
  canceledAt?: string;
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

function toDomain(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    externalUserId: row.external_user_id,
    planCode: row.plan_code,
    amount: row.amount,
    intervalMonths: row.interval_months,
    status: row.status,
    interRecId: row.inter_rec_id,
    interSolicrecId: row.inter_solicrec_id,
    debtorTaxId: row.debtor_tax_id,
    debtorName: row.debtor_name,
    nextDueDate: row.next_due_date ? toDateString(row.next_due_date) : null,
    authorizedAt: row.authorized_at,
    canceledAt: row.canceled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertSubscription(input: NewSubscription): Promise<Subscription> {
  const rows = await query<SubscriptionRow>(
    `INSERT INTO subscriptions
       (external_user_id, plan_code, amount, interval_months, debtor_tax_id, debtor_name, next_due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.externalUserId,
      input.planCode,
      input.amount,
      input.intervalMonths,
      input.debtorTaxId,
      input.debtorName,
      input.nextDueDate,
    ],
  );
  return toDomain(rows[0]);
}

export async function findSubscriptionById(id: string): Promise<Subscription | null> {
  const rows = await query<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = $1', [id]);
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function findSubscriptionByRecId(recId: string): Promise<Subscription | null> {
  const rows = await query<SubscriptionRow>(
    'SELECT * FROM subscriptions WHERE inter_rec_id = $1',
    [recId],
  );
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function updateSubscriptionStatus(
  id: string,
  status: SubscriptionStatus,
  patch: SubscriptionPatch = {},
): Promise<Subscription> {
  const rows = await query<SubscriptionRow>(
    `UPDATE subscriptions SET
       status = $2,
       inter_rec_id = COALESCE($3, inter_rec_id),
       inter_solicrec_id = COALESCE($4, inter_solicrec_id),
       next_due_date = COALESCE($5, next_due_date),
       authorized_at = COALESCE($6, authorized_at),
       canceled_at = COALESCE($7, canceled_at),
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      status,
      patch.interRecId ?? null,
      patch.interSolicrecId ?? null,
      patch.nextDueDate ?? null,
      patch.authorizedAt ?? null,
      patch.canceledAt ?? null,
    ],
  );
  return toDomain(rows[0]);
}

export async function updateSubscriptionStatusIf(
  id: string,
  expectedStatus: SubscriptionStatus,
  status: SubscriptionStatus,
  patch: SubscriptionPatch = {},
): Promise<Subscription | null> {
  const rows = await query<SubscriptionRow>(
    `UPDATE subscriptions SET
       status = $3,
       inter_rec_id = COALESCE($4, inter_rec_id),
       inter_solicrec_id = COALESCE($5, inter_solicrec_id),
       next_due_date = COALESCE($6, next_due_date),
       authorized_at = COALESCE($7, authorized_at),
       canceled_at = COALESCE($8, canceled_at),
       updated_at = now()
     WHERE id = $1 AND status = $2
     RETURNING *`,
    [
      id,
      expectedStatus,
      status,
      patch.interRecId ?? null,
      patch.interSolicrecId ?? null,
      patch.nextDueDate ?? null,
      patch.authorizedAt ?? null,
      patch.canceledAt ?? null,
    ],
  );
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function listActiveSubscriptionsDueFor(date: string): Promise<Subscription[]> {
  const rows = await query<SubscriptionRow>(
    `SELECT * FROM subscriptions
     WHERE status = 'ACTIVE' AND next_due_date IS NOT NULL AND next_due_date <= $1
     ORDER BY next_due_date`,
    [date],
  );
  return rows.map(toDomain);
}

export async function listPendingAuthWithRecId(): Promise<Subscription[]> {
  const rows = await query<SubscriptionRow>(
    `SELECT * FROM subscriptions
     WHERE status = 'PENDING_AUTH' AND inter_rec_id IS NOT NULL
     ORDER BY created_at`,
  );
  return rows.map(toDomain);
}
