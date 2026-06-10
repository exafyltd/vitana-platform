#!/usr/bin/env node
/**
 * BOOTSTRAP-GUIDED-JOURNEY-POPUP — backfill per-locale translations of the
 * Guided Journey curriculum into `journey_checklist_translations`.
 *
 * The curriculum is authored in GERMAN (source of truth). This script reads the
 * current PUBLISHED snapshot, asks Gemini to translate the six user-facing
 * fields per topic into the target locale(s), and upserts the result. The
 * gateway overlays these onto the German snapshot at read time (missing fields
 * fall back to German), so the Topic Explanation popup renders in the user's
 * language instead of mixing English labels with German body text.
 *
 * Run it wherever the secrets + DB live (CI/Cloud Shell), NOT a dev sandbox:
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... GEMINI_API_KEY=... \
 *     node scripts/journey/generate-checklist-translations.mjs \
 *       --locale=en,es,sr [--curriculum=v2] [--limit=N] [--dry-run]
 *
 * Idempotent: upserts on (topic_id, locale). Re-running refreshes content and
 * stamps source_version_id so a future re-publish can detect stale rows.
 *
 * Brand voice: informal register (du-form for DE source; tú for ES, ti for SR).
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CURRICULUM = String(args.curriculum || 'v2');
const LOCALES = String(args.locale || 'en,es,sr')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => ['en', 'es', 'sr'].includes(s));
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const DRY_RUN = Boolean(args['dry-run']);
const MODEL = process.env.GEMINI_TRANSLATE_MODEL || 'gemini-2.0-flash';

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE');
  process.exit(1);
}
if (!GEMINI_API_KEY && !DRY_RUN) {
  console.error('Missing GEMINI_API_KEY (or pass --dry-run)');
  process.exit(1);
}
if (LOCALES.length === 0) {
  console.error('No valid --locale given (en,es,sr)');
  process.exit(1);
}

const LOCALE_NAME = { en: 'English', es: 'Spanish (Spain, informal "tú")', sr: 'Serbian (informal "ti")' };
const FIELDS = [
  ['display_label', 'displayLabel'],
  ['short_description', 'shortDescription'],
  ['explanation_what_it_is', 'explanation.whatItIs'],
  ['explanation_user_benefit', 'explanation.userBenefit'],
  ['explanation_when_to_use', 'explanation.whenToUse'],
  ['explanation_try_this', 'explanation.tryThis'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PostgREST helper (service role). */
async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`REST ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
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

/** Translate one topic's German fields into a locale via Gemini (strict JSON). */
async function translateTopic(src, locale) {
  const payload = {};
  for (const [col] of FIELDS) if (src[col]) payload[col] = src[col];
  if (Object.keys(payload).length === 0) return {};

  const prompt = [
    `Translate the following German UI strings for a longevity-community app into ${LOCALE_NAME[locale]}.`,
    `Use the informal register/second person. Keep it concise and natural — these are short UI labels and explanations.`,
    `Return ONLY a JSON object with the SAME keys, values translated. Do not add keys or commentary.`,
    JSON.stringify(payload),
  ].join('\n');

  if (DRY_RUN) return payload; // echo source — lets you preview without spending tokens

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    console.warn(`  ! unparseable response for a topic; skipping`);
    return {};
  }
}

async function main() {
  const { versionId, topics } = await fetchCurrentSnapshot();
  const slice = topics.slice(0, LIMIT);
  console.log(
    `Translating ${slice.length}/${topics.length} topics → [${LOCALES.join(', ')}] from version ${versionId}${DRY_RUN ? ' (dry-run)' : ''}`,
  );

  for (const locale of LOCALES) {
    let upserts = 0;
    for (const topic of slice) {
      const src = sourceFields(topic);
      const translated = await translateTopic(src, locale);
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
      if (upserts % 25 === 0) console.log(`  [${locale}] ${upserts}/${slice.length}`);
      await sleep(80); // gentle rate-limit
    }
    console.log(`✓ [${locale}] ${upserts} topics ${DRY_RUN ? 'previewed' : 'upserted'}`);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
