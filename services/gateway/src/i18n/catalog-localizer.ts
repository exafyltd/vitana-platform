/**
 * Server-side catalog localization (translate-on-view + cache).
 *
 * The frontend i18n catalog (src/i18n) can only translate strings it knows at
 * build time. A whole class of user-visible text is authored in English and
 * lives in the gateway / DB instead — Did-You-Know tip copy, product titles &
 * descriptions, and (later) other finite catalogs. Served raw, that text shows
 * up in English on a German user's screen. This is the same bug the goal-plan
 * localizer (services/journey/goal-plan-i18n.ts) already solves for LLM-authored
 * plan text; this module generalizes the pattern so any finite catalog can opt
 * in without its own table or its own translation code.
 *
 * Mechanism, mirroring goal-plan-i18n:
 *   1. Source text is English ('en' by default). If the viewer's locale equals
 *      the source locale, return it unchanged — no work, no LLM call.
 *   2. Otherwise read cached translations from content_i18n keyed by
 *      (domain, item_key, locale). A cache row is only trusted when its
 *      source_hash still matches the live source copy — so re-wording a tip or
 *      a product description automatically invalidates the stale translation.
 *   3. Cache misses are translated in ONE batched worker LLM call, merged over
 *      the source per-field, and written back best-effort. A translation hiccup
 *      never blanks out copy: every field falls back to its English source.
 *
 * The cache table is shared across every domain, so adding a new surface is a
 * new `domain` string — never a new migration or a new code path.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { callViaRouter } from '../services/llm-router';
import { normalizeLocale, type GatewayLocale } from './catalog';

const LOG = '[catalog-i18n]';
const CACHE_TABLE = 'content_i18n';

export interface LocalizableRecord {
  /** Stable key for this row within its domain (tip_key, product id as text…). */
  id: string;
  /** Translatable source fields. Empty / missing values are left untouched. */
  fields: Record<string, string | null>;
}

export interface LocalizeOptions {
  /** Catalog namespace, e.g. 'dyk_tip' or 'product'. Partitions the cache. */
  domain: string;
  /** Language the source copy is authored in. Defaults to English. */
  sourceLocale?: GatewayLocale | string;
  /** Telemetry label forwarded to the LLM router (provider/model/latency logs). */
  service: string;
}

const LANGUAGE_NAMES: Record<GatewayLocale, string> = {
  de: 'German',
  en: 'English',
  es: 'Spanish',
  sr: 'Serbian',
};

// Brand voice is informal across every locale (DE never Sie/Ihr/Ihnen).
const REGISTER_HINT: Partial<Record<GatewayLocale, string>> = {
  de: ' Use the informal du-form (never Sie/Ihr/Ihnen).',
  sr: ' Use the informal ti-form.',
  es: ' Use the informal tú-form.',
};

// --- compact JSON extraction (worker models sometimes fence or prose-wrap) ---
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseLooseJson(text: string): any | null {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const obj = extractJsonObject(t);
  if (!obj) return null;
  try {
    return JSON.parse(obj.replace(/,\s*([}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/** Stable hash of a record's source fields — changes whenever the copy changes. */
function sourceHash(fields: Record<string, string | null>): string {
  const normalized: Record<string, string> = {};
  for (const k of Object.keys(fields).sort()) normalized[k] = fields[k] ?? '';
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex');
}

/** Only the non-empty string fields are worth translating. */
function translatableFields(fields: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

async function translateBatch(
  language: string,
  registerHint: string,
  service: string,
  items: Array<{ id: string; fields: Record<string, string> }>,
): Promise<Record<string, Record<string, string>> | null> {
  const system =
    `You are a professional translator for a longevity & wellness app. ` +
    `Translate every user-visible string value into ${language}, preserving tone: ` +
    `warm, short, motivating.${registerHint} Keep numbers, units, URLs and proper ` +
    `nouns (Vitana, Index, ORB, Maxina) intact. If a value is already in ${language}, ` +
    `return it unchanged. Do NOT translate, add, remove or reorder any "id" value or ` +
    `any JSON field key — echo keys and ids back exactly.`;
  const user =
    `Translate each item's field VALUES into ${language}. Respond with ONLY a JSON ` +
    `object — no markdown, no commentary — of exactly this shape:\n` +
    `{"items":[{"id": string, "fields": { <same keys>: <translated value> }}]}\n\n` +
    `Source JSON:\n${JSON.stringify({ items })}`;

  // Scale the output budget to the input so large product pages don't truncate.
  const approxChars = items.reduce(
    (n, it) => n + Object.values(it.fields).join(' ').length,
    0,
  );
  const maxTokens = Math.min(16000, Math.max(4000, Math.ceil(approxChars / 2) + 2000));

  const result = await callViaRouter('worker', user, {
    service,
    systemPrompt: system,
    maxTokens,
  });
  if (!result.ok || !result.text) {
    console.warn(`${LOG} translate call failed: ${result.error ?? 'no text'}`);
    return null;
  }
  const parsed = parseLooseJson(result.text);
  if (!parsed || !Array.isArray(parsed.items)) {
    console.warn(`${LOG} translate output unparseable (textLen=${result.text.length})`);
    return null;
  }
  const byId: Record<string, Record<string, string>> = {};
  for (const it of parsed.items) {
    if (it && typeof it.id === 'string' && it.fields && typeof it.fields === 'object') {
      const f: Record<string, string> = {};
      for (const [k, v] of Object.entries(it.fields)) {
        if (typeof v === 'string' && v.trim()) f[k] = v;
      }
      byId[it.id] = f;
    }
  }
  return byId;
}

/**
 * Localize a batch of catalog records into `targetLocaleRaw`. Returns a map of
 * id → localized fields, falling back to the source value for any field that
 * isn't (yet) translated. Never throws — a failure degrades to source copy.
 */
export async function localizeCatalogRecords(
  client: SupabaseClient,
  opts: LocalizeOptions,
  records: LocalizableRecord[],
  targetLocaleRaw: string,
): Promise<Map<string, Record<string, string | null>>> {
  const out = new Map<string, Record<string, string | null>>();
  for (const r of records) out.set(r.id, { ...r.fields });
  if (records.length === 0) return out;

  const target = normalizeLocale(targetLocaleRaw);
  const source = normalizeLocale(opts.sourceLocale ?? 'en');
  if (target === source) return out; // viewer reads the source language — no work.

  const language = LANGUAGE_NAMES[target] ?? 'English';
  const hashById = new Map(records.map((r) => [r.id, sourceHash(r.fields)]));

  // 1. Read cache; trust a row only when its source_hash still matches.
  const fresh = new Set<string>();
  try {
    const { data } = await client
      .from(CACHE_TABLE)
      .select('item_key, fields, source_hash')
      .eq('domain', opts.domain)
      .eq('locale', target)
      .in('item_key', records.map((r) => r.id));
    for (const row of (data as any[]) ?? []) {
      if (row.source_hash !== hashById.get(row.item_key)) continue; // stale copy
      const cached = (row.fields ?? {}) as Record<string, string>;
      const base = out.get(row.item_key)!;
      const merged: Record<string, string | null> = { ...base };
      for (const k of Object.keys(base)) {
        if (typeof cached[k] === 'string' && cached[k].trim()) merged[k] = cached[k];
      }
      out.set(row.item_key, merged);
      fresh.add(row.item_key);
    }
  } catch (e: any) {
    console.warn(`${LOG} cache read failed (continuing): ${e?.message}`);
  }

  // 2. Translate whatever is missing/stale in one batched call.
  const misses = records.filter((r) => !fresh.has(r.id));
  if (misses.length === 0) return out;

  const items = misses
    .map((r) => ({ id: r.id, fields: translatableFields(r.fields) }))
    .filter((it) => Object.keys(it.fields).length > 0);
  if (items.length === 0) return out;

  const translated = await translateBatch(
    language,
    REGISTER_HINT[target] ?? '',
    opts.service,
    items,
  );
  if (!translated) return out; // keep source copy on failure

  const upserts: any[] = [];
  for (const r of misses) {
    const tr = translated[r.id];
    if (!tr) continue;
    const base = out.get(r.id)!;
    const merged: Record<string, string | null> = { ...base };
    const cacheFields: Record<string, string> = {};
    for (const k of Object.keys(base)) {
      if (typeof tr[k] === 'string' && tr[k].trim()) {
        merged[k] = tr[k];
        cacheFields[k] = tr[k];
      }
    }
    out.set(r.id, merged);
    if (Object.keys(cacheFields).length > 0) {
      upserts.push({
        domain: opts.domain,
        item_key: r.id,
        locale: target,
        fields: cacheFields,
        source_hash: hashById.get(r.id),
      });
    }
  }

  // 3. Persist best-effort — caching is an optimization, never a correctness gate.
  if (upserts.length > 0) {
    try {
      await client
        .from(CACHE_TABLE)
        .upsert(upserts, { onConflict: 'domain,item_key,locale' });
    } catch (e: any) {
      console.warn(`${LOG} cache write failed (non-fatal): ${e?.message}`);
    }
  }

  return out;
}
