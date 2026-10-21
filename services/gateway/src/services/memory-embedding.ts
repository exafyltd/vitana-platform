/**
 * VTID-04342 — the ONE embedder for user memory.
 *
 * Amazon Titan Text Embeddings V2 (amazon.titan-embed-text-v2:0, 1024 dims)
 * over Bedrock — the same model dev_agent_memory has used successfully since
 * VTID-03889 (100% of its rows embedded). Platform-owner decision
 * 2026-09-23 (docs/MEMORY-SYSTEM-PLAN.md §7, decision 2): Titan V2 is the
 * single embedder for all memory; memory_items.embedding and
 * memory_facts.embedding are vector(1024) (migration
 * 20260923130000_vtid_04342_memory_embeddings_titan_v2).
 *
 * Why this exists: user-memory embeddings called OpenAI → Gemini. Neither key
 * exists on AWS, so nothing had been embedded since 2026-04-28 and semantic
 * recall silently fell back to "most recent". There is deliberately no
 * fallback provider here — a second model would write vectors from a
 * different space into the same column, which is worse than no vector. A
 * failure returns ok:false; callers leave the row un-embedded and AP-0910
 * retries it.
 *
 * The shared embedding-service.ts (1536-dim) is NOT touched: calendar,
 * products, feedback tickets, intents and the VTID ledger still use it.
 */

import { generateDevMemoryEmbedding } from './dev-memory-embedding';

export const MEMORY_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
export const MEMORY_EMBEDDING_DIMENSIONS = 1024;

/** Titan V2 accepts up to 8k tokens; memory rows are short, keep it bounded. */
const MAX_EMBED_CHARS = 8000;
/** Parallel Bedrock calls per batch — small, Titan V2 has no batch API. */
const BATCH_CONCURRENCY = 5;

export interface MemoryEmbeddingResult {
  ok: boolean;
  embedding?: number[];
  model?: string;
  error?: string;
}

export interface MemoryEmbeddingBatchResult {
  ok: boolean;
  /** Same length/order as the input; null where that one text failed. */
  embeddings?: Array<number[] | null>;
  model?: string;
  failed?: number;
  error?: string;
}

export async function embedMemoryText(text: string): Promise<MemoryEmbeddingResult> {
  const input = (text ?? '').trim().slice(0, MAX_EMBED_CHARS);
  if (!input) return { ok: false, error: 'empty_text' };
  const res = await generateDevMemoryEmbedding(input);
  if (!res.ok) return { ok: false, error: `${res.error}: ${res.message}` };
  return { ok: true, embedding: res.embedding, model: MEMORY_EMBEDDING_MODEL };
}

/**
 * Embed many texts. Never throws. `ok` is false only when EVERY text failed
 * (e.g. Bedrock not configured) — partial failures come back as nulls so a
 * backfill stores what it can and retries the rest next run.
 */
export async function embedMemoryTexts(texts: string[]): Promise<MemoryEmbeddingBatchResult> {
  if (texts.length === 0) return { ok: true, embeddings: [], model: MEMORY_EMBEDDING_MODEL, failed: 0 };
  const out: Array<number[] | null> = new Array(texts.length).fill(null);
  let firstError: string | undefined;
  for (let i = 0; i < texts.length; i += BATCH_CONCURRENCY) {
    const slice = texts.slice(i, i + BATCH_CONCURRENCY);
    const results = await Promise.all(slice.map((t) => embedMemoryText(t)));
    results.forEach((r, j) => {
      if (r.ok && r.embedding) out[i + j] = r.embedding;
      else if (!firstError) firstError = r.error;
    });
  }
  const failed = out.filter((v) => v === null).length;
  if (failed === texts.length) {
    return { ok: false, embeddings: out, failed, error: firstError ?? 'all_failed' };
  }
  return { ok: true, embeddings: out, model: MEMORY_EMBEDDING_MODEL, failed };
}

// ---------------------------------------------------------------------------
// Drop-in adapters for callers that used embedding-service.ts's shapes on
// memory_items (routes/semantic-memory.ts, routes/admin-embeddings-backfill.ts).
// ---------------------------------------------------------------------------

export async function generateMemoryEmbedding(
  text: string,
): Promise<{ ok: boolean; embedding?: number[]; model?: string; error?: string }> {
  return embedMemoryText(text);
}

export async function generateMemoryBatchEmbeddings(
  texts: string[],
): Promise<{ ok: boolean; embeddings?: number[][]; model?: string; error?: string }> {
  const res = await embedMemoryTexts(texts);
  if (!res.ok || !res.embeddings) return { ok: false, error: res.error };
  // These callers index embeddings by position and store every entry, so a
  // partial failure fails the batch rather than handing back a hole.
  if (res.embeddings.some((e) => e === null)) {
    return { ok: false, error: `${res.failed} of ${texts.length} embeddings failed` };
  }
  return { ok: true, embeddings: res.embeddings as number[][], model: res.model };
}

export function isMemoryEmbeddingAvailable(): { available: boolean; providers: string[] } {
  const available = !!process.env.BEDROCK_ROLE_ARN;
  return { available, providers: available ? ['titan_bedrock_v2'] : [] };
}

/** pgvector literal, e.g. "[0.1,0.2,…]". */
export function toPgVector(embedding: number[]): string {
  return '[' + embedding.join(',') + ']';
}
