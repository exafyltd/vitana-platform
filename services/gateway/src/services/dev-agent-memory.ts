/**
 * VTID-03889 — Operator Memory: write/recall for dev_agent_memory.
 *
 * The Command Hub Operator's own engineering memory -- decisions,
 * conventions, incidents, preferences, task outcomes -- separate from
 * Memory Garden (community end-user personalization) and built to avoid
 * the exact defect found live in Memory Garden's EPISODIC path: an
 * embedding-less write silently degrading "semantic" recall to recency
 * order for months with no error anywhere (see the migration file's
 * header comment for the full trace).
 *
 * Both functions here are fail-loud by design: a caller that cannot
 * generate a real embedding gets `ok:false` back, never a silently
 * degraded write or a recall that pretends to be semantic and isn't.
 */

import { getSupabase, supa } from './dev-autopilot-execute';
import { generateDevMemoryEmbedding } from './dev-memory-embedding';

export type DevMemoryRepo = 'vitana-platform' | 'vitana-v1';
export type DevMemoryCategory =
  | 'decision'
  | 'convention'
  | 'incident'
  | 'preference'
  | 'task_outcome'
  | 'gotcha'
  /** VTID-04407: one person's end-of-thread working state; read by the morning pack, excluded from semantic recall. */
  | 'handoff';
export type DevMemorySource = 'session' | 'autopilot' | 'manual' | 'backfill';
/** Which LLM routing stage produced a row. Provenance only -- see the migration header. */
export type DevMemoryStage = 'operator' | 'planner' | 'worker' | 'validator';

export interface WriteDevMemoryInput {
  repo: DevMemoryRepo;
  category: DevMemoryCategory;
  title: string;
  content: string;
  vtid?: string;
  importance?: number;
  source: DevMemorySource;
  tags?: string[];
  supersedes?: string;
  /** Concrete repo-relative files this memory is about (e.g. the diff's changed files). */
  filePaths?: string[];
  stage?: DevMemoryStage;
  /** VTID-04407: whose working state this is. Omit for repo-wide knowledge. */
  authorUserId?: string;
}

export interface DevMemoryHit {
  id: string;
  vtid: string | null;
  category: DevMemoryCategory;
  title: string;
  content: string;
  importance: number;
  source: DevMemorySource;
  tags: string[];
  created_at: string;
  similarity: number;
}

/** A file-scoped recall hit (recall_dev_memory_by_files) -- no similarity score, since there's no query embedding. */
export interface DevMemoryFileHit {
  id: string;
  vtid: string | null;
  category: DevMemoryCategory;
  title: string;
  content: string;
  importance: number;
  source: DevMemorySource;
  tags: string[];
  file_paths: string[];
  stage: DevMemoryStage | null;
  created_at: string;
}

/**
 * Write one dev_agent_memory row. Embeds `title + '\n' + content` (both
 * carry signal -- a bare title like "DeepSeek model id" embeds to
 * something quite different from the sentence explaining it).
 *
 * Fails loudly: if the embedding call fails, this returns ok:false and
 * writes nothing. It never falls back to a null/zero vector -- the DB
 * column is NOT NULL specifically to make that impossible even if this
 * function's own guard were ever bypassed.
 */
export async function writeDevMemory(
  input: WriteDevMemoryInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const s = getSupabase();
  if (!s) return { ok: false, error: 'supabase_not_configured' };

  const embedRes = await generateDevMemoryEmbedding(`${input.title}\n${input.content}`);
  if (!embedRes.ok) {
    return { ok: false, error: `embedding_failed: ${embedRes.error} — ${embedRes.message}` };
  }

  const r = await supa<Array<{ write_dev_memory: string }> | string>(
    s,
    '/rest/v1/rpc/write_dev_memory',
    {
      method: 'POST',
      body: JSON.stringify({
        p_repo: input.repo,
        p_category: input.category,
        p_title: input.title,
        p_content: input.content,
        p_embedding: `[${embedRes.embedding.join(',')}]`,
        p_vtid: input.vtid ?? null,
        p_importance: input.importance ?? 50,
        p_source: input.source,
        p_tags: input.tags ?? [],
        p_supersedes: input.supersedes ?? null,
        p_file_paths: input.filePaths ?? [],
        p_stage: input.stage ?? null,
        p_author_user_id: input.authorUserId ?? null,
      }),
    },
  );

  if (!r.ok) return { ok: false, error: r.error || `http_${r.status}` };
  // PostgREST returns the scalar return value directly (a bare UUID string)
  // for a non-table-returning function called via /rpc/.
  const id = typeof r.data === 'string' ? r.data : undefined;
  if (!id) return { ok: false, error: `unexpected_rpc_response: ${JSON.stringify(r.data)}` };
  return { ok: true, id };
}

/**
 * Recall the top-K dev_agent_memory rows by genuine cosine similarity to
 * `query`. Returns ok:false (not an empty-hits success) if the query
 * embedding itself cannot be generated -- a caller must not mistake
 * "we couldn't search" for "nothing relevant exists".
 */
export async function recallDevMemory(
  query: string,
  repo: DevMemoryRepo,
  opts: { limit?: number; category?: DevMemoryCategory } = {},
): Promise<{ ok: true; hits: DevMemoryHit[] } | { ok: false; error: string }> {
  const s = getSupabase();
  if (!s) return { ok: false, error: 'supabase_not_configured' };

  const embedRes = await generateDevMemoryEmbedding(query);
  if (!embedRes.ok) {
    return { ok: false, error: `embedding_failed: ${embedRes.error} — ${embedRes.message}` };
  }

  const r = await supa<DevMemoryHit[]>(s, '/rest/v1/rpc/recall_dev_memory', {
    method: 'POST',
    body: JSON.stringify({
      p_repo: repo,
      p_query_embedding: `[${embedRes.embedding.join(',')}]`,
      p_limit: opts.limit ?? 8,
      p_category: opts.category ?? null,
    }),
  });

  if (!r.ok) return { ok: false, error: r.error || `http_${r.status}` };
  return { ok: true, hits: r.data ?? [] };
}

/**
 * Recall dev_agent_memory rows whose file_paths overlap `files` -- a
 * deterministic, embedding-free counterpart to `recallDevMemory`. Meant
 * for a caller that already knows concrete target files (a plan's
 * files_referenced, a PR's changed files) and wants the gotchas/incidents
 * tied to exactly those paths, not merely the semantically nearest text.
 *
 * Returns `{ok:true, hits:[]}` (not an error) for an empty `files` list --
 * there is nothing to overlap against, which is a normal state (e.g. an
 * open-ended task with no files named yet), not a failure to search.
 */
export async function recallDevMemoryByFiles(
  files: string[],
  repo: DevMemoryRepo,
  opts: { limit?: number; category?: DevMemoryCategory } = {},
): Promise<{ ok: true; hits: DevMemoryFileHit[] } | { ok: false; error: string }> {
  const s = getSupabase();
  if (!s) return { ok: false, error: 'supabase_not_configured' };
  if (!files.length) return { ok: true, hits: [] };

  const r = await supa<DevMemoryFileHit[]>(s, '/rest/v1/rpc/recall_dev_memory_by_files', {
    method: 'POST',
    body: JSON.stringify({
      p_repo: repo,
      p_files: files,
      p_category: opts.category ?? null,
      p_limit: opts.limit ?? 8,
    }),
  });

  if (!r.ok) return { ok: false, error: r.error || `http_${r.status}` };
  return { ok: true, hits: r.data ?? [] };
}
