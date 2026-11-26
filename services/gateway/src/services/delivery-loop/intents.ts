/**
 * Delivery loop: intents. An intent is "this work should be done", recorded before it is done (`delivery.dispatch.requested`). It is
 * the seam between deciding and acting: a decision is recorded at L1, the action is taken only when the level allows it, so raising
 * the level later acts on what was already decided, and nothing is decided twice.
 *
 * The status of an intent comes only from the rows that followed it, so it survives restarts and is the same for every gateway task:
 *
 *   open      requested, not started, not failed for good, not expired: the drive phase may carry it out
 *   started   the executor took it (`delivery.dispatch.started`)
 *   failed    the last execution failed; the next try waits RETRY_SPACING_MS, and after MAX_DISPATCH_TRIES it is failed for good
 *   dead      failed for good, cancelled because its premise was gone, or older than INTENT_TTL_MS
 */
import type { LedgerEvent } from './facts';
import { INTENT_TTL_MS, K, MAX_DISPATCH_TRIES, RETRY_SPACING_MS, T } from './keys';
import { find, record, sinceMs, type Ctx } from './context';

export type IntentStatus = 'open' | 'started' | 'retry_wait' | 'dead';

export interface Intent {
  row: LedgerEvent;
  key: string;
  workKey: string;
  attempt: number;
  status: IntentStatus;
  /** Rows of outcome `failed` that followed this intent. */
  failures: number;
  startedAt: string | null;
}

/** Pure: the status of an intent from its own time, the time now and the outcome rows that followed it. */
export function intentStatus(i: { requestedAt: string; nowMs: number; started: LedgerEvent | null; failures: LedgerEvent[] }): IntentStatus {
  if (i.started) return 'started';
  if (i.failures.some((f) => f.metadata.permanent === true)) return 'dead';
  if (i.failures.length >= MAX_DISPATCH_TRIES) return 'dead';
  if (Date.parse(i.requestedAt) < i.nowMs - INTENT_TTL_MS) return 'dead';
  if (i.failures.length > 0) {
    const last = i.failures.map((f) => Date.parse(f.created_at)).sort((a, b) => b - a)[0];
    if (i.nowMs - last < RETRY_SPACING_MS) return 'retry_wait';
  }
  return 'open';
}

/** The intents of one unit of work, oldest first, each with its status. */
export async function intentsOf(ctx: Ctx, workKey: string): Promise<Intent[]> {
  const rows = (await find(ctx, T.requested, { work_key: workKey }, { limit: 50 })).sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const out: Intent[] = [];
  for (const row of rows) out.push(await withStatus(ctx, row));
  return out;
}

export async function withStatus(ctx: Ctx, row: LedgerEvent): Promise<Intent> {
  const key = String(row.metadata.intent_key ?? '');
  const startedRows = await find(ctx, T.started, { intent_key: key }, { limit: 1 });
  const failures = await find(ctx, T.failed, { intent_key: key }, { limit: 10 });
  return {
    row,
    key,
    workKey: String(row.metadata.work_key ?? ''),
    attempt: typeof row.metadata.attempt === 'number' ? row.metadata.attempt : 1,
    status: intentStatus({ requestedAt: row.created_at, nowMs: ctx.deps.now(), started: startedRows[0] ?? null, failures }),
    failures: failures.length,
    startedAt: startedRows[0]?.created_at ?? null,
  };
}

/**
 * Makes sure the work has an intent that can still be carried out, without duplicating one. Two kinds of work differ in what a started
 * intent means:
 *
 *   once    (`'once'`, an issue becomes a task): a started intent IS the work, done; it is returned and no other is made.
 *   attempt (`'attempt'`, a repair, a retry): a started intent is a FINISHED attempt, and the work may need another. Only an intent
 *           still open or waiting for a retry stands in for a new one.
 *
 * When none stands in, a new intent is recorded, numbered after the ones before it. Returns the intent and whether this call created it.
 */
export async function ensureIntent(
  ctx: Ctx,
  workKey: string,
  payload: Record<string, unknown>,
  message: string,
  mode: 'once' | 'attempt' = 'once',
): Promise<{ intent: Intent; created: boolean }> {
  const all = await intentsOf(ctx, workKey);
  const live = all.find((i) => (mode === 'once' ? i.status !== 'dead' : i.status === 'open' || i.status === 'retry_wait'));
  if (live) return { intent: live, created: false };

  const attempt = all.length + 1;
  const key = K.intent(workKey, attempt);
  const written = await record(ctx, {
    type: T.requested,
    status: 'info',
    message,
    payload: { ...payload, intent_key: key, work_key: workKey, attempt },
    key,
  });
  if (!written.duplicate) ctx.stats.intents += 1;
  const rows = await find(ctx, T.requested, { intent_key: key }, { limit: 1 });
  const row = rows[0] ?? { id: written.event_id ?? key, created_at: new Date(ctx.deps.now()).toISOString(), vtid: null, topic: T.requested, status: 'info', message, metadata: { ...payload, intent_key: key, work_key: workKey, attempt } };
  return { intent: await withStatus(ctx, row), created: !written.duplicate };
}

/** Every open intent of the last INTENT_TTL_MS, oldest first. The drive phase carries them out. */
export async function openIntents(ctx: Ctx, limit = 100): Promise<Intent[]> {
  const rows = (await find(ctx, T.requested, {}, { since: sinceMs(ctx, INTENT_TTL_MS), limit })).sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const out: Intent[] = [];
  for (const row of rows) {
    const i = await withStatus(ctx, row);
    if (i.status === 'open') out.push(i);
  }
  return out;
}
