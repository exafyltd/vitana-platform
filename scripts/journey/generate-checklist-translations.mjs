#!/usr/bin/env node
/**
 * BOOTSTRAP-GUIDED-JOURNEY-POPUP / VTID-04236 — backfill per-locale
 * translations of the Guided Journey curriculum into
 * `journey_checklist_translations`.
 *
 * The curriculum is authored in GERMAN (source of truth). This script reads
 * the current PUBLISHED snapshot, asks Claude (via AWS Bedrock) to translate
 * the six user-facing fields per topic into the target locale(s), and
 * upserts the result. The gateway overlays these onto the German snapshot at
 * read time (missing fields fall back to German), so the Topic Explanation
 * popup renders in the user's language instead of mixing English labels with
 * German body text.
 *
 * VTID-04236: this script previously called Google's Gemini API directly
 * (`GEMINI_API_KEY`), which violates this repo's standing rule (CLAUDE.md
 * ALWAYS 10a/10c, IF-THEN 27 — no sanctioned Google dependency for LLM
 * routing/content generation) and hardcoded its locale allowlist to
 * en/es/sr only, silently dropping every other GA locale. It now calls
 * Claude on Bedrock via the AWS CLI (`aws bedrock-runtime invoke-model`),
 * the same invocation shape CLAUDE.md §2b documents as the verified way to
 * reach a real, invokable inference profile, and supports the full GA
 * locale set.
 *
 * Run it wherever the secrets + DB + `aws` CLI live (CI/Cloud Shell), NOT a
 * dev sandbox:
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... \
 *     node scripts/journey/generate-checklist-translations.mjs \
 *       --locale=en,es,sr,tr,zh,ar,fr,pl,pt,ru [--curriculum=v2] [--limit=N] [--dry-run]
 *
 * Idempotent: upserts on (topic_id, locale). Re-running refreshes content and
 * stamps source_version_id so a future re-publish can detect stale rows.
 *
 * Brand voice: informal register (du-form for DE source; the target-locale
 * equivalent for each language, named per-locale below).
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
const CURRICULUM = String(args.curriculum || 'v2');
// Full GA locale set (supported_locales.status='ga', 2026-09-21) minus the
// two source languages (de is the curriculum source; en is also a normal
// target here since the curriculum itself is authored in German).
const SUPPORTED_LOCALES = ['en', 'es', 'sr', 'fr', 'pl', 'pt', 'ru', 'tr', 'zh', 'ar'];
const LOCALES = String(args.locale || 'en,es,sr')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => SUPPORTED_LOCALES.includes(s));
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const DRY_RUN = Boolean(args['dry-run']);
// Cross-region inference profile ID — see CLAUDE.md §2b. eu.anthropic.claude-sonnet-4-6
// is one of the confirmed-invokable profiles (not merely ACTIVE in the listing).
const BEDROCK_MODEL_ID = process.env.BEDROCK_TRANSLATE_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6';
const BEDROCK_REGION = process.env.AWS_BEDROCK_REGION || process.env.AWS_REGION || 'eu-central-1';
const FORCE = Boolean(args.force); // re-translate even topics that already exist

// Network resilience: no call may hang the whole run.
const REST_TIMEOUT_MS = 20_000;
const BEDROCK_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2; // per call, with backoff

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE');
  process.exit(1);
}
if (LOCALES.length === 0) {
  console.error(`No valid --locale given (${SUPPORTED_LOCALES.join(',')})`);
  process.exit(1);
}

const LOCALE_NAME = {
  en: 'English',
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
const FIELDS = [
  ['display_label', 'displayLabel'],
  ['short_description', 'shortDescription'],
  ['explanation_what_it_is', 'explanation.whatItIs'],
  ['explanation_user_benefit', 'explanation.userBenefit'],
  ['explanation_when_to_use', 'explanation.whenToUse'],
  ['explanation_try_this', 'explanation.tryThis'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PostgREST helper (service role). Times out so a stalled call can't hang the run. */
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
  // PostgREST returns an EMPTY body for 204 and for return=minimal upserts —
  // res.json() would throw "Unexpected end of JSON input". Parse only non-empty.
  const body = await res.text();
  return body ? JSON.parse(body) : null;
}

/** Read the current published snapshot (array of topics). */
async function fetchCurrentSnapshot() {
  const rows = await rest(
    `journey_checklist_versions?select=id,snapshot&curriculum_version=eq.${CURRICULUM}&is_current=is.true&limit=1`,
  );
  if (!rows || rows.length === 0) throw new Error(`No current published version for curriculum ${CURRICULUM}`);
  return { versionId: rows[0].id, topics: Array.isArray(rows[0].snapshot) ? rows[0].snapshot : [] };
}

function sourceFields(topic) {
  return {
    display_label: topic.displayLabel ?? null,
    short_description: topic.shortDescription ?? null,
    explanation_what_it_is: topic.explanation?.whatItIs ?? null,
    explanation_user_benefit: topic.explanation?.userBenefit ?? null,
    explanation_when_to_use: topic.explanation?.whenToUse ?? null,
    explanation_try_this: topic.explanation?.tryThis ?? null,
  };
}

/**
 * Invoke Claude on Bedrock via the AWS CLI (VTID-04236 — replaces the
 * former direct Gemini call). Shells out rather than adding an
 * `@aws-sdk/client-bedrock-runtime` dependency to this standalone script:
 * `aws bedrock-runtime invoke-model` is the exact invocation CLAUDE.md §2b
 * documents and trusts, and every environment this script targets
 * (CI/Cloud Shell with AWS deploy credentials) already has the AWS CLI as
 * an established prerequisite.
 */
async function invokeBedrockClaude(prompt) {
  const dir = await mkdtemp(join(tmpdir(), 'bedrock-translate-'));
  const inPath = join(dir, 'in.json');
  const outPath = join(dir, 'out.json');
  try {
    await writeFile(
      inPath,
      JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 2048,
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
    const text = data?.content?.[0]?.text ?? '{}';
    return text;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Translate one topic's German fields into a locale via Bedrock (strict JSON). */
async function translateTopic(src, locale) {
  const payload = {};
  for (const [col] of FIELDS) if (src[col]) payload[col] = src[col];
  if (Object.keys(payload).length === 0) return {};

  const prompt = [
    `Translate the following German UI strings for a longevity-community app into ${LOCALE_NAME[locale]}.`,
    `Use the informal register/second person. Keep it concise and natural — these are short UI labels and explanations.`,
    `Return ONLY a JSON object with the SAME keys, values translated. Do not add keys, markdown fences, or commentary — the response must be valid JSON and nothing else.`,
    JSON.stringify(payload),
  ].join('\n');

  if (DRY_RUN) return payload; // echo source — lets you preview without spending tokens

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const text = await invokeBedrockClaude(prompt);
      const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
      return JSON.parse(cleaned);
    } catch (e) {
      const last = attempt === MAX_RETRIES;
      console.warn(`  ! ${locale} topic translate ${last ? 'FAILED (skipping)' : `retry ${attempt + 1}/${MAX_RETRIES}`}: ${e?.message || e}`);
      if (last) return null;
      await sleep(1000 * (attempt + 1)); // 1s, 2s backoff
    }
  }
  return null;
}

async function main() {
  const { versionId, topics } = await fetchCurrentSnapshot();
  const slice = topics.slice(0, LIMIT);
  console.log(
    `Translating ${slice.length}/${topics.length} topics → [${LOCALES.join(', ')}] from version ${versionId}${DRY_RUN ? ' (dry-run)' : ''} via Bedrock model ${BEDROCK_MODEL_ID}`,
  );

  for (const locale of LOCALES) {
    // Resume: skip topics already translated for this locale (unless --force),
    // so a re-run after an interruption only fills the gaps.
    let done = new Set();
    if (!DRY_RUN && !FORCE) {
      // Fetch all already-translated ids for this locale (robust — no giant
      // in.() URL). limit high enough for the full curriculum.
      const existing = await rest(
        `journey_checklist_translations?select=topic_id&locale=eq.${locale}&limit=5000`,
      );
      done = new Set((existing || []).map((r) => r.topic_id));
      if (done.size) console.log(`  [${locale}] resuming — ${done.size} already done, ${Math.max(0, slice.length - done.size)} to do`);
    }

    let upserts = 0;
    let skipped = 0;
    let failed = 0;
    for (const topic of slice) {
      if (done.has(topic.topicId)) { skipped++; continue; }
      const src = sourceFields(topic);
      const translated = await translateTopic(src, locale);
      if (translated === null) { failed++; continue; } // skip; a re-run will retry it

      const row = { topic_id: topic.topicId, locale, source_version_id: versionId, updated_at: new Date().toISOString() };
      for (const [col] of FIELDS) row[col] = translated[col] ?? null;

      if (!DRY_RUN) {
        await rest('journey_checklist_translations?on_conflict=topic_id,locale', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(row),
        });
      }
      upserts++;
      if (upserts % 25 === 0) console.log(`  [${locale}] ${upserts}/${slice.length - done.size}`);
      await sleep(80); // gentle rate-limit
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
