/**
 * VTID-01992: Async intent embedding worker.
 *
 * Promotes the inline embedding call (intents.ts POST → embedIntent →
 * Gemini text-embedding) off the post path. The post path can now skip
 * embedding entirely (FEATURE_INTENT_EMBEDDING_ASYNC=true) and rely on
 * this worker to backfill `user_intents.embedding` within a few seconds.
 *
 * Design notes:
 *  - The plan called this "NOTIFY-driven". A polling worker achieves the
 *    same async-decoupling goal with a much friendlier operational
 *    profile on Cloud Run: no persistent LISTEN connection (which Cloud
 *    Run's per-request scaling churns), no extra `pg` dependency, and
 *    embedding is idempotent (same input → same vector) so concurrent
 *    instances are safe.
 *  - Polling cadence: 5s. With batch size 16, that's 192 embeds/min
 *    upper bound — comfortably above the ~100/min threshold the plan
 *    flagged as the trigger to promote off inline.
 *  - The worker runs even when FEATURE_INTENT_EMBEDDING_ASYNC=false so
 *    that any intent that slipped past the inline embed (network blip,
 *    Gemini transient failure) gets backfilled. It's pure insurance in
 *    that mode and can be left on indefinitely.
 *  - Stop signal: SIGTERM handling is already wired by the Express
 *    server; the setInterval handle is stored on a module-local var and
 *    cleared by stopIntentEmbeddingWorker() so tests can shut it down.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { embedIntent } from './intent-embedding';
import { emitOasisEvent } from './oasis-event-service';

const POLL_INTERVAL_MS = parseInt(process.env.INTENT_EMBEDDING_WORKER_INTERVAL_MS || '5000', 10);
const BATCH_SIZE = parseInt(process.env.INTENT_EMBEDDING_WORKER_BATCH_SIZE || '16', 10);

let pollHandle: NodeJS.Timeout | null = null;
let inFlight = false;
let consecutiveErrors = 0;
let lastEventEmittedAt = 0;
const EVENT_EMIT_INTERVAL_MS = 60 * 60 * 1000; // hourly heartbeat ceiling

interface PendingIntent {
  intent_id: string;
  intent_kind: string;
  category: string | null;
  title: string;
  scope: string;
  kind_payload: Record<string, unknown> | null;
}

function getSupabase(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

async function processBatch(): Promise<{ embedded: number; failed: number; remaining: boolean }> {
  const supabase = getSupabase();

  // Pull a batch of un-embedded intents oldest-first. The covering index
  // (migration 20260427200000) makes this fast even with a large table.
  const { data, error } = await supabase
    .from('user_intents')
    .select('intent_id, intent_kind, category, title, scope, kind_payload')
    .is('embedding', null)
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.warn(`[VTID-01992] embedding worker fetch failed: ${error.message}`);
    return { embedded: 0, failed: 0, remaining: false };
  }

  const rows = (data ?? []) as PendingIntent[];
  if (rows.length === 0) {
    return { embedded: 0, failed: 0, remaining: false };
  }

  let embedded = 0;
  let failed = 0;

  // Sequentially to avoid hammering the Gemini endpoint and to keep
  // cost predictable. 16 calls × ~600ms ≈ 10s worst case — fits within
  // the next polling tick.
  for (const row of rows) {
    try {
      const vec = await embedIntent({
        intent_kind: row.intent_kind as any,
        category: row.category,
        title: row.title,
        scope: row.scope,
        kind_payload: row.kind_payload || {},
      });
      if (!vec) {
        failed += 1;
        continue;
      }
      const { error: updErr } = await supabase
        .from('user_intents')
        .update({ embedding: vec as any })
        .eq('intent_id', row.intent_id);
      if (updErr) {
        failed += 1;
        console.warn(`[VTID-01992] embedding update failed for ${row.intent_id}: ${updErr.message}`);
      } else {
        embedded += 1;
      }
    } catch (err: any) {
      failed += 1;
      console.warn(`[VTID-01992] embedding row ${row.intent_id} failed: ${err?.message}`);
    }
  }

  return { embedded, failed, remaining: rows.length === BATCH_SIZE };
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    let totalEmbedded = 0;
    let totalFailed = 0;
    // Drain up to 4 batches per tick if backlog exists; cap to avoid
    // monopolising the event loop.
    for (let i = 0; i < 4; i++) {
      const { embedded, failed, remaining } = await processBatch();
      totalEmbedded += embedded;
      totalFailed += failed;
      if (!remaining) break;
    }

    if (totalEmbedded > 0 || totalFailed > 0) {
      const now = Date.now();
      if (now - lastEventEmittedAt > EVENT_EMIT_INTERVAL_MS || totalFailed > 0) {
        lastEventEmittedAt = now;
        await emitOasisEvent({
          vtid: 'VTID-01992',
          type: 'voice.message.sent',
          source: 'intent-embedding-worker',
          status: totalFailed > 0 ? 'warning' : 'info',
          message: `intent.embedding.batch: embedded=${totalEmbedded} failed=${totalFailed}`,
          payload: { embedded: totalEmbedded, failed: totalFailed, batch_size: BATCH_SIZE, interval_ms: POLL_INTERVAL_MS },
          surface: 'system',
        }).catch(() => {});
      }
    }

    consecutiveErrors = 0;
  } catch (err: any) {
    consecutiveErrors += 1;
    if (consecutiveErrors === 1 || consecutiveErrors % 12 === 0) {
      console.warn(`[VTID-01992] worker tick error (${consecutiveErrors}): ${err?.message}`);
    }
  } finally {
    inFlight = false;
  }
}

export function startIntentEmbeddingWorker(): void {
  if (pollHandle) return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-01992] embedding worker disabled — missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
    return;
  }
  pollHandle = setInterval(() => { tick().catch(() => {}); }, POLL_INTERVAL_MS);
  console.log(`📐 Intent embedding worker started (interval=${POLL_INTERVAL_MS}ms, batch=${BATCH_SIZE})`);
}

export function stopIntentEmbeddingWorker(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}
