const MIN_LEAD_DAYS = 2;
const MAX_LEAD_DAYS = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toUtc(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / MS_PER_DAY);
}

export function isWithinSendWindow(dueDate: string, sendDate: string): boolean {
  const lead = daysBetween(sendDate, dueDate);
  return lead >= MIN_LEAD_DAYS && lead <= MAX_LEAD_DAYS;
}

export function shouldSendCharge(dueDate: string, today: string, leadDays: number): boolean {
  const lead = daysBetween(today, dueDate);
  return lead <= leadDays && isWithinSendWindow(dueDate, today);
}

export function nextRetryDate(
  dueDate: string,
  today: string,
  windowDays: number,
): string | null {
  const target = toUtc(today) + MS_PER_DAY;
  const limit = toUtc(dueDate) + windowDays * MS_PER_DAY;

  if (target > limit) {
    return null;
  }

  return toIso(target);
}

export function canCancelCycle(dueDate: string, today: string): boolean {
  return daysBetween(today, dueDate) >= 1;
}

export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return toIso(target.getTime());
}
