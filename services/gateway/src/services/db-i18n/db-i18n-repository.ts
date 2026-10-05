/**
 * VTID-03515 — write seam for DB-backed user-visible content translations.
 *
 * WHY THIS EXISTS
 * ---------------
 * User-visible text that never passes through `src/i18n/` lives in
 * `journey_checklist_translations` (My Journey curriculum). Seeding it for a
 * new language is the last manual step in adding a locale. (The Navigator
 * catalog's `nav_catalog_i18n` was the second surface until VTID-04880: the
 * voice navigator now reads the screen registry, which carries its own
 * per-locale titles, and the table was archived.)
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
import {
  assertAuroraWritesAllowed,
  withAuroraClient,
  AURORA_DB_I18N_SCHEMA,
} from './aurora-client';

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
 * What Aurora still needs before it can be the target, as of VTID-03517.
 *
 * The gateway now HAS a Postgres driver and this adapter is fully implemented,
 * so the old "cannot execute at all" blocker is gone. What remains is the part
 * that is not a code problem: Aurora is still the DMS replication target of
 * Supabase and the migration plan's Phase 0 gate is open. Reads and
 * reconciliation are safe now; writes are gated by `AURORA_I18N_WRITES`.
 *
 * Exported so the CLI can print it, and so a test can assert the wording keeps
 * naming the real remaining risk rather than decaying into "not implemented".
 */
export const AURORA_READINESS_NOTE = [
  'Aurora is implemented and reachable, but is NOT yet a safe write target.',
  '',
  '  - Aurora is the DMS replication TARGET of Supabase. Writing to it while',
  '    replication is running makes the gateway a second writer over replicated',
  '    rows — the "Option C" hazard in docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md,',
  '    and the reason oasis-projector was excluded from the VTID-03419 cutover.',
  '  - That plan\'s Phase 0 gate is open: ~154,000 silently-dropped DMS row',
  '    applies are still unreconciled, so Aurora holds a partial copy of',
  '    unknown quality.',
  '',
  'READS and `--verify` reconciliation need no flag and are useful today —',
  'reconciling these two tables is a concrete slice of the Phase 0 exit',
  'criteria. WRITES require AURORA_I18N_WRITES=enabled, which should only be',
  'set once DMS for these tables is stopped or Aurora has been promoted.',
].join('\n');

// -----------------------------------------------------------------------------
// Row shapes — mirror the DB columns exactly (snake_case), no mapping layer.
// -----------------------------------------------------------------------------

export interface ChecklistTranslationRow {
  topic_id: string;
  locale: string;
  display_label: string | null;
  short_description: string | null;
  explanation_what_it_is: string | null;
  explanation_user_benefit: string | null;
  explanation_when_to_use: string | null;
  explanation_try_this: string | null;
  vitana_voice_script?: string | null;
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
 * `key` is the natural key within its surface (a checklist `topic_id`).
 * `fields` maps DB column → source text. Keeping this generic is what lets
 * one pipeline serve any surface added later.
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
  upsertChecklistTranslations(rows: ChecklistTranslationRow[]): Promise<number>;
  checklistCoverage(locale: string): Promise<CoverageEntry[]>;
  /** German source rows from the CURRENT PUBLISHED curriculum snapshot. */
  checklistSource(curriculumVersion: string): Promise<SourceUnit[]>;
}

/**
 * Upserts are chunked. PostgREST rejects very large request bodies, and 254
 * curriculum topics times 8 locales is well past a comfortable single
 * statement. 200 keeps each request small enough to retry cheaply.
 */
const CHUNK = 200;

function chunked<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

interface SnapshotTopic {
  topicId: string;
  displayLabel?: string;
  shortDescription?: string;
  explanation?: {
    whatItIs?: string;
    userBenefit?: string;
    whenToUse?: string;
    tryThis?: string;
  };
  vitanaVoiceScript?: string | null;
}

/**
 * Published-snapshot JSON → source units. Shared by both adapters on purpose:
 * the snapshot is the same JSONB either way, and two copies of this mapping
 * would drift into two different `source_sha` values for identical content —
 * which the audit would then report as an entire locale being stale.
 */
function snapshotToSourceUnits(snapshot: unknown[], versionId: string): SourceUnit[] {
  return (snapshot as SnapshotTopic[])
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
        vitana_voice_script: t.vitanaVoiceScript ?? '',
      },
      meta: { source_version_id: versionId },
    }));
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
    return snapshotToSourceUnits(row.snapshot, row.id);
  }
}

/**
 * VTID-03517 — the real Aurora implementation, over a genuine Postgres
 * connection (see `aurora-client.ts` for why that is notable).
 *
 * Reads and reconciliation work as soon as `AURORA_DATABASE_URL` is set.
 * WRITES are gated separately on `AURORA_I18N_WRITES=enabled`, because
 * reaching Aurora is not permission to write to it while DMS is still
 * replicating these tables into it — see `assertAuroraWritesAllowed`.
 */
class AuroraDbI18nRepository implements DbI18nRepository {
  readonly target = 'aurora' as const;

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  private async query<R>(
    operation: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<R[]> {
    try {
      return await withAuroraClient(
        async (c) => (await c.query(sql, params as never[])).rows as R[],
        this.env,
      );
    } catch (err) {
      throw new DbI18nRepositoryError(
        err instanceof Error ? err.message : String(err),
        operation,
      );
    }
  }

  /** Create the two content tables + registry if Aurora does not have them. */
  async ensureSchema(): Promise<void> {
    assertAuroraWritesAllowed('create schema', this.env);
    await this.query('ensureSchema', AURORA_DB_I18N_SCHEMA);
  }

  async listSupportedLocales(): Promise<SupportedLocaleRow[]> {
    return this.query<SupportedLocaleRow>(
      'listSupportedLocales',
      `SELECT code, english_name, informal_hint, status
         FROM public.supported_locales ORDER BY code`,
    );
  }

  /**
   * Copy the locale registry in from Supabase (VTID-03572). Aurora-only, and
   * deliberately not on the shared `DbI18nRepository` interface: this is a
   * one-way bootstrap of a replication TARGET, not an operation that makes
   * sense against the upstream.
   *
   * `ensureSchema()` creates `supported_locales` empty, and `resolveLocales()`
   * then refuses to proceed against an empty registry — correctly, since a
   * missing locale row is a foreign-key failure a few hundred upserts later.
   * So a fresh Aurora needs this between the two, or nothing can ever be
   * seeded into it.
   *
   * ON CONFLICT UPDATE rather than DO NOTHING: `informal_hint` is fed verbatim
   * into the translation prompt and `status` gates which locales are selected,
   * so a stale row here silently produces wrong translations rather than an
   * error. Re-running must converge on upstream, not preserve whatever landed
   * first.
   */
  async upsertSupportedLocales(rows: SupportedLocaleRow[]): Promise<number> {
    assertAuroraWritesAllowed('upsert supported_locales', this.env);
    if (rows.length === 0) return 0;
    await this.query(
      'upsertSupportedLocales',
      `INSERT INTO public.supported_locales (code, english_name, informal_hint, status)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
       ON CONFLICT (code) DO UPDATE SET
         english_name  = EXCLUDED.english_name,
         informal_hint = EXCLUDED.informal_hint,
         status        = EXCLUDED.status`,
      [
        rows.map((r) => r.code),
        rows.map((r) => r.english_name),
        // '' not null: the column is `text NOT NULL DEFAULT ''`, so coalescing
        // to the schema's own default makes an absent hint behave exactly as if
        // the column had been omitted, instead of failing the whole batch on a
        // not-null violation.
        rows.map((r) => r.informal_hint ?? ''),
        rows.map((r) => r.status),
      ],
    );
    return rows.length;
  }

  async upsertChecklistTranslations(rows: ChecklistTranslationRow[]): Promise<number> {
    assertAuroraWritesAllowed('upsert journey_checklist_translations', this.env);
    let written = 0;
    for (const batch of chunked(rows)) {
      await this.query(
        'upsertChecklistTranslations',
        `INSERT INTO public.journey_checklist_translations
           (topic_id, locale, display_label, short_description,
            explanation_what_it_is, explanation_user_benefit,
            explanation_when_to_use, explanation_try_this,
            vitana_voice_script, source_version_id, source_sha, updated_at)
         SELECT t.*, now() FROM unnest(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
           $6::text[], $7::text[], $8::text[], $9::text[], $10::uuid[], $11::text[]
         ) AS t(topic_id, locale, display_label, short_description,
                explanation_what_it_is, explanation_user_benefit,
                explanation_when_to_use, explanation_try_this,
                vitana_voice_script, source_version_id, source_sha)
         ON CONFLICT (topic_id, locale) DO UPDATE SET
           display_label            = EXCLUDED.display_label,
           short_description        = EXCLUDED.short_description,
           explanation_what_it_is   = EXCLUDED.explanation_what_it_is,
           explanation_user_benefit = EXCLUDED.explanation_user_benefit,
           explanation_when_to_use  = EXCLUDED.explanation_when_to_use,
           explanation_try_this     = EXCLUDED.explanation_try_this,
           vitana_voice_script      = EXCLUDED.vitana_voice_script,
           source_version_id        = EXCLUDED.source_version_id,
           source_sha               = EXCLUDED.source_sha,
           updated_at               = now()`,
        [
          batch.map((r) => r.topic_id),
          batch.map((r) => r.locale),
          batch.map((r) => r.display_label),
          batch.map((r) => r.short_description),
          batch.map((r) => r.explanation_what_it_is),
          batch.map((r) => r.explanation_user_benefit),
          batch.map((r) => r.explanation_when_to_use),
          batch.map((r) => r.explanation_try_this),
          batch.map((r) => r.vitana_voice_script ?? null),
          batch.map((r) => r.source_version_id ?? null),
          batch.map((r) => r.source_sha ?? null),
        ],
      );
      written += batch.length;
    }
    return written;
  }

  async checklistCoverage(locale: string): Promise<CoverageEntry[]> {
    const rows = await this.query<{ topic_id: string; source_sha: string | null }>(
      'checklistCoverage',
      `SELECT topic_id, source_sha
         FROM public.journey_checklist_translations WHERE locale = $1`,
      [locale],
    );
    return rows.map((r) => ({ key: r.topic_id, source_sha: r.source_sha ?? null }));
  }

  async checklistSource(curriculumVersion: string): Promise<SourceUnit[]> {
    const rows = await this.query<{ id: string; snapshot: unknown }>(
      'checklistSource',
      `SELECT id::text AS id, snapshot
         FROM public.journey_checklist_versions
        WHERE curriculum_version = $1 AND is_current
        LIMIT 1`,
      [curriculumVersion],
    );
    const row = rows[0];
    if (!row || !Array.isArray(row.snapshot)) return [];
    return snapshotToSourceUnits(row.snapshot, row.id);
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
  if (target === 'aurora') return new AuroraDbI18nRepository(env);
  if (!client) {
    throw new DbI18nRepositoryError(
      'DB_I18N_TARGET=supabase but no Supabase client was supplied (check SUPABASE_URL + SUPABASE_SERVICE_ROLE).',
      'createDbI18nRepository',
    );
  }
  return new SupabaseDbI18nRepository(client);
}
