/**
 * VTID-01972 — Admin endpoint: backfill NULL embeddings on memory_items.
 *
 * The memory_items.embedding vector(1536) column was added by VTID-01184
 * but never populated for the historical rows. As a result,
 * memory_semantic_search() filters them out (`WHERE embedding IS NOT NULL`)
 * and falls back to keyword recall — semantic search has been silently
 * empty for legacy memories.
 *
 * This endpoint walks NULL-embedding rows in batches and embeds them via
 * generateEmbedding() (which now uses the Phase 3 LRU cache for repeated
 * text). Idempotent: skips rows that already have an embedding. Resumable:
 * just call again until `has_more=false`.
 *
 * Cost estimate: text-embedding-3-small @ $0.02/1M tokens, avg ~50 tokens
 * per memory_item content → ≈ $1 per 1M items. Negligible.
 *
 * Plan: /home/dstev/.claude/plans/the-vitana-system-has-wild-puffin.md
 *       Part 8 Phase 4.
 */

import { Router, Response } from 'express';
import {
  requireAuth,
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { generateEmbedding } from '../services/embedding-service';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

router.use(requireAuth);
router.use(requireExafyAdmin);

const VTID = 'VTID-01972';

interface MemoryItemRow {
  id: string;
  tenant_id: string;
  user_id: string;
  content: string;
}

/**
 * GET /api/v1/admin/embeddings/backfill/status
 * Returns row counts: total, embedded, missing.
 */
router.get('/admin/embeddings/backfill/status', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ ok: false, error: 'supabase_unavailable' });
  }

  try {
    const { count: total } = await supabase
      .from('memory_items')
      .select('id', { count: 'exact', head: true });

    const { count: embedded } = await supabase
      .from('memory_items')
      .select('id', { count: 'exact', head: true })
      .not('embedding', 'is', null);

    const { count: missing } = await supabase
      .from('memory_items')
      .select('id', { count: 'exact', head: true })
      .is('embedding', null);

    return res.json({
      ok: true,
      total: total ?? 0,
      embedded: embedded ?? 0,
      missing: missing ?? 0,
      pct_embedded: total ? Math.round(((embedded ?? 0) / total) * 10000) / 100 : 0,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * POST /api/v1/admin/embeddings/backfill
 * Body: { batch_size?: number (1..200, default 50), dry_run?: boolean }
 *
 * Idempotent + resumable. Caller invokes repeatedly until has_more=false.
 */
router.post('/admin/embeddings/backfill', async (req: AuthenticatedRequest, res: Response) => {
  const startTime = Date.now();
  const batchSize = Math.min(Math.max(Number(req.body?.batch_size) || 50, 1), 200);
  const dryRun = !!req.body?.dry_run;

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ ok: false, error: 'supabase_unavailable' });
  }

  try {
    // Pull a batch of NULL-embedding rows ordered oldest → newest so the
    // backfill is monotonic and easy to reason about.
    const { data: rows, error: selectErr } = await supabase
      .from('memory_items')
      .select('id, tenant_id, user_id, content')
      .is('embedding', null)
      .order('created_at', { ascending: true })
      .limit(batchSize);

    if (selectErr) {
      return res.status(500).json({ ok: false, error: selectErr.message });
    }

    const items = (rows as MemoryItemRow[] | null) ?? [];
    if (items.length === 0) {
      return res.json({
        ok: true,
        processed_count: 0,
        skipped_empty: 0,
        errors_count: 0,
        took_ms: Date.now() - startTime,
        has_more: false,
        dry_run: dryRun,
      });
    }

    if (dryRun) {
      return res.json({
        ok: true,
        would_process: items.length,
        sample_ids: items.slice(0, 5).map(r => r.id),
        took_ms: Date.now() - startTime,
        has_more: items.length === batchSize,
        dry_run: true,
      });
    }

    let processed = 0;
    let skippedEmpty = 0;
    let errors = 0;

    for (const item of items) {
      const text = (item.content || '').trim();
      if (!text) {
        skippedEmpty += 1;
        continue;
      }

      try {
        const embRes = await generateEmbedding(text);
        if (!embRes.ok || !embRes.embedding || !embRes.model) {
          errors += 1;
          console.warn(`[${VTID}] embed failed for item=${item.id}: ${embRes.error}`);
          continue;
        }

        const { error: updErr } = await supabase
          .from('memory_items')
          .update({
            embedding: embRes.embedding,
            embedding_model: embRes.model,
            embedding_updated_at: new Date().toISOString(),
          })
          .eq('id', item.id);

        if (updErr) {
          errors += 1;
          console.warn(`[${VTID}] update failed for item=${item.id}: ${updErr.message}`);
          continue;
        }

        processed += 1;
      } catch (err) {
        errors += 1;
        console.warn(`[${VTID}] exception for item=${item.id}: ${(err as Error).message}`);
      }
    }

    const tookMs = Date.now() - startTime;
    const hasMore = items.length === batchSize;

    // OASIS audit (one row per batch — not per-item, that would be event spam).
    await emitOasisEvent({
      vtid: VTID,
      type: 'memory.embeddings.updated',
      source: 'admin-embeddings-backfill',
      status: errors > 0 ? 'warning' : 'success',
      message: `Embedding backfill batch: ${processed} ok / ${errors} err / ${skippedEmpty} empty (${tookMs}ms)`,
      payload: {
        processed_count: processed,
        errors_count: errors,
        skipped_empty: skippedEmpty,
        batch_size: batchSize,
        took_ms: tookMs,
        has_more: hasMore,
      },
      actor_id: req.identity?.user_id || 'admin',
      actor_role: 'admin',
      surface: 'system',
    }).catch(() => { /* best-effort */ });

    return res.json({
      ok: true,
      processed_count: processed,
      skipped_empty: skippedEmpty,
      errors_count: errors,
      took_ms: tookMs,
      has_more: hasMore,
      dry_run: false,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
