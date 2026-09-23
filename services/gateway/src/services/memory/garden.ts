/**
 * VTID-04388: the Memory Garden reads and edits the canonical store.
 *
 * Defect D4: the Garden UI read the legacy `ai_memory` (last write
 * 2025-11-10) and `diary_entries`, while voice and text wrote
 * `memory_facts` / `memory_items`. Users never saw what Vitana remembers, so
 * they could not correct it. The Garden now shows exactly what recall reads:
 *
 *   - facts:    current rows of `memory_facts` (`superseded_at IS NULL`)
 *   - episodes: `memory_items` that are not raw conversation turns (session
 *               summaries, diary entries, daily learnings, Garden notes, …)
 *
 * Both are grouped into the 13 Garden categories. Defect D5 counted
 * `ai_memory.memory_type` (fact / insight / pattern …) as if it were a
 * category; here a fact's category comes from its key and an episode's from
 * `memory_category_mapping`.
 *
 * Edits made by the user always win:
 *   - a fact is added or edited through rememberFact() with provenance
 *     `user_stated_via_memory_garden_ui` (confidence 1.0), which supersedes;
 *   - a fact is forgotten by deleting every row of that key for the user,
 *     history included — readers disagree on `superseded_at` vs
 *     `superseded_by` as the "current" marker, and a forgotten value must
 *     not survive in either, nor in the supersession history;
 *   - a note is a `memory_items` row (source 'upload', kind 'garden_note');
 *   - an episode is edited in place (embedding cleared for re-embedding) or
 *     deleted.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { rememberFact } from './remember';
import { memoryRoleForRead, memoryRoleForWrite } from './scope';

export const GARDEN_CATEGORIES = [
  'personal_identity',
  'health_wellness',
  'lifestyle_routines',
  'network_relationships',
  'learning_knowledge',
  'business_projects',
  'finance_assets',
  'location_environment',
  'digital_footprint',
  'values_aspirations',
  'autopilot_context',
  'future_plans',
  'uncategorized',
] as const;
export type GardenCategory = (typeof GARDEN_CATEGORIES)[number];

export function isGardenCategory(v: unknown): v is GardenCategory {
  return typeof v === 'string' && (GARDEN_CATEGORIES as readonly string[]).includes(v);
}

/**
 * Garden category for a fact key. Ordered rules; the first match wins.
 * Keys come from the extractor (`user_name`, `spouse_name`,
 * `user_sleep_duration`, `user_goal_weight_loss`, …).
 */
const FACT_RULES: Array<[RegExp, GardenCategory]> = [
  // Exact identity keys first: `preferred_language` must not fall into
  // "preference" below.
  [/^(user_name|user_first_name|user_last_name|user_birthday|user_age|user_gender|preferred_language|user_language|user_nationality|user_pronouns)$/, 'personal_identity'],
  [/(spouse|wife|husband|partner|friend|child|son|daughter|mother|father|parent|sibling|brother|sister|family|relationship|social|colleague)/, 'network_relationships'],
  [/(health|sleep|medication|medicine|allerg|water|weight|diet|mood|energy|exercise|activity|steps|vitana_index|pillar|symptom|condition|blood|heart|stress|pain|diary_recent_health)/, 'health_wellness'],
  [/(goal|value|aspiration|dream|purpose|belief)/, 'values_aspirations'],
  [/(plan|milestone|future|upcoming|intend)/, 'future_plans'],
  [/(occupation|job|company|employer|work|business|project|career|profession)/, 'business_projects'],
  [/(finance|income|salary|money|budget|invest|asset|debt|saving)/, 'finance_assets'],
  [/(residence|city|country|address|location|hometown|home_town|travel|place|neighborhood)/, 'location_environment'],
  [/(learn|skill|education|study|degree|school|university|language_learning|course)/, 'learning_knowledge'],
  [/(favorite|favourite|preference|prefer|drink|food|hobby|routine|habit|music|morning|evening)/, 'lifestyle_routines'],
  [/(email|phone|social_media|account|website|online|digital)/, 'digital_footprint'],
  [/(autopilot|reminder|notification|assistant)/, 'autopilot_context'],
  [/(name|birthday|birth|age|gender|nationality|language|pronoun|identity)/, 'personal_identity'],
];

export function gardenCategoryForFactKey(factKey: string): GardenCategory {
  const k = (factKey || '').toLowerCase();
  for (const [re, cat] of FACT_RULES) if (re.test(k)) return cat;
  return 'uncategorized';
}

/** Garden category for a memory_items category_key, through the mapping table. */
export function gardenCategoryForItem(categoryKey: string | null, mapping: Map<string, string>): GardenCategory {
  const mapped = categoryKey ? mapping.get(categoryKey) ?? categoryKey : 'uncategorized';
  return isGardenCategory(mapped) ? mapped : 'uncategorized';
}

/** The inverse: which memory_items category_key a note in this Garden category is stored under. */
export function itemCategoryKeyForGarden(cat: GardenCategory): string {
  return cat === 'uncategorized' ? 'notes' : cat;
}

export interface GardenIdentity {
  tenant_id: string;
  user_id: string;
  active_role?: string | null;
}

export interface GardenEntry {
  kind: 'fact' | 'episode';
  id: string;
  category: GardenCategory;
  /** Human-readable text. For facts: the value; the key is in `fact_key`. */
  content: string;
  fact_key?: string;
  episode_kind?: string;
  source: string;
  confidence: number | null;
  /** True when the user wrote or confirmed it. */
  user_confirmed: boolean;
  occurred_at: string;
}

const RAW_TURN_DIRECTIONS = new Set(['user', 'assistant']);

export function isRawTurn(contentJson: any): boolean {
  return RAW_TURN_DIRECTIONS.has(contentJson?.direction);
}

let mappingCache: { at: number; map: Map<string, string> } | null = null;
const MAPPING_TTL_MS = 10 * 60 * 1000;

export async function loadCategoryMapping(client: SupabaseClient): Promise<Map<string, string>> {
  if (mappingCache && Date.now() - mappingCache.at < MAPPING_TTL_MS) return mappingCache.map;
  const map = new Map<string, string>();
  const { data } = await client.from('memory_category_mapping').select('source_category, garden_category');
  for (const r of (data || []) as any[]) map.set(r.source_category, r.garden_category);
  mappingCache = { at: Date.now(), map };
  return map;
}

/** Test hook. */
export function _resetGardenCache(): void {
  mappingCache = null;
}

function roleOr(identity: GardenIdentity): string {
  const r = memoryRoleForRead(identity.active_role);
  return `active_role.is.null,active_role.eq.${r}`;
}

/** Every Garden entry for the user (facts + episodes), newest first. */
export async function listGardenEntries(
  client: SupabaseClient,
  identity: GardenIdentity,
  opts: { category?: GardenCategory; limit?: number } = {},
): Promise<GardenEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const [mapping, factsRes, itemsRes] = await Promise.all([
    loadCategoryMapping(client),
    client
      .from('memory_facts')
      .select('id, fact_key, fact_value, provenance_source, provenance_confidence, extracted_at')
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id)
      .is('superseded_at', null)
      .order('extracted_at', { ascending: false })
      .limit(limit),
    client
      .from('memory_items')
      .select('id, category_key, source, content, content_json, provenance_confidence, occurred_at')
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id)
      .or(roleOr(identity))
      .order('occurred_at', { ascending: false })
      .limit(limit * 3),
  ]);
  if (factsRes.error) throw new Error(`memory_facts: ${factsRes.error.message}`);
  if (itemsRes.error) throw new Error(`memory_items: ${itemsRes.error.message}`);

  const entries: GardenEntry[] = [];
  for (const f of (factsRes.data || []) as any[]) {
    entries.push({
      kind: 'fact',
      id: f.id,
      category: gardenCategoryForFactKey(f.fact_key),
      content: f.fact_value,
      fact_key: f.fact_key,
      source: f.provenance_source,
      confidence: f.provenance_confidence == null ? null : Number(f.provenance_confidence),
      user_confirmed: typeof f.provenance_source === 'string' && f.provenance_source.startsWith('user_stated'),
      occurred_at: f.extracted_at,
    });
  }
  for (const i of (itemsRes.data || []) as any[]) {
    if (isRawTurn(i.content_json)) continue;
    entries.push({
      kind: 'episode',
      id: i.id,
      category: gardenCategoryForItem(i.category_key, mapping),
      content: i.content,
      episode_kind: i.content_json?.kind ?? i.category_key ?? undefined,
      source: i.source,
      confidence: i.provenance_confidence == null ? null : Number(i.provenance_confidence),
      user_confirmed: i.content_json?.provenance === 'user_stated',
      occurred_at: i.occurred_at,
    });
  }
  const filtered = opts.category ? entries.filter((e) => e.category === opts.category) : entries;
  filtered.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0));
  return filtered.slice(0, limit);
}

export interface GardenCategorySummary {
  category: GardenCategory;
  count: number;
  last_updated_at: string | null;
}

/** Per-category counts over the same entries the list shows. */
export function summarizeCategories(entries: GardenEntry[]): GardenCategorySummary[] {
  const by = new Map<GardenCategory, GardenCategorySummary>();
  for (const c of GARDEN_CATEGORIES) by.set(c, { category: c, count: 0, last_updated_at: null });
  for (const e of entries) {
    const s = by.get(e.category)!;
    s.count += 1;
    if (!s.last_updated_at || e.occurred_at > s.last_updated_at) s.last_updated_at = e.occurred_at;
  }
  return GARDEN_CATEGORIES.map((c) => by.get(c)!);
}

export const MAX_NOTE_CHARS = 2_000;
const FACT_KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;

export type GardenWriteResult =
  | { ok: true; id: string | null }
  | { ok: false; status: number; error: string };

/** A user-written fact. Supersedes any current value for the key. */
export async function addGardenFact(
  client: SupabaseClient,
  identity: GardenIdentity,
  factKey: string,
  factValue: string,
): Promise<GardenWriteResult> {
  const key = (factKey || '').trim().toLowerCase();
  const value = (factValue || '').trim();
  if (!FACT_KEY_RE.test(key)) return { ok: false, status: 400, error: 'INVALID_FACT_KEY' };
  if (!value || value.length > MAX_NOTE_CHARS) return { ok: false, status: 400, error: 'INVALID_FACT_VALUE' };
  const r = await rememberFact(
    {
      tenant_id: identity.tenant_id,
      user_id: identity.user_id,
      fact_key: key,
      fact_value: value,
      entity: 'self',
      // A DB-allowed source the Identity Lock accepts for locked keys too.
      provenance_source: 'user_stated_via_memory_garden_ui',
      provenance_confidence: 1.0,
      actor: 'memory-garden',
    },
    { client },
  );
  if (!r.ok) return { ok: false, status: r.blocked ? 403 : 502, error: r.blocked ? 'IDENTITY_LOCKED' : (r.error || 'WRITE_FAILED') };
  return { ok: true, id: r.fact_id ?? null };
}

/** A user-written note in a Garden category. */
export async function addGardenNote(
  client: SupabaseClient,
  identity: GardenIdentity,
  content: string,
  category: GardenCategory,
): Promise<GardenWriteResult> {
  const text = (content || '').trim();
  if (!text || text.length > MAX_NOTE_CHARS) return { ok: false, status: 400, error: 'INVALID_CONTENT' };
  const { data, error } = await client
    .from('memory_items')
    .insert({
      tenant_id: identity.tenant_id,
      user_id: identity.user_id,
      category_key: itemCategoryKeyForGarden(category),
      source: 'upload',
      content: text,
      content_json: { kind: 'garden_note', provenance: 'user_stated', garden_category: category },
      // <= 50: trg_notify_memory_garden notifies above 50; the user just
      // wrote this note themselves.
      importance: 50,
      provenance_source: 'user_stated',
      provenance_confidence: 1.0,
      occurred_at: new Date().toISOString(),
      active_role: memoryRoleForWrite(identity.active_role),
    })
    .select('id')
    .single();
  if (error) return { ok: false, status: 502, error: error.message };
  embedLater((data as any)?.id, text);
  return { ok: true, id: (data as any)?.id ?? null };
}

/** Edit a user's episode in place; the embedding is regenerated. */
export async function editGardenEpisode(
  client: SupabaseClient,
  identity: GardenIdentity,
  id: string,
  content: string,
): Promise<GardenWriteResult> {
  const text = (content || '').trim();
  if (!text || text.length > MAX_NOTE_CHARS) return { ok: false, status: 400, error: 'INVALID_CONTENT' };
  const { data, error } = await client
    .from('memory_items')
    .update({
      content: text,
      embedding: null,
      embedding_updated_at: null,
      provenance_source: 'user_edited',
      provenance_confidence: 1.0,
    })
    .eq('id', id)
    .eq('tenant_id', identity.tenant_id)
    .eq('user_id', identity.user_id)
    .select('id, content_json');
  if (error) return { ok: false, status: 502, error: error.message };
  if (!data || (data as any[]).length === 0) return { ok: false, status: 404, error: 'NOT_FOUND' };
  // A diary episode mirrors its diary_entries row (VTID-04390): keep them equal.
  const diaryId = (data as any[])[0]?.content_json?.diary_entry_id;
  if (diaryId) {
    await client.from('diary_entries').update({ text }).eq('id', diaryId).eq('user_id', identity.user_id);
  }
  embedLater(id, text);
  return { ok: true, id };
}

/** Edit a fact: the user's value supersedes the current one. */
export async function editGardenFact(
  client: SupabaseClient,
  identity: GardenIdentity,
  id: string,
  value: string,
): Promise<GardenWriteResult> {
  const { data, error } = await client
    .from('memory_facts')
    .select('fact_key')
    .eq('id', id)
    .eq('tenant_id', identity.tenant_id)
    .eq('user_id', identity.user_id)
    .is('superseded_at', null)
    .maybeSingle();
  if (error) return { ok: false, status: 502, error: error.message };
  if (!data) return { ok: false, status: 404, error: 'NOT_FOUND' };
  return addGardenFact(client, identity, (data as any).fact_key, value);
}

/** Delete an episode, or forget a fact (every row of its key, history included). */
export async function deleteGardenEntry(
  client: SupabaseClient,
  identity: GardenIdentity,
  kind: 'fact' | 'episode',
  id: string,
): Promise<GardenWriteResult> {
  if (kind === 'episode') {
    const { data, error } = await client
      .from('memory_items')
      .delete()
      .eq('id', id)
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id)
      .select('id, content_json');
    if (error) return { ok: false, status: 502, error: error.message };
    if (!data || (data as any[]).length === 0) return { ok: false, status: 404, error: 'NOT_FOUND' };
    const diaryId = (data as any[])[0]?.content_json?.diary_entry_id;
    if (diaryId) {
      await client.from('diary_entries').delete().eq('id', diaryId).eq('user_id', identity.user_id);
    }
    return { ok: true, id };
  }
  const { data: cur, error: curErr } = await client
    .from('memory_facts')
    .select('fact_key')
    .eq('id', id)
    .eq('tenant_id', identity.tenant_id)
    .eq('user_id', identity.user_id)
    .maybeSingle();
  if (curErr) return { ok: false, status: 502, error: curErr.message };
  if (!cur) return { ok: false, status: 404, error: 'NOT_FOUND' };
  // One statement, so the superseded_by self-references inside the chain
  // are checked only after every row of the key is gone.
  const { error } = await client
    .from('memory_facts')
    .delete()
    .eq('tenant_id', identity.tenant_id)
    .eq('user_id', identity.user_id)
    .eq('fact_key', (cur as any).fact_key);
  if (error) return { ok: false, status: 502, error: error.message };
  return { ok: true, id };
}

/** Embed a memory_items row after a write (fire-and-forget, Titan V2). */
function embedLater(id: string | undefined, text: string): void {
  if (!id) return;
  void (async () => {
    try {
      const { embedMemoryText, toPgVector } = await import('../memory-embedding');
      const emb = await embedMemoryText(text);
      if (!emb.ok || !emb.embedding) return;
      const { getSupabase } = await import('../../lib/supabase');
      const sb = getSupabase();
      if (!sb) return;
      await sb
        .from('memory_items')
        .update({ embedding: toPgVector(emb.embedding), embedding_model: emb.model, embedding_updated_at: new Date().toISOString() })
        .eq('id', id);
    } catch {
      /* AP-0910 backfills anything left NULL */
    }
  })();
}
