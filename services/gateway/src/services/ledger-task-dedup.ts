/**
 * VTID-03819: Backlog-aware task intake — embedding dedup for vtid_ledger.
 *
 * Before a new operator/autopilot task lands on the Tasks board, check
 * whether a similar, still-open task already exists. Reuses the existing
 * embedding-service (VTID-01184) rather than building new embedding infra —
 * per the platform's own "prefer existing systems over rebuilding" rule.
 *
 * Two similarity bands, both computed from the same search call:
 *   - HARD_DUPLICATE_THRESHOLD (0.93+): treated as the same task. The
 *     caller should NOT create a new ledger row; surface the existing VTID
 *     instead.
 *   - RELATED_THRESHOLD (0.80-0.93): close enough to be worth surfacing to
 *     a human, but not close enough to assume it's the same request. The
 *     caller still creates the new task, but stamps metadata.related_vtid
 *     so the Command Hub board can render a "Related" chip.
 *
 * Fails OPEN: if embedding generation or the search RPC is unavailable
 * (no OPENAI_API_KEY, Supabase unreachable, migration not yet applied),
 * this reports "no match" rather than blocking task creation — dedup is
 * an availability enhancement, not a precondition for the core task
 * creation flow to work. Errors are logged, not silenced.
 */

import fetch from 'node-fetch';
import { generateEmbedding } from './embedding-service';

const VTID = 'VTID-03819';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

export const HARD_DUPLICATE_THRESHOLD = 0.93;
export const RELATED_THRESHOLD = 0.80;

export interface SimilarTaskMatch {
  vtid: string;
  title: string;
  status: string;
  similarity: number;
}

export interface SimilarTaskCheckResult {
  /** Best match at or above HARD_DUPLICATE_THRESHOLD, if any. */
  duplicate?: SimilarTaskMatch;
  /** Best match at or above RELATED_THRESHOLD but below the duplicate line. */
  related?: SimilarTaskMatch;
}

/**
 * Search existing non-terminal vtid_ledger rows for a task similar to the
 * given title/description. Returns {} (no matches, or dedup unavailable)
 * rather than throwing — see module doc for the fail-open rationale.
 */
export async function checkForSimilarTask(
  title: string,
  description: string
): Promise<SimilarTaskCheckResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn(`[${VTID}] Supabase not configured — skipping similarity check`);
    return {};
  }

  const text = description && description.trim().length > 0 ? description : title;

  const embeddingResult = await generateEmbedding(text);
  if (!embeddingResult.ok || !embeddingResult.embedding) {
    console.warn(`[${VTID}] Embedding generation unavailable (${embeddingResult.error ?? 'unknown error'}) — skipping similarity check`);
    return {};
  }

  try {
    const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/find_similar_vtid_tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
      },
      body: JSON.stringify({
        p_query_embedding: embeddingStr,
        p_top_k: 5,
        p_min_similarity: RELATED_THRESHOLD
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.warn(`[${VTID}] find_similar_vtid_tasks RPC failed: ${resp.status} - ${errText}`);
      return {};
    }

    const matches = (await resp.json()) as SimilarTaskMatch[];
    if (!Array.isArray(matches) || matches.length === 0) {
      return {};
    }

    // RPC already orders closest-first.
    const best = matches[0];
    if (best.similarity >= HARD_DUPLICATE_THRESHOLD) {
      return { duplicate: best };
    }
    return { related: best };
  } catch (error: any) {
    console.warn(`[${VTID}] Similarity check error: ${error.message}`);
    return {};
  }
}

/**
 * Fire-and-forget: populate the embedding column on a just-created ledger
 * row, so future dedup checks can find it. Deliberately does not backfill
 * historic rows (see the migration header) — coverage grows from here
 * forward only. Never throws; a failure here must not affect task
 * creation, which has already succeeded by the time this is called.
 */
export async function stampTaskEmbedding(vtid: string, title: string, description: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return;

  try {
    const text = description && description.trim().length > 0 ? description : title;
    const embeddingResult = await generateEmbedding(text);
    if (!embeddingResult.ok || !embeddingResult.embedding) {
      console.warn(`[${VTID}] Could not stamp embedding for ${vtid}: ${embeddingResult.error ?? 'unknown error'}`);
      return;
    }

    const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        embedding: embeddingStr,
        embedding_updated_at: new Date().toISOString()
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.warn(`[${VTID}] Embedding PATCH failed for ${vtid}: ${resp.status} - ${errText}`);
    }
  } catch (error: any) {
    console.warn(`[${VTID}] Embedding stamp error for ${vtid}: ${error.message}`);
  }
}
