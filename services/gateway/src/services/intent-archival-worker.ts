/**
 * VTID-01976: Intent match archival worker (P2-C).
 *
 * Calls the SQL fn archive_old_intent_matches() to move terminal-state
 * (closed | fulfilled | declined) matches older than N days from
 * intent_matches into intent_matches_archive. Idempotent — safe to call
 * repeatedly; the SQL fn ON CONFLICT DO NOTHINGs.
 *
 * Wired through the daily reconcile path (see daily-recompute-service).
 * Manual trigger via POST /api/v1/admin/intent-engine/archive.
 */

import { createClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
}

interface RunArgs {
  older_than_days?: number;
  batch_size?: number;
}

/**
 * Run one batch of archival. Returns counts. Caller can loop until
 * archived === 0 to drain the backlog.
 */
export async function runArchivalBatch(args: RunArgs = {}): Promise<{ archived: number; remaining: number }> {
  const supabase = getSupabase();
  const olderThan = Math.max(args.older_than_days ?? 90, 7);
  const batchSize = Math.min(Math.max(args.batch_size ?? 500, 1), 5000);

  const { data, error } = await supabase.rpc('archive_old_intent_matches', {
    p_older_than_days: olderThan,
    p_batch_size: batchSize,
  });

  if (error) {
    console.warn(`[VTID-01976] archive RPC failed: ${error.message}`);
    return { archived: 0, remaining: 0 };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const archived = (row?.archived ?? 0) as number;
  const remaining = (row?.remaining ?? 0) as number;

  await emitOasisEvent({
    vtid: 'VTID-01976',
    type: 'voice.message.sent',
    source: 'intent-archival-worker',
    status: 'info',
    message: `intent.match.archived: batch=${archived} remaining=${remaining}`,
    payload: { older_than_days: olderThan, batch_size: batchSize, archived, remaining },
    surface: 'system',
  });

  return { archived, remaining };
}

/**
 * Drain loop — repeatedly call runArchivalBatch until nothing's left.
 * Designed for the daily cron path. Bounded by max_iterations to avoid
 * runaway in pathological cases.
 */
export async function drainArchival(args: RunArgs & { max_iterations?: number } = {}): Promise<{ total_archived: number; iterations: number }> {
  const max = args.max_iterations ?? 20;
  let total = 0;
  let i = 0;
  for (; i < max; i++) {
    const result = await runArchivalBatch({
      older_than_days: args.older_than_days,
      batch_size: args.batch_size,
    });
    total += result.archived;
    if (result.archived === 0) break;
  }
  return { total_archived: total, iterations: i };
}
