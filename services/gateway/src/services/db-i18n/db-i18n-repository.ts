/**
 * VTID-03515 — write seam for DB-backed user-visible content translations.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two tables hold user-visible text that never passes through `src/i18n/`:
 * `nav_catalog_i18n` (Navigator screen titles/descriptions) and
 * `journey_checklist_translations` (My Journey curriculum). Seeding them for a
 * new language is the last manual step in adding a locale.
 *
 * The obvious implementation — a script that calls `supabase.from().upsert()` —
 * would be a fourth thing to rewrite at the Aurora cutover, on top of the 2,480
 * call sites `docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md` already counts. So the
 * seeding pipeline writes through this seam instead, following the B1 pattern
 * established by `specialists/specialists-repository.ts` (VTID-03498): today
 * every method wraps supabase-js and behaves identically; at cutover only the
 * adapter below changes.
 *
 * TARGET SELECTION
 * ----------------
 * `DB_I18N_TARGET=supabase|aurora`, default `supabase` — the same
 * deliberate-opt-in shape as `TTS_PROVIDER` (§2c), `IMAGE_PROVIDER` (§2d) and
 * `PUBLISH_TARGET_CLOUD` (§1b). Deploying this changes nothing.
 *
 * `aurora` is WIRED BUT NOT IMPLEMENTABLE YET, and it fails loudly rather than
 * falling back. Three independent facts make a silent fallback the wrong
 * behaviour here:
 *
 *   1. The gateway has no PostgreSQL driver in its dependency tree at all — it
 *      speaks HTTP to PostgREST and never opens a Postgres connection. There is
 *      no connection to configure.
 *   2. Aurora is a DMS *replication target* of Supabase. Writing to it directly
 *      is the dual-writer hazard `SUPABASE-TO-AURORA-MIGRATION-PLAN.md` records
 *      as "Option C — the one to argue against", and is why `oasis-projector`
 *      was excluded from the VTID-03419 cutover.
 *   3. That plan's Phase 0 gate is open: DMS showed ~154,000 silently-dropped
 *      row applies and the reconciliation has never been done. Aurora currently
 *      holds a partial copy of unknown quality.
 *
 * A quiet fallback to Supabase would mean an operator who set
 * `DB_I18N_TARGET=aurora` believes the seed landed in Aurora when it landed in
 * Supabase — the exact class of invisible failure as VTID-03480's `ok:false`.
 * So the Aurora adapter throws, and the message names the blocker.
 *
 * CONTRACT
 * --------
 *  - Writes are idempotent upserts on the natural key; re-running is safe.
 *  - Any database error throws `DbI18nRepositoryError`. Callers do not
 *    destructure `{ error }` tuples, so a failed write cannot be mistaken for
 *    an empty one.
 *  - Reads return `[]` when genuinely absent, and throw when the read failed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export class DbI18nRepositoryError extends Error {
  constructor(
    message: string,
    readonly operation: string,
  ) {
    super(message);
    this.name = 'DbI18nRepositoryError';
  }
}

export type DbI18nTarget = 'supabase' | 'aurora';

/** Read at call time, not module load, so a task-def change needs no restart. */
export function resolveDbI18nTarget(env: NodeJS.ProcessEnv = process.env): DbI18nTarget {
  const raw = (env.DB_I18N_TARGET ?? '').trim().toLowerCase();
  if (raw === 'aurora') return 'aurora';
  if (raw === 'supabase' || raw === '') return 'supabase';
  // Unrecognised value: say so and use the safe default rather than guessing.
  console.warn(`[db-i18n] unrecognised DB_I18N_TARGET=${JSON.stringify(raw)} — using 'supabase'`);
  return 'supabase';
}

/**
 * Why `aurora` cannot serve a write yet. Exported so the seeding CLI can print
 * the reason instead of a stack trace, and so a test can assert the wording
 * still names the real blocker rather than a generic "not implemented".
 */
export const AURORA_TARGET_BLOCKER = [
  'DB_I18N_TARGET=aurora is wired but cannot execute yet.',
  '',
  '  1. The gateway has no PostgreSQL driver (no `pg` in services/gateway/package.json).',
  '     It speaks HTTP to PostgREST; Aurora does not implement that protocol.',
  '  2. Aurora is the DMS replication TARGET of Supabase. A direct write is the',
  '     dual-writer hazard rejected as "Option C" in',
  '     docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md.',
  '  3. That plan\'s Phase 0 gate is open: ~154,000 silently-dropped DMS row',
  '     applies (VTID-03419) are still unreconciled.',
  '',
  'Unblocking is Phase 0 + B1 of that plan, not a change to this file.',
  'Until then the pipeline still produces and validates the translation',
  'artifacts; only the apply step is blocked. Re-run apply with',
  'DB_I18N_TARGET=supabase to land content on the database production reads.',
].join('\n');

// -----------------------------------------------------------------------------
// Row shapes — mirror the DB columns exactly (snake_case), no mapping layer.
// -----------------------------------------------------------------------------

export interface NavCatalogI18nRow {
  catalog_id: string;
  lang: string;
  title: string;
  description: string;
  when_to_visit: string;
  /** VTID-03515 — hash of the source text this was translated from. */
  source_sha?: string | null;
}

export interface ChecklistTranslationRow {
  topic_id: string;
  locale: string;
  display_label: string | null;
  short_description: string | null;
  explanation_what_it_is: string | null;
  explanation_user_benefit: string | null;
  explanation_when_to_use: string | null;
  explanation_try_this: string | null;
  source_version_id?: string | null;
  source_sha?: string | null;
}

export interface SupportedLocaleRow {
  code: string;
  english_name: string;
  informal_hint: string;
  status: 'ga' | 'beta' | 'draft' | 'legacy';
}

/** What a coverage audit needs: which keys exist, and what they were made from. */
export interface CoverageEntry {
  key: string;
  source_sha: string | null;
}

/**
 * One unit of translatable source content, surface-agnostic.
 *
 * `key` is the natural key within its surface (a nav `catalog_id`, a checklist
 * `topic_id`). `fields` maps DB column → source text. Keeping this generic is
 * what lets one pipeline serve both surfaces and any third one added later.
 */
export interface SourceUnit {
  key: string;
  fields: Record<string, string>;
  /** Surface-specific provenance carried onto the written row (e.g. version id). */
  meta?: Record<string, string | null>;
}

export interface DbI18nRepository {
  readonly target: DbI18nTarget;
  listSupportedLocales(): Promise<SupportedLocaleRow[]>;
  upsertNavCatalogI18n(rows: NavCatalogI18nRow[]): Promise<number>;
  upsertChecklistTranslations(rows: ChecklistTranslationRow[]): Promise<number>;
  navCatalogCoverage(lang: string): Promise<CoverageEntry[]>;
  checklistCoverage(locale: string): Promise<CoverageEntry[]>;
  /** German source rows for the Navigator catalog (active entries only). */
  navCatalogSource(): Promise<SourceUnit[]>;
  /** German source rows from the CURRENT PUBLISHED curriculum snapshot. */
  checklistSource(curriculumVersion: string): Promise<SourceUnit[]>;
}

/**
 * Upserts are chunked. PostgREST rejects very large request bodies, and a
 * 291-row nav catalog times 8 locales is well past a comfortable single
 * statement. 200 keeps each request small enough to retry cheaply.
 */
const CHUNK = 200;

function chunked<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

class SupabaseDbI18nRepository implements DbI18nRepository {
  readonly target = 'supabase' as const;

  constructor(private readonly client: SupabaseClient) {}

  async listSupportedLocales(): Promise<SupportedLocaleRow[]> {
    const { data, error } = await this.client
      .from('supported_locales')
      .select('code, english_name, informal_hint, status')
      .order('code');
    if (error) throw new DbI18nRepositoryError(error.message, 'listSupportedLocales');
    return (data ?? []) as SupportedLocaleRow[];
  }

  async upsertNavCatalogI18n(rows: NavCatalogI18nRow[]): Promise<number> {
    let written = 0;
    for (const batch of chunked(rows)) {
      const { error } = await this.client
        .from('nav_catalog_i18n')
        .upsert(batch, { onConflict: 'catalog_id,lang' });
      if (error) throw new DbI18nRepositoryError(error.message, 'upsertNavCatalogI18n');
      written += batch.length;
    }
    return written;
  }

  async upsertChecklistTranslations(rows: ChecklistTranslationRow[]): Promise<number> {
    let written = 0;
    for (const batch of chunked(rows)) {
      const { error } = await this.client
        .from('journey_checklist_translations')
        .upsert(batch, { onConflict: 'topic_id,locale' });
      if (error) throw new DbI18nRepositoryError(error.message, 'upsertChecklistTranslations');
      written += batch.length;
    }
    return written;
  }

  async navCatalogCoverage(lang: string): Promise<CoverageEntry[]> {
    const { data, error } = await this.client
      .from('nav_catalog_i18n')
      .select('catalog_id, source_sha')
      .eq('lang', lang);
    if (error) throw new DbI18nRepositoryError(error.message, 'navCatalogCoverage');
    return (data ?? []).map((r: { catalog_id: string; source_sha: string | null }) => ({
      key: r.catalog_id,
      source_sha: r.source_sha ?? null,
    }));
  }

  async checklistCoverage(locale: string): Promise<CoverageEntry[]> {
    const { data, error } = await this.client
      .from('journey_checklist_translations')
      .select('topic_id, source_sha')
      .eq('locale', locale);
    if (error) throw new DbI18nRepositoryError(error.message, 'checklistCoverage');
    return (data ?? []).map((r: { topic_id: string; source_sha: string | null }) => ({
      key: r.topic_id,
      source_sha: r.source_sha ?? null,
    }));
  }

  async navCatalogSource(): Promise<SourceUnit[]> {
    const { data: cat, error: catErr } = await this.client
      .from('nav_catalog')
      .select('id, screen_id')
      .eq('is_active', true);
    if (catErr) throw new DbI18nRepositoryError(catErr.message, 'navCatalogSource:catalog');
    const active = (cat ?? []) as { id: string; screen_id: string }[];
    if (active.length === 0) return [];

    // German is the source of truth. English is read too — solely as a fallback
    // for entries added through the admin UI in English with no German row yet.
    // Translating those from English is a pivot, not ideal, but it is strictly
    // better than emitting an empty title, and the audit reports the count.
    const { data: i18n, error: i18nErr } = await this.client
      .from('nav_catalog_i18n')
      .select('catalog_id, lang, title, description, when_to_visit')
      .in('lang', ['de', 'en']);
    if (i18nErr) throw new DbI18nRepositoryError(i18nErr.message, 'navCatalogSource:i18n');

    const byId = new Map<string, Record<string, NavCatalogI18nRow>>();
    for (const r of (i18n ?? []) as NavCatalogI18nRow[]) {
      if (!byId.has(r.catalog_id)) byId.set(r.catalog_id, {});
      byId.get(r.catalog_id)![r.lang] = r;
    }

    const out: SourceUnit[] = [];
    for (const entry of active) {
      const langs = byId.get(entry.id);
      const src = langs?.de ?? langs?.en;
      if (!src) continue; // no source text at all — nothing to translate from
      out.push({
        key: entry.id,
        fields: {
          title: src.title ?? '',
          description: src.description ?? '',
          when_to_visit: src.when_to_visit ?? '',
        },
        meta: { screen_id: entry.screen_id, source_lang: langs?.de ? 'de' : 'en' },
      });
    }
    return out;
  }

  async checklistSource(curriculumVersion: string): Promise<SourceUnit[]> {
    // The PUBLISHED snapshot, never the working draft: translating an
    // unpublished draft would ship curriculum text to users in seven languages
    // that no German user can see yet.
    const { data, error } = await this.client
      .from('journey_checklist_versions')
      .select('id, snapshot')
      .eq('curriculum_version', curriculumVersion)
      .eq('is_current', true)
      .maybeSingle();
    if (error) throw new DbI18nRepositoryError(error.message, 'checklistSource');
    const row = data as { id: string; snapshot: unknown } | null;
    if (!row || !Array.isArray(row.snapshot)) return [];

    type Snap = {
      topicId: string;
      displayLabel?: string;
      shortDescription?: string;
      explanation?: {
        whatItIs?: string;
        userBenefit?: string;
        whenToUse?: string;
        tryThis?: string;
      };
    };

    return (row.snapshot as Snap[])
      .filter((t) => t && typeof t.topicId === 'string')
      .map((t) => ({
        key: t.topicId,
        fields: {
          display_label: t.displayLabel ?? '',
          short_description: t.shortDescription ?? '',
          explanation_what_it_is: t.explanation?.whatItIs ?? '',
          explanation_user_benefit: t.explanation?.userBenefit ?? '',
          explanation_when_to_use: t.explanation?.whenToUse ?? '',
          explanation_try_this: t.explanation?.tryThis ?? '',
        },
        meta: { source_version_id: row.id },
      }));
  }
}

/**
 * The Aurora seat. Every method fails with the same explicit blocker text.
 *
 * This class exists rather than a `throw` at the factory so the shape of the
 * eventual implementation is fixed now: whoever lands Phase 0 + a Postgres
 * driver replaces the bodies here and touches nothing else in the pipeline.
 */
class AuroraDbI18nRepository implements DbI18nRepository {
  readonly target = 'aurora' as const;

  private fail(operation: string): never {
    throw new DbI18nRepositoryError(AURORA_TARGET_BLOCKER, operation);
  }

  async listSupportedLocales(): Promise<SupportedLocaleRow[]> {
    this.fail('listSupportedLocales');
  }
  async upsertNavCatalogI18n(): Promise<number> {
    this.fail('upsertNavCatalogI18n');
  }
  async upsertChecklistTranslations(): Promise<number> {
    this.fail('upsertChecklistTranslations');
  }
  async navCatalogCoverage(): Promise<CoverageEntry[]> {
    this.fail('navCatalogCoverage');
  }
  async checklistCoverage(): Promise<CoverageEntry[]> {
    this.fail('checklistCoverage');
  }
  async navCatalogSource(): Promise<SourceUnit[]> {
    this.fail('navCatalogSource');
  }
  async checklistSource(): Promise<SourceUnit[]> {
    this.fail('checklistSource');
  }
}

/**
 * Build the repository for the configured target.
 *
 * `client` is only consulted for the supabase target; the aurora target
 * deliberately accepts a null client so a caller with no Supabase credentials
 * can still construct one and receive the explicit blocker rather than a
 * confusing "missing SUPABASE_URL".
 */
export function createDbI18nRepository(
  client: SupabaseClient | null,
  env: NodeJS.ProcessEnv = process.env,
): DbI18nRepository {
  const target = resolveDbI18nTarget(env);
  if (target === 'aurora') return new AuroraDbI18nRepository();
  if (!client) {
    throw new DbI18nRepositoryError(
      'DB_I18N_TARGET=supabase but no Supabase client was supplied (check SUPABASE_URL + SUPABASE_SERVICE_ROLE).',
      'createDbI18nRepository',
    );
  }
  return new SupabaseDbI18nRepository(client);
}
