/**
 * VTID-05101 — companion back-off (plan §B, sparring F3).
 *
 * "The scheduler reads only the ledger: last 3 `sent` rows with NULL
 * replied_at → every other day; last 7 → weekly; any reply resets."
 *
 * Pure function over a member's recent ledger rows — no chat_messages scan.
 * Only real sends count (`status = 'sent'`, a mode other than shadow); shadow
 * rows are what Vitana WOULD have written and never slow anyone down. The
 * unreplied streak is counted from the newest real send backwards and stops
 * at the first replied one, so a single reply resets it.
 */
import { daysBetween } from './moments';

export interface BackoffLedgerRow {
  local_date: string;
  mode: string;
  status?: string | null;
  replied_at?: string | null;
}

export const BACKOFF_EVERY_OTHER_DAY_AFTER = 3;
export const BACKOFF_WEEKLY_AFTER = 7;

export type BackoffLevel = 'none' | 'every_other_day' | 'weekly';

export interface BackoffDecision {
  allow: boolean;
  level: BackoffLevel;
  /** Consecutive newest real sends without a reply. */
  unreplied: number;
  /** Local date of the newest real send before today, if any. */
  lastSentDate: string | null;
}

export function isRealSend(r: BackoffLedgerRow): boolean {
  return r.mode !== 'shadow' && r.status === 'sent';
}

export function backoffDecision(rows: BackoffLedgerRow[], localDate: string): BackoffDecision {
  const sent = rows
    .filter((r) => isRealSend(r) && r.local_date < localDate)
    .sort((a, b) => (a.local_date < b.local_date ? 1 : a.local_date > b.local_date ? -1 : 0));
  let unreplied = 0;
  for (const r of sent) {
    if (r.replied_at) break; // any reply resets
    unreplied++;
  }
  const lastSentDate = sent[0]?.local_date ?? null;
  const level: BackoffLevel = unreplied >= BACKOFF_WEEKLY_AFTER
    ? 'weekly'
    : unreplied >= BACKOFF_EVERY_OTHER_DAY_AFTER ? 'every_other_day' : 'none';
  if (level === 'none' || !lastSentDate) return { allow: true, level, unreplied, lastSentDate };
  const gap = daysBetween(lastSentDate, localDate);
  const needed = level === 'weekly' ? 7 : 2;
  return { allow: gap >= needed, level, unreplied, lastSentDate };
}
