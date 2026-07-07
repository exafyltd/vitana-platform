/**
 * Diary + Memory voice tools (VTID-02757).
 *
 * Read/manage tools over the user's Daily Diary (`diary_entries`) and the
 * Memory Garden (`memory_items` + `memory_facts`, garden category tables
 * from VTID-01086/01225): list diary entries in a date window, compute the
 * diary streak the same way the `user_diary_streak` view does (consecutive
 * UTC calendar days), build a chronological memory timeline, topic recall,
 * per-garden-category counts for "what do you remember about me?", and a
 * confirm-gated forget_memory. memory_items has NO soft-delete column
 * (VTID-01104), so forget_memory hard-deletes the row and records the
 * deletion in the VTID-01099 `memory_deletions` governance ledger.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ok:false gate when the tool needs an authenticated user (and tenant). */
function authGate(tool: string, id: OrbToolIdentity, needTenant = false): OrbToolResult | null {
  if (!id.user_id || (needTenant && !id.tenant_id)) {
    return { ok: false, error: `${tool} requires an authenticated user.` };
  }
  return null;
}

/** Parse an optional YYYY-MM-DD arg; undefined when absent, null when malformed. */
function parseDateArg(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const s = String(raw).trim();
  return DATE_RE.test(s) ? s : null;
}

function clampLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** "Jun 12" / "Jun 12, 2025" — English; the LLM translates when speaking DE. */
function dayPhrase(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions =
    d.getUTCFullYear() === new Date().getUTCFullYear()
      ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
      : { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' };
  return d.toLocaleDateString('en-US', opts);
}

function snippet(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Escape LIKE wildcards so user topics can't act as patterns. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** UTC calendar day string of an ISO timestamp (matches user_diary_streak view). */
function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// list_diary_entries — diary_entries(id, user_id, text, source, tags, created_at)
// ---------------------------------------------------------------------------

interface DiaryRow {
  id: string;
  text: string;
  source: string | null;
  tags: string[] | null;
  created_at: string;
}

export async function tool_list_diary_entries(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('list_diary_entries', id);
  if (gate) return gate;

  const dateFrom = parseDateArg(args.date_from);
  const dateTo = parseDateArg(args.date_to);
  if (dateFrom === null || dateTo === null) {
    return { ok: false, error: 'list_diary_entries dates must be YYYY-MM-DD.' };
  }
  const limit = clampLimit(args.limit, 10, 30);

  try {
    let q = sb
      .from('diary_entries')
      .select('id, text, source, tags, created_at')
      .eq('user_id', id.user_id);
    if (dateFrom) q = q.gte('created_at', `${dateFrom}T00:00:00.000Z`);
    if (dateTo) q = q.lte('created_at', `${dateTo}T23:59:59.999Z`);

    const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
    if (error) return { ok: false, error: `Could not load diary entries: ${error.message}` };

    const rows = (data || []) as DiaryRow[];
    if (rows.length === 0) {
      const windowTxt = dateFrom || dateTo
        ? ` between ${dateFrom ?? 'the beginning'} and ${dateTo ?? 'today'}`
        : '';
      return {
        ok: true,
        result: { entries: [], count: 0 },
        text: `The user has no diary entries${windowTxt}. Offer to log one now.`,
      };
    }

    const lines = rows.map((r) => `${dayPhrase(r.created_at)}: ${snippet(r.text)}`);
    return {
      ok: true,
      result: {
        count: rows.length,
        entries: rows.map((r) => ({
          id: r.id,
          text: r.text,
          source: r.source,
          created_at: r.created_at,
        })),
      },
      text:
        `Found ${rows.length} diary ${rows.length === 1 ? 'entry' : 'entries'} (newest first): ` +
        lines.join(' | ') +
        ' — summarize naturally in the user\'s language; do not read IDs.',
    };
  } catch (err) {
    return { ok: false, error: `list_diary_entries failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// get_diary_streak — consecutive UTC-day streak from diary_entries.created_at
// (same day-rule as the user_diary_streak view: streak may end today OR
// yesterday; a 2+ day gap breaks it).
// ---------------------------------------------------------------------------

export async function tool_get_diary_streak(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_diary_streak', id);
  if (gate) return gate;

  try {
    const { data, error } = await sb
      .from('diary_entries')
      .select('created_at')
      .eq('user_id', id.user_id)
      .order('created_at', { ascending: false })
      .limit(1000);
    if (error) return { ok: false, error: `Could not load diary entries: ${error.message}` };

    const rows = (data || []) as Array<{ created_at: string }>;
    if (rows.length === 0) {
      return {
        ok: true,
        result: { current_streak_days: 0, longest_streak_days: 0, last_entry_day: null },
        text: 'The user has no diary entries yet, so there is no streak. Encourage them to start today.',
      };
    }

    const daySet = new Set(rows.map((r) => utcDay(r.created_at)));
    const days = Array.from(daySet).sort(); // ascending YYYY-MM-DD

    // Current streak: consecutive days ending today (or yesterday).
    const today = new Date().toISOString().slice(0, 10);
    let cursor = daySet.has(today) ? today : addDays(today, -1);
    let current = 0;
    while (daySet.has(cursor)) {
      current += 1;
      cursor = addDays(cursor, -1);
    }

    // Longest streak across the fetched window.
    let longest = 1;
    let run = 1;
    for (let i = 1; i < days.length; i += 1) {
      run = days[i] === addDays(days[i - 1], 1) ? run + 1 : 1;
      if (run > longest) longest = run;
    }
    if (current > longest) longest = current;

    const lastDay = days[days.length - 1];
    const text =
      current > 0
        ? `The user's current diary streak is ${current} consecutive ${current === 1 ? 'day' : 'days'}` +
          `${daySet.has(today) ? ' including today' : ' (no entry yet today — an entry today keeps it alive)'}. ` +
          `Longest streak so far: ${longest} days. Celebrate briefly.`
        : `The user's diary streak is currently broken — the last entry was on ${dayPhrase(`${lastDay}T00:00:00Z`)}. ` +
          `Their longest streak so far is ${longest} days. Encourage a fresh start today.`;

    return {
      ok: true,
      result: {
        current_streak_days: current,
        longest_streak_days: longest,
        last_entry_day: lastDay,
        has_entry_today: daySet.has(today),
      },
      text,
    };
  } catch (err) {
    return { ok: false, error: `get_diary_streak failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// get_memory_timeline — memory_items + active memory_facts + diary_entries
// merged chronologically (newest first).
// ---------------------------------------------------------------------------

interface TimelineEvent {
  when: string;
  kind: 'memory' | 'fact' | 'diary';
  category: string | null;
  text: string;
  id: string | null;
}

export async function tool_get_memory_timeline(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_memory_timeline', id, true);
  if (gate) return gate;

  const dateFrom = parseDateArg(args.date_from);
  const dateTo = parseDateArg(args.date_to);
  if (dateFrom === null || dateTo === null) {
    return { ok: false, error: 'get_memory_timeline dates must be YYYY-MM-DD.' };
  }
  const limit = clampLimit(args.limit, 15, 40);
  const fromIso = dateFrom ? `${dateFrom}T00:00:00.000Z` : undefined;
  const toIso = dateTo ? `${dateTo}T23:59:59.999Z` : undefined;

  try {
    let itemsQ = sb
      .from('memory_items')
      .select('id, category_key, source, content, occurred_at')
      .eq('tenant_id', id.tenant_id)
      .eq('user_id', id.user_id);
    if (fromIso) itemsQ = itemsQ.gte('occurred_at', fromIso);
    if (toIso) itemsQ = itemsQ.lte('occurred_at', toIso);

    let factsQ = sb
      .from('memory_facts')
      .select('id, fact_key, fact_value, extracted_at')
      .eq('tenant_id', id.tenant_id)
      .eq('user_id', id.user_id)
      .is('superseded_by', null);
    if (fromIso) factsQ = factsQ.gte('extracted_at', fromIso);
    if (toIso) factsQ = factsQ.lte('extracted_at', toIso);

    let diaryQ = sb
      .from('diary_entries')
      .select('id, text, created_at')
      .eq('user_id', id.user_id);
    if (fromIso) diaryQ = diaryQ.gte('created_at', fromIso);
    if (toIso) diaryQ = diaryQ.lte('created_at', toIso);

    const [items, facts, diary] = await Promise.all([
      itemsQ.order('occurred_at', { ascending: false }).limit(limit),
      factsQ.order('extracted_at', { ascending: false }).limit(Math.min(limit, 15)),
      diaryQ.order('created_at', { ascending: false }).limit(Math.min(limit, 15)),
    ]);
    if (items.error) {
      return { ok: false, error: `Could not load memory timeline: ${items.error.message}` };
    }

    const events: TimelineEvent[] = [];
    for (const r of (items.data || []) as Array<{
      id: string; category_key: string; source: string; content: string; occurred_at: string;
    }>) {
      events.push({ when: r.occurred_at, kind: 'memory', category: r.category_key, text: snippet(r.content), id: r.id });
    }
    // facts/diary are best-effort enrichments — a failed sub-query degrades, not fails.
    for (const r of (facts.data || []) as Array<{
      id: string; fact_key: string; fact_value: string; extracted_at: string;
    }>) {
      events.push({ when: r.extracted_at, kind: 'fact', category: r.fact_key, text: snippet(`${r.fact_key.replace(/_/g, ' ')}: ${r.fact_value}`, 100), id: r.id });
    }
    for (const r of (diary.data || []) as Array<{ id: string; text: string; created_at: string }>) {
      events.push({ when: r.created_at, kind: 'diary', category: 'diary', text: snippet(r.text), id: r.id });
    }

    events.sort((a, b) => (a.when < b.when ? 1 : -1));
    const top = events.slice(0, limit);

    if (top.length === 0) {
      const windowTxt = dateFrom || dateTo
        ? ` between ${dateFrom ?? 'the beginning'} and ${dateTo ?? 'today'}`
        : '';
      return {
        ok: true,
        result: { events: [], count: 0 },
        text: `No memories, facts, or diary entries found${windowTxt}.`,
      };
    }

    const spoken = top
      .slice(0, 8)
      .map((e) => `${dayPhrase(e.when)} (${e.kind}): ${e.text}`)
      .join(' | ');
    return {
      ok: true,
      result: { count: top.length, events: top },
      text:
        `Memory timeline, newest first (${top.length} entr${top.length === 1 ? 'y' : 'ies'}): ${spoken}` +
        (top.length > 8 ? ` … and ${top.length - 8} more.` : '') +
        ' Retell it as a short narrative in the user\'s language.',
    };
  } catch (err) {
    return { ok: false, error: `get_memory_timeline failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// recall_memory_about — topic ilike search over memory_items (+ active
// memory_facts), optional garden/source category filter via
// memory_category_mapping.
// ---------------------------------------------------------------------------

/** Expand a spoken category (garden key OR source key) into source category keys. */
async function expandCategory(sb: SupabaseClient, category: string): Promise<string[]> {
  const cats = new Set<string>([category]);
  try {
    const { data } = await sb
      .from('memory_category_mapping')
      .select('source_category, garden_category');
    for (const m of (data || []) as Array<{ source_category: string; garden_category: string }>) {
      if (m.garden_category === category) cats.add(m.source_category);
    }
  } catch {
    // best-effort — fall back to the raw category key
  }
  return Array.from(cats);
}

export async function tool_recall_memory_about(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('recall_memory_about', id, true);
  if (gate) return gate;

  const topic = String(args.topic ?? '').trim();
  if (!topic) return { ok: false, error: 'recall_memory_about requires a non-empty topic.' };
  const category = typeof args.category === 'string' ? args.category.trim().toLowerCase() : '';
  const pattern = `%${escapeLike(topic)}%`;

  try {
    let itemsQ = sb
      .from('memory_items')
      .select('id, category_key, content, occurred_at')
      .eq('tenant_id', id.tenant_id)
      .eq('user_id', id.user_id)
      .ilike('content', pattern);
    if (category) {
      itemsQ = itemsQ.in('category_key', await expandCategory(sb, category));
    }

    const factsValueQ = sb
      .from('memory_facts')
      .select('id, fact_key, fact_value, extracted_at')
      .eq('tenant_id', id.tenant_id)
      .eq('user_id', id.user_id)
      .is('superseded_by', null)
      .ilike('fact_value', pattern)
      .limit(5);
    const factsKeyQ = sb
      .from('memory_facts')
      .select('id, fact_key, fact_value, extracted_at')
      .eq('tenant_id', id.tenant_id)
      .eq('user_id', id.user_id)
      .is('superseded_by', null)
      .ilike('fact_key', pattern)
      .limit(5);

    const [items, factsByValue, factsByKey] = await Promise.all([
      itemsQ.order('occurred_at', { ascending: false }).limit(10),
      factsValueQ,
      factsKeyQ,
    ]);
    if (items.error) {
      return { ok: false, error: `Could not search memory: ${items.error.message}` };
    }

    type FactRow = { id: string; fact_key: string; fact_value: string; extracted_at: string };
    const factMap = new Map<string, FactRow>();
    for (const f of [
      ...((factsByValue.data || []) as FactRow[]),
      ...((factsByKey.data || []) as FactRow[]),
    ]) {
      factMap.set(f.id, f);
    }
    const facts = Array.from(factMap.values()).slice(0, 5);
    const rows = (items.data || []) as Array<{
      id: string; category_key: string; content: string; occurred_at: string;
    }>;

    if (rows.length === 0 && facts.length === 0) {
      return {
        ok: true,
        result: { items: [], facts: [], count: 0 },
        text:
          `No stored memories found about "${topic}"${category ? ` in category ${category}` : ''}. ` +
          'Say so honestly and offer to remember it now — do not invent memories.',
      };
    }

    const parts: string[] = [];
    if (facts.length > 0) {
      parts.push(
        'Known facts: ' +
          facts.map((f) => `${f.fact_key.replace(/_/g, ' ')} = ${f.fact_value}`).join('; '),
      );
    }
    if (rows.length > 0) {
      parts.push(
        'Memories: ' +
          rows
            .slice(0, 6)
            .map((r) => `${dayPhrase(r.occurred_at)} [${r.category_key}]: ${snippet(r.content, 100)}`)
            .join(' | '),
      );
    }

    return {
      ok: true,
      result: {
        count: rows.length + facts.length,
        items: rows,
        facts,
      },
      text:
        `What I remember about "${topic}": ${parts.join('. ')}. ` +
        'Answer conversationally in the user\'s language using only this content.',
    };
  } catch (err) {
    return { ok: false, error: `recall_memory_about failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// get_memory_garden_summary — counts per garden category (VTID-01086 config
// + mapping), computed with per-category exact count queries.
// ---------------------------------------------------------------------------

export async function tool_get_memory_garden_summary(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_memory_garden_summary', id, true);
  if (gate) return gate;

  try {
    // Garden config (labels + order) and source→garden mapping. Both are
    // small lookup tables; failure falls back to raw category_key grouping.
    const [cfgRes, mapRes] = await Promise.all([
      sb
        .from('memory_garden_config')
        .select('category_key, label, display_order')
        .order('display_order', { ascending: true }),
      sb.from('memory_category_mapping').select('source_category, garden_category'),
    ]);

    const gardenLabels = new Map<string, string>();
    for (const c of (cfgRes.data || []) as Array<{ category_key: string; label: string }>) {
      gardenLabels.set(c.category_key, c.label);
    }
    const sourceToGarden = new Map<string, string>();
    for (const m of (mapRes.data || []) as Array<{ source_category: string; garden_category: string }>) {
      sourceToGarden.set(m.source_category, m.garden_category);
    }

    // One page of the user's category keys — grouped in JS. memory_items has
    // no GROUP BY via PostgREST, and the garden RPC is auth.uid()-scoped
    // (unavailable to the service-role client).
    const { data, error } = await sb
      .from('memory_items')
      .select('category_key')
      .eq('tenant_id', id.tenant_id)
      .eq('user_id', id.user_id)
      .limit(1000);
    if (error) return { ok: false, error: `Could not load memory summary: ${error.message}` };

    const rows = (data || []) as Array<{ category_key: string }>;
    if (rows.length === 0) {
      return {
        ok: true,
        result: { total: 0, categories: [] },
        text:
          'The Memory Garden is empty — nothing stored about the user yet. ' +
          'Explain that memories grow as they talk to Vitana, and offer to save something now.',
      };
    }

    const counts = new Map<string, number>();
    for (const r of rows) {
      const garden = sourceToGarden.get(r.category_key) ?? r.category_key;
      counts.set(garden, (counts.get(garden) ?? 0) + 1);
    }

    const categories = Array.from(counts.entries())
      .map(([key, count]) => ({
        category_key: key,
        label: gardenLabels.get(key) ?? key.replace(/_/g, ' '),
        count,
      }))
      .sort((a, b) => b.count - a.count);

    const spoken = categories
      .slice(0, 8)
      .map((c) => `${c.label}: ${c.count}`)
      .join(', ');

    return {
      ok: true,
      result: { total: rows.length, categories },
      text:
        `The Memory Garden holds ${rows.length} memories about the user across ` +
        `${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} — ${spoken}. ` +
        'Summarize warmly in the user\'s language; mention the biggest areas first.',
    };
  } catch (err) {
    return { ok: false, error: `get_memory_garden_summary failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// forget_memory — confirm-gated delete of ONE memory_items row.
// memory_items has no soft-delete column (VTID-01104), so after confirmation
// we hard-delete the row and record it in the memory_deletions ledger
// (VTID-01099) for the governance audit trail.
// ---------------------------------------------------------------------------

export async function tool_forget_memory(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('forget_memory', id, true);
  if (gate) return gate;

  const memoryId = String(args.memory_id ?? '').trim();
  if (!memoryId) {
    return { ok: false, error: 'forget_memory requires memory_id (use recall_memory_about to find it).' };
  }

  try {
    const { data, error } = await sb
      .from('memory_items')
      .select('id, category_key, content, occurred_at')
      .eq('id', memoryId)
      .eq('tenant_id', id.tenant_id)
      .eq('user_id', id.user_id)
      .maybeSingle();
    if (error) return { ok: false, error: `Could not look up that memory: ${error.message}` };
    if (!data) {
      return {
        ok: false,
        error: 'That memory was not found (it may already be deleted or belongs to another account).',
      };
    }

    const item = data as { id: string; category_key: string; content: string; occurred_at: string };
    const described = `"${snippet(item.content, 140)}" (${item.category_key}, ${dayPhrase(item.occurred_at)})`;

    if (args.confirm !== true) {
      return {
        ok: true,
        result: { requires_confirmation: true, memory_id: item.id, content: item.content },
        text:
          `Confirmation needed before deleting. The memory is: ${described}. ` +
          'Read it back and ask the user to confirm; only when they clearly say yes, ' +
          'call forget_memory again with confirm=true. Deletion is permanent.',
      };
    }

    const del = await sb
      .from('memory_items')
      .delete()
      .eq('id', memoryId)
      .eq('tenant_id', id.tenant_id)
      .eq('user_id', id.user_id);
    if (del.error) {
      return { ok: false, error: `Could not delete the memory: ${del.error.message}` };
    }

    // Governance ledger (VTID-01099) — best-effort; the delete already happened.
    try {
      await sb.from('memory_deletions').insert({
        tenant_id: id.tenant_id,
        user_id: id.user_id,
        entity_type: 'memory_item',
        entity_id: memoryId,
        cascade: { type: 'memory_item', note: 'deleted via ORB forget_memory voice tool' },
      });
    } catch (ledgerErr) {
      console.warn(
        `[forget_memory] memory_deletions ledger insert failed (non-fatal): ${(ledgerErr as Error).message}`,
      );
    }

    return {
      ok: true,
      result: { deleted: true, memory_id: memoryId },
      text: `Done — the memory ${described} has been permanently forgotten. Confirm briefly to the user.`,
    };
  } catch (err) {
    return { ok: false, error: `forget_memory failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const DIARY_MEMORY_TOOL_HANDLERS: Record<string, Handler> = {
  list_diary_entries: tool_list_diary_entries,
  get_diary_streak: tool_get_diary_streak,
  get_memory_timeline: tool_get_memory_timeline,
  recall_memory_about: tool_recall_memory_about,
  get_memory_garden_summary: tool_get_memory_garden_summary,
  forget_memory: tool_forget_memory,
};

export const DIARY_MEMORY_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'list_diary_entries',
    description: [
      "List the user's Daily Diary entries, newest first, optionally within a date window.",
      'CALL THIS WHEN the user says:',
      '  - "What did I write in my diary?" / "Was steht in meinem Tagebuch?"',
      '  - "Show my diary entries from last week" / "Zeig meine Tagebucheinträge"',
      '  - "What did I log yesterday?" / "Was habe ich gestern eingetragen?"',
      'Then summarize the entries naturally — do not read them verbatim or mention IDs.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Optional start date, YYYY-MM-DD (inclusive).' },
        date_to: { type: 'string', description: 'Optional end date, YYYY-MM-DD (inclusive).' },
        limit: { type: 'number', description: 'Max entries to return, 1-30. Omit for 10.' },
      },
      required: [],
    },
  },
  {
    name: 'get_diary_streak',
    description: [
      "Get the user's diary streak: current consecutive days with an entry plus their longest streak ever.",
      'CALL THIS WHEN the user asks:',
      '  - "What\'s my diary streak?" / "Wie lang ist meine Tagebuch-Serie?"',
      '  - "How many days in a row have I journaled?" / "Wie viele Tage am Stück?"',
      'Then celebrate an active streak, or encourage a restart if it broke.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_memory_timeline',
    description: [
      "Chronological timeline of what Vitana remembers: memory items, extracted facts, and diary entries, newest first.",
      'CALL THIS WHEN the user asks:',
      '  - "What happened last month?" / "Was ist letzten Monat passiert?"',
      '  - "Show my memory timeline" / "Zeig meine Erinnerungs-Zeitleiste"',
      '  - "What did we talk about in June?" / "Worüber haben wir im Juni gesprochen?"',
      'Then retell the timeline as a short narrative in the user\'s language.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Optional start date, YYYY-MM-DD (inclusive).' },
        date_to: { type: 'string', description: 'Optional end date, YYYY-MM-DD (inclusive).' },
        limit: { type: 'number', description: 'Max timeline entries, 1-40. Omit for 15.' },
      },
      required: [],
    },
  },
  {
    name: 'recall_memory_about',
    description: [
      'Search stored memories and facts about ONE specific topic, person, or thing.',
      'CALL THIS WHEN the user asks:',
      '  - "What do you know about my sister?" / "Was weißt du über meine Schwester?"',
      '  - "Do you remember my trip to Rome?" / "Erinnerst du dich an meine Rom-Reise?"',
      '  - "What did I tell you about my project?" / "Was habe ich dir über mein Projekt erzählt?"',
      'Answer ONLY from the returned content — never invent memories. If empty, say so and offer to remember it now.',
      'Optional category filter: personal_identity, health_wellness, lifestyle_routines, network_relationships,',
      'learning_knowledge, business_projects, finance_assets, location_environment, digital_footprint,',
      'values_aspirations, autopilot_context, future_plans, uncategorized.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The topic, person, or thing to recall (a word or short phrase).' },
        category: { type: 'string', description: 'Optional Memory Garden category key to narrow the search.' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'get_memory_garden_summary',
    description: [
      "Overview of the user's Memory Garden: how many memories are stored per category.",
      'CALL THIS WHEN the user asks:',
      '  - "What do you remember about me?" / "Was weißt du alles über mich?"',
      '  - "How full is my Memory Garden?" / "Wie sieht mein Memory Garden aus?"',
      '  - "What kind of things have you saved?" / "Was hast du über mich gespeichert?"',
      'Then summarize warmly: total memories and the biggest categories first.',
      'For details on a specific topic, use recall_memory_about instead.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'forget_memory',
    description: [
      'Permanently delete ONE stored memory, only after the user explicitly confirms.',
      'CALL THIS WHEN the user says:',
      '  - "Forget that" / "Vergiss das" / "Lösch diese Erinnerung"',
      '  - "Delete what you saved about X" / "Lösch, was du über X gespeichert hast"',
      'Flow: find the memory_id via recall_memory_about, call WITHOUT confirm first —',
      'the tool returns the memory text; read it back and ask the user to confirm.',
      'Only when they clearly say yes, call again with confirm=true. Deletion is permanent.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'The id of the memory item to delete (from recall_memory_about results).' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user explicitly confirmed the deletion.' },
      },
      required: ['memory_id'],
    },
  },
];
