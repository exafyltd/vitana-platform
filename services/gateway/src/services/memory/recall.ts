/**
 * VTID-04452: the ORB live prompt reads memory through the broker.
 *
 * Plan Phase 1, "both prompt builders call one recall()". The context pack
 * already reads through `getMemoryContext()`; the ORB live prompt still read
 * six tables itself (`fetchMemoryContextWithIdentity`), including the legacy
 * `ai_memory` table, with no role scope.
 *
 * This module asks the broker for the same three kinds of memory the live
 * prompt uses (current facts, episodes, diary) and returns them as the
 * `MemoryItem` rows the bridge already selects and formats. The prompt text
 * keeps its shape; only the source changes:
 *   - facts from `memory_facts` (current values only),
 *   - episodes from `memory_items`, role-scoped (personal + own role),
 *   - diary from both diary tables,
 *   - nothing from `ai_memory` (its 112 rows were copied into `memory_items`).
 *
 * Off by default. `MEMORY_ORB_RECALL_ENABLED=true` turns it on. Every call
 * logs one `[VTID-04452] orb recall` line with latency and sections, so a
 * staging run compares directly against the legacy
 * `[VTID-01224-FIX] Bootstrap parallel fetch completed in Nms` line.
 * When the broker returns nothing usable (disabled, error, timeout on every
 * section), the caller falls back to the legacy read.
 */

import { getMemoryContext, type MemoryPack } from '../memory-broker';

export interface RecallIdentity {
  user_id: string;
  tenant_id: string;
  active_role?: string | null;
}

export interface RecallItem {
  id: string;
  category_key: string;
  source: string;
  content: string;
  content_json: Record<string, unknown>;
  importance: number;
  occurred_at: string;
  created_at: string;
}

export interface OrbRecallResult {
  ok: boolean;
  items: RecallItem[];
  latency_ms: number;
  degraded: boolean;
  sections: { facts: number; episodes: number; diary: number };
  error?: string;
}

/** Budget for the whole read. The legacy read used a 2 s hard timeout. */
export const ORB_RECALL_BUDGET_MS = 1500;

export function isOrbRecallEnabled(): boolean {
  return process.env.MEMORY_ORB_RECALL_ENABLED === 'true';
}

/** Pure: turn a broker pack into the bridge's item rows. */
export function packToRecallItems(pack: MemoryPack): OrbRecallResult['sections'] & { items: RecallItem[] } {
  const now = new Date().toISOString();
  const items: RecallItem[] = [];

  const semantic = pack.blocks.SEMANTIC;
  const facts = semantic && semantic.kind === 'SEMANTIC' ? semantic.facts : [];
  for (const f of facts) {
    if (!f.fact_key || f.fact_value == null || String(f.fact_value).trim() === '') continue;
    items.push({
      id: f.id,
      category_key: 'personal',
      source: 'memory_facts',
      content: `${f.fact_key}: ${f.fact_value}`,
      content_json: { fact_key: f.fact_key, fact_value: f.fact_value, entity: f.entity },
      importance: Math.round((Number.isFinite(f.confidence) ? f.confidence : 0.85) * 100),
      occurred_at: f.asserted_at || now,
      created_at: f.asserted_at || now,
    });
  }

  const diaryBlock = pack.blocks.DIARY;
  const diary = diaryBlock && diaryBlock.kind === 'DIARY' ? diaryBlock.entries : [];
  for (const d of diary) {
    items.push({
      id: d.id,
      category_key: (d.category_key || 'notes').replace(/-/g, '_'),
      source: 'diary',
      content: d.content,
      content_json: {},
      importance: 60,
      occurred_at: d.occurred_at,
      created_at: d.occurred_at,
    });
  }

  const episodic = pack.blocks.EPISODIC;
  const episodes = episodic && episodic.kind === 'EPISODIC' ? episodic.hits : [];
  for (const e of episodes) {
    if (!e.content || !e.content.trim()) continue;
    items.push({
      id: e.id,
      category_key: e.category_key || 'uncategorized',
      source: e.source || 'memory_items',
      content: e.content,
      content_json: {},
      importance: e.importance,
      occurred_at: e.occurred_at,
      created_at: e.occurred_at,
    });
  }

  // Same id can come back from two blocks only by accident; keep the first.
  const seen = new Set<string>();
  const unique = items.filter(i => (seen.has(i.id) ? false : (seen.add(i.id), true)));

  return { items: unique, facts: facts.length, episodes: episodes.length, diary: diary.length };
}

/**
 * Read the live prompt's memory through the broker. Never throws.
 * `query` (optional) enables semantic episode search for the current turn.
 */
export async function recallOrbMemoryItems(
  identity: RecallIdentity,
  opts: { query?: string; budgetMs?: number; read?: typeof getMemoryContext } = {},
): Promise<OrbRecallResult> {
  const t0 = Date.now();
  const read = opts.read ?? getMemoryContext;
  const empty = { facts: 0, episodes: 0, diary: 0 };
  try {
    const pack = await read({
      tenant_id: identity.tenant_id,
      user_id: identity.user_id,
      intent: 'recall_history',
      channel: 'orb-live',
      role: identity.active_role ?? undefined,
      lens: identity.active_role ? { active_role: identity.active_role } : undefined,
      required_blocks: ['SEMANTIC', 'EPISODIC', 'DIARY'],
      latency_budget_ms: opts.budgetMs ?? ORB_RECALL_BUDGET_MS,
      query: opts.query,
    });
    const latency = Date.now() - t0;
    if (!pack.ok) {
      console.warn(`[VTID-04452] orb recall unavailable in ${latency}ms: ${pack.error ?? 'unknown'}`);
      return { ok: false, items: [], latency_ms: latency, degraded: true, sections: empty, error: pack.error ?? 'broker_not_ok' };
    }
    const { items, ...sections } = packToRecallItems(pack);
    const gotAny = Object.keys(pack.blocks).length > 0;
    console.log(
      `[VTID-04452] orb recall in ${latency}ms facts=${sections.facts} episodes=${sections.episodes} ` +
      `diary=${sections.diary} degraded=${pack.meta.degraded} streams=${pack.meta.streams_hit.join(',')}`,
    );
    if (!gotAny) {
      return { ok: false, items: [], latency_ms: latency, degraded: true, sections, error: 'no_sections_loaded' };
    }
    return { ok: true, items, latency_ms: latency, degraded: pack.meta.degraded, sections };
  } catch (err: any) {
    const latency = Date.now() - t0;
    console.warn(`[VTID-04452] orb recall failed in ${latency}ms: ${err?.message ?? err}`);
    return { ok: false, items: [], latency_ms: latency, degraded: true, sections: empty, error: err?.message ?? String(err) };
  }
}
