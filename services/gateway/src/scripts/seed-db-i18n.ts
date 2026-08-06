/**
 * VTID-03515 — one command to bring a language to full parity on DB-backed
 * content.
 *
 *   npx ts-node src/scripts/seed-db-i18n.ts --locale=fr --apply
 *   npx ts-node src/scripts/seed-db-i18n.ts --locale=fr,pt,ru,pl        # dry run
 *   npx ts-node src/scripts/seed-db-i18n.ts --all-ga --check            # CI gate
 *   npx ts-node src/scripts/seed-db-i18n.ts --locale=fr --from-artifact --apply
 *
 * WHY IT IS SHAPED THIS WAY
 *
 * The previous state of the art here was `generate-checklist-translations.mjs`:
 * read the DB, ask Gemini, write the DB. It works, and it has three properties
 * that make "add the next language" cost the same as the last one did.
 *
 *  - The output existed ONLY in the database. Nothing was reviewable in a PR,
 *    nothing was diffable, and re-seeding a rebuilt database meant paying for
 *    every translation again. Here, translations are committed artifacts under
 *    `data/db-i18n/` and the database is downstream of them. `--from-artifact`
 *    replays a locale with zero LLM spend — which is also the answer to "how do
 *    we repopulate Aurora after the migration".
 *  - Its locale list was hardcoded in three places (the script, the DB CHECK
 *    constraint, and the gateway catalog). Here it comes from
 *    `supported_locales`; adding a language is an INSERT.
 *  - It had no staleness signal finer than the published version, so a topic
 *    edited within one version left every translation looking current. Here
 *    each entry carries `source_sha` and only changed units are re-translated —
 *    which is what makes the second run of a language cheap.
 *
 * The default is a DRY RUN. `--apply` is required to write.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getSupabase } from '../lib/supabase';
import {
  createDbI18nRepository,
  resolveDbI18nTarget,
  DbI18nRepositoryError,
  type DbI18nRepository,
  type SourceUnit,
  type SupportedLocaleRow,
} from '../services/db-i18n/db-i18n-repository';
import {
  SURFACES,
  SOURCE_LOCALE,
  getSurface,
  sourceSha,
  type SurfaceDef,
} from '../services/db-i18n/surfaces';
import { translateUnits, type TranslateUnit } from '../services/db-i18n/translator';

// Repo root, four levels up from services/gateway/src/scripts.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const ARTIFACT_ROOT = join(REPO_ROOT, 'data', 'db-i18n');

interface ArtifactEntry {
  source_sha: string;
  fields: Record<string, string>;
}
interface Artifact {
  surface: string;
  locale: string;
  source_locale: string;
  generated_at: string;
  /** Field order at generation time — the hash contract (see `sourceSha`). */
  field_order: string[];
  entries: Record<string, ArtifactEntry>;
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
) as Record<string, string | true>;

const APPLY = Boolean(args.apply);
const CHECK_ONLY = Boolean(args.check);
const FROM_ARTIFACT = Boolean(args['from-artifact']);
const CURRICULUM = String(args.curriculum ?? 'v2');
const BATCH = args.batch ? Number(args.batch) : 15;

function artifactPath(surface: string, locale: string): string {
  return join(ARTIFACT_ROOT, surface, `${locale}.json`);
}

function loadArtifact(surface: SurfaceDef, locale: string): Artifact {
  const p = artifactPath(surface.id, locale);
  if (!existsSync(p)) {
    return {
      surface: surface.id,
      locale,
      source_locale: SOURCE_LOCALE,
      generated_at: new Date().toISOString(),
      field_order: [...surface.fields],
      entries: {},
    };
  }
  const doc = JSON.parse(readFileSync(p, 'utf8')) as Artifact;
  // A field-order change silently invalidates every hash. Say so rather than
  // reporting the whole locale as drifted with no explanation.
  const stored = (doc.field_order ?? []).join(',');
  const current = surface.fields.join(',');
  if (stored && stored !== current) {
    console.warn(
      `[db-i18n] ${surface.id}/${locale}: field order changed (${stored} -> ${current}).\n` +
        `          Every stored source_sha is invalidated; this run re-translates the surface.`,
    );
    doc.entries = {};
  }
  doc.field_order = [...surface.fields];
  return doc;
}

function saveArtifact(doc: Artifact): void {
  const p = artifactPath(doc.surface, doc.locale);
  mkdirSync(dirname(p), { recursive: true });
  // Sorted keys so a re-run with no content change produces no diff.
  const sortedEntries: Record<string, ArtifactEntry> = {};
  for (const k of Object.keys(doc.entries).sort()) sortedEntries[k] = doc.entries[k];
  writeFileSync(p, JSON.stringify({ ...doc, entries: sortedEntries }, null, 2) + '\n');
}

/** Split source units into fresh / stale / already-current against an artifact. */
function planWork(surface: SurfaceDef, source: SourceUnit[], artifact: Artifact) {
  const missing: SourceUnit[] = [];
  const stale: SourceUnit[] = [];
  const current: SourceUnit[] = [];
  for (const unit of source) {
    const sha = sourceSha(unit.fields, surface.fields);
    const have = artifact.entries[unit.key];
    if (!have) missing.push(unit);
    else if (have.source_sha !== sha) stale.push(unit);
    else current.push(unit);
  }
  return { missing, stale, current };
}

async function resolveLocales(repo: DbI18nRepository): Promise<SupportedLocaleRow[]> {
  let registry: SupportedLocaleRow[];
  try {
    registry = await repo.listSupportedLocales();
  } catch (err) {
    if (err instanceof DbI18nRepositoryError) throw err;
    throw err;
  }
  if (registry.length === 0) {
    throw new Error(
      'supported_locales is empty — apply migration ' +
        '20260806090000_VTID_03515_db_i18n_locale_registry.sql first.',
    );
  }
  const wanted = args['all-ga']
    ? registry.filter((l) => l.status === 'ga')
    : args.all
      ? registry.filter((l) => l.status === 'ga' || l.status === 'beta')
      : String(args.locale ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((code) => {
            const row = registry.find((l) => l.code === code);
            if (!row) {
              throw new Error(
                `Locale ${JSON.stringify(code)} is not in supported_locales. ` +
                  `Add it there first — that INSERT is the whole "add a language" step. ` +
                  `Known: ${registry.map((l) => l.code).join(', ')}`,
              );
            }
            return row;
          });

  // German is the source for both surfaces and is never written to either
  // translation table; seeding it would create a divergent second copy.
  return wanted.filter((l) => {
    if (l.code === SOURCE_LOCALE) {
      console.log(`[db-i18n] skipping '${SOURCE_LOCALE}' — it is the authored source, not a translation`);
      return false;
    }
    return true;
  });
}

async function main(): Promise<void> {
  const target = resolveDbI18nTarget();
  const supabase = target === 'supabase' ? getSupabase() : null;
  const repo = createDbI18nRepository(supabase, process.env);

  console.log(`[db-i18n] target=${repo.target} apply=${APPLY} from-artifact=${FROM_ARTIFACT}`);

  const locales = await resolveLocales(repo);
  if (locales.length === 0) {
    console.error('[db-i18n] no locales selected — pass --locale=<codes>, --all-ga or --all');
    process.exit(2);
  }

  const surfaceIds = args.surface
    ? String(args.surface).split(',').map((s) => s.trim())
    : SURFACES.map((s) => s.id);
  const surfaces = surfaceIds.map(getSurface);

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || '';
  let hadFailures = false;
  let hadGaps = false;

  for (const surface of surfaces) {
    const source = await surface.loadSource(repo, { curriculumVersion: CURRICULUM });
    console.log(`\n=== ${surface.label} (${surface.id}) — ${source.length} source units ===`);
    if (source.length === 0) {
      console.warn(`[db-i18n] ${surface.id}: no source content found; nothing to translate`);
      continue;
    }

    for (const locale of locales) {
      const artifact = loadArtifact(surface, locale.code);
      const { missing, stale, current } = planWork(surface, source, artifact);
      const todo = FROM_ARTIFACT ? [] : [...missing, ...stale];

      console.log(
        `  ${locale.code.padEnd(3)} ${String(current.length).padStart(4)} current, ` +
          `${String(missing.length).padStart(4)} missing, ${String(stale.length).padStart(4)} stale` +
          (FROM_ARTIFACT ? '  (replaying artifact, no translation)' : ''),
      );

      if (todo.length > 0) {
        if (CHECK_ONLY) {
          hadGaps = true;
          continue;
        }
        if (!apiKey) {
          console.error(
            `[db-i18n] ${surface.id}/${locale.code}: ${todo.length} unit(s) need translating but ` +
              `no GEMINI_API_KEY / GOOGLE_GEMINI_API_KEY is set.`,
          );
          hadFailures = true;
          continue;
        }
        const units: TranslateUnit[] = todo.map((u) => ({ key: u.key, fields: u.fields }));
        const { translated, failures } = await translateUnits(
          units,
          {
            apiKey,
            languageName: locale.english_name,
            informalHint: locale.informal_hint,
            brief: surface.translatorBrief,
          },
          surface.requiredFields,
          BATCH,
        );
        for (const u of todo) {
          const fields = translated.get(u.key);
          if (!fields) continue;
          artifact.entries[u.key] = { source_sha: sourceSha(u.fields, surface.fields), fields };
        }
        if (failures.length > 0) {
          hadFailures = true;
          console.error(`    ${failures.length} unit(s) failed validation:`);
          for (const f of failures.slice(0, 10)) console.error(`      ${f.key}: ${f.reason}`);
          if (failures.length > 10) console.error(`      ...and ${failures.length - 10} more`);
        }
        artifact.generated_at = new Date().toISOString();
        saveArtifact(artifact);
        console.log(`    wrote ${artifactPath(surface.id, locale.code)}`);
      }

      // Prune entries whose source unit no longer exists (screen deleted, topic
      // dropped from the published snapshot). Left in place they would be
      // re-upserted forever against a dangling key — and for the checklist that
      // is a foreign-key-less orphan nothing will ever read.
      const liveKeys = new Set(source.map((u) => u.key));
      const orphans = Object.keys(artifact.entries).filter((k) => !liveKeys.has(k));
      if (orphans.length > 0 && !CHECK_ONLY) {
        for (const k of orphans) delete artifact.entries[k];
        saveArtifact(artifact);
        console.log(`    pruned ${orphans.length} orphaned entr${orphans.length === 1 ? 'y' : 'ies'}`);
      }

      if (!APPLY) continue;

      const rows = source
        .filter((u) => artifact.entries[u.key])
        .map((u) =>
          surface.buildRow({
            unit: u,
            locale: locale.code,
            translated: artifact.entries[u.key].fields,
            sha: artifact.entries[u.key].source_sha,
          }),
        );
      if (rows.length === 0) {
        console.warn(`    nothing to apply for ${locale.code}`);
        continue;
      }
      const written = await surface.upsert(repo, rows);
      console.log(`    applied ${written} row(s) to ${surface.table} (${locale.code})`);
    }
  }

  if (CHECK_ONLY && hadGaps) {
    console.error(
      '\n[db-i18n] PARITY GAP — one or more locales are missing or stale on a DB content surface.\n' +
        '          Run without --check to translate, then re-run with --apply.',
    );
    process.exit(1);
  }
  if (hadFailures) {
    console.error('\n[db-i18n] finished WITH FAILURES — see above. Artifacts hold what succeeded.');
    process.exit(1);
  }
  console.log('\n[db-i18n] done.');
}

main().catch((err) => {
  if (err instanceof DbI18nRepositoryError) {
    console.error(`\n[db-i18n] ${err.operation} failed:\n${err.message}`);
    process.exit(1);
  }
  console.error('[db-i18n] fatal:', err);
  process.exit(1);
});
