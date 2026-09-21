#!/usr/bin/env node
/**
 * VTID-04236 — backfill per-locale translations of `nav_catalog_i18n`.
 *
 * `nav_catalog_i18n` has no separate source-of-truth table the way
 * `journey_checklist_translations` does (see
 * `scripts/journey/generate-checklist-translations.mjs`'s own header for
 * that contrast) — every locale, `en` included, is just a row in this same
 * table. `en` is used here as the translation SOURCE because it is the
 * canonical/reference locale this repo's own coverage RPC
 * (`ci_vital_systems_health()`, CLAUDE.md §3) already compares every other
 * GA locale against, and it has full coverage (291/291 as of 2026-09-21).
 *
 * Same Bedrock-based approach as the journey-checklist generator (VTID-04236
 * — Gemini is a forbidden dependency per CLAUDE.md ALWAYS 10a/10c, IF-THEN
 * 27). Idempotent: upserts on (catalog_id, lang). Re-running refreshes
 * content.
 *
 * Run it wherever the secrets + DB + `aws` CLI live (CI/Cloud Shell), NOT a
 * dev sandbox:
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... \
 *     node scripts/nav/generate-nav-catalog-translations.mjs \
 *       --locale=es,sr,fr,pl,pt,ru,tr,zh,ar [--limit=N] [--dry-run]
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
// Full GA locale set (supported_locales.status='ga', 2026-09-21) minus 'en'
// (the source) — 'de' IS a normal translated locale here (unlike the
// journey-checklist table), so it stays in the target set.
const SUPPORTED_LOCALES = ['de', 'es', 'sr', 'fr', 'pl', 'pt', 'ru', 'tr', 'zh', 'ar'];
const LOCALES = String(args.locale || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => SUPPORTED_LOCALES.includes(s));
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const DRY_RUN = Boolean(args['dry-run']);
const BEDROCK_MODEL_ID = process.env.BEDROCK_TRANSLATE_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6';
const BEDROCK_REGION = process.env.AWS_BEDROCK_REGION || process.env.AWS_REGION || 'eu-central-1';
const FORCE = Boolean(args.force);

const REST_TIMEOUT_MS = 20_000;
const BEDROCK_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE');
  process.exit(1);
}
if (LOCALES.length === 0) {
  console.error(`No valid --locale given (${SUPPORTED_LOCALES.join(',')})`);
  process.exit(1);
}

const LOCALE_NAME = {
  de: 'German (informal "du")',
  es: 'Spanish (Spain, informal "tú")',
  sr: 'Serbian (informal "ti")',
  fr: 'French (informal "tu")',
  pl: 'Polish (informal "ty")',
  pt: 'Portuguese (Brazil, informal "você")',
  ru: 'Russian (informal "ты")',
  tr: 'Turkish (informal "sen")',
  zh: 'Simplified Chinese',
  ar: 'Modern Standard Arabic',
};
const FIELDS = ['title', 'description', 'when_to_visit'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`REST ${path} → ${res.status} ${await res.text()}`);
  const body = await res.text();
  return body ? JSON.parse(body) : null;
}

/** Read the canonical 'en' rows — the translation source for this table. */
async function fetchCanonicalEntries() {
  const rows = await rest(`nav_catalog_i18n?select=catalog_id,title,description,when_to_visit&lang=eq.en&limit=5000`);
  return rows || [];
}

async function invokeBedrockClaude(prompt) {
  const dir = await mkdtemp(join(tmpdir(), 'bedrock-translate-'));
  const inPath = join(dir, 'in.json');
  const outPath = join(dir, 'out.json');
  try {
    await writeFile(
      inPath,
      JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1024,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
    );
    await execFileAsync(
      'aws',
      [
        'bedrock-runtime', 'invoke-model',
        '--region', BEDROCK_REGION,
        '--model-id', BEDROCK_MODEL_ID,
        '--body', `fileb://${inPath}`,
        outPath,
      ],
      { timeout: BEDROCK_TIMEOUT_MS },
    );
    const raw = await readFile(outPath, 'utf8');
    const data = JSON.parse(raw);
    return data?.content?.[0]?.text ?? '{}';
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Translate one nav_catalog entry's English fields into a locale via Bedrock. */
async function translateEntry(src, locale) {
  const payload = {};
  for (const col of FIELDS) if (src[col]) payload[col] = src[col];
  if (Object.keys(payload).length === 0) return {};

  const prompt = [
    `Translate the following English navigation-catalog strings for a longevity-community app into ${LOCALE_NAME[locale]}.`,
    `"title" is a short screen name, "description" is one sentence shown to the user, "when_to_visit" is an internal routing hint describing when an AI assistant should suggest this screen — keep it natural but functional.`,
    `Use the informal register/second person for user-facing text. Return ONLY a JSON object with the SAME keys, values translated. Do not add keys, markdown fences, or commentary — the response must be valid JSON and nothing else.`,
    JSON.stringify(payload),
  ].join('\n');

  if (DRY_RUN) return payload;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const text = await invokeBedrockClaude(prompt);
      const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
      return JSON.parse(cleaned);
    } catch (e) {
      const last = attempt === MAX_RETRIES;
      console.warn(`  ! ${locale} entry translate ${last ? 'FAILED (skipping)' : `retry ${attempt + 1}/${MAX_RETRIES}`}: ${e?.message || e}`);
      if (last) return null;
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

async function main() {
  const canonical = await fetchCanonicalEntries();
  const slice = canonical.slice(0, LIMIT);
  console.log(
    `Translating ${slice.length}/${canonical.length} nav_catalog entries → [${LOCALES.join(', ')}]${DRY_RUN ? ' (dry-run)' : ''} via Bedrock model ${BEDROCK_MODEL_ID}`,
  );

  for (const locale of LOCALES) {
    let done = new Set();
    if (!DRY_RUN && !FORCE) {
      const existing = await rest(`nav_catalog_i18n?select=catalog_id&lang=eq.${locale}&limit=5000`);
      done = new Set((existing || []).map((r) => r.catalog_id));
      if (done.size) console.log(`  [${locale}] resuming — ${done.size} already done, ${Math.max(0, slice.length - done.size)} to do`);
    }

    let upserts = 0;
    let skipped = 0;
    let failed = 0;
    for (const entry of slice) {
      if (done.has(entry.catalog_id)) { skipped++; continue; }
      const translated = await translateEntry(entry, locale);
      if (translated === null) { failed++; continue; }

      const row = { catalog_id: entry.catalog_id, lang: locale, updated_at: new Date().toISOString() };
      for (const col of FIELDS) row[col] = translated[col] ?? entry[col] ?? '';

      if (!DRY_RUN) {
        await rest('nav_catalog_i18n?on_conflict=catalog_id,lang', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(row),
        });
      }
      upserts++;
      if (upserts % 25 === 0) console.log(`  [${locale}] ${upserts}/${slice.length - done.size}`);
      await sleep(80);
    }
    console.log(
      `✓ [${locale}] ${upserts} ${DRY_RUN ? 'previewed' : 'upserted'}` +
        `${skipped ? `, ${skipped} skipped (already done)` : ''}` +
        `${failed ? `, ${failed} FAILED — re-run to retry` : ''}`,
    );
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
