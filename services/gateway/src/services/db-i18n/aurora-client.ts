/**
 * VTID-03517 — the gateway's first real PostgreSQL connection.
 *
 * WHY THIS IS A BIGGER DEAL THAN IT LOOKS
 *
 * `docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md` §0 records the reason "point the
 * app at Aurora" was never a config change: the gateway **has no Postgres
 * driver at all**. It speaks HTTP to PostgREST, so there was no connection to
 * repoint. This module is that missing piece, scoped deliberately to the
 * DB-content i18n surfaces (`nav_catalog_i18n`, `journey_checklist_translations`)
 * rather than the whole 2,480-call-site estate — B1 of that plan says the seam
 * comes first or the call sites get rewritten twice.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not migrate anything, and it must not be read as Aurora becoming
 * primary. Aurora is still the DMS replication *target* of Supabase and the
 * plan's Phase 0 gate is still open (~154k silently-dropped row applies,
 * unreconciled). Writes are therefore gated separately from connectivity —
 * see `assertWritesAllowed`.
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { readFileSync, existsSync } from 'node:fs';

export class AuroraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuroraConfigError';
  }
}

export interface AuroraConfig {
  connectionString: string;
  ssl: PoolConfig['ssl'];
  /** Redacted form safe to log / return from a health endpoint. */
  describe: string;
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<unparseable connection string>';
  }
}

/**
 * TLS for RDS.
 *
 * RDS presents a certificate signed by Amazon's own RDS CA, which is not in
 * the Node/OS trust store. Three outcomes, in descending order of safety:
 *
 *  1. `AURORA_CA_BUNDLE_PATH` points at the downloaded RDS CA bundle →
 *     verify properly. This is the intended production configuration.
 *  2. Nothing set → still verify, against the system store. This FAILS for
 *     RDS, and that failure is the point: it is a loud, specific error
 *     ("self-signed certificate in certificate chain") that tells an operator
 *     to install the bundle, rather than silently downgrading.
 *  3. `AURORA_SSL_INSECURE=true` → skip verification, with a warning on every
 *     pool construction. This exists because a broken TLS chain during a
 *     migration rehearsal should be survivable, not because it is acceptable
 *     to run this way. It never becomes the default by omission.
 *
 * `sslmode=disable` is honoured for LOOPBACK HOSTS ONLY (see `allowsPlaintext`).
 * A local PostgreSQL started for a test has no TLS at all, and refusing that
 * outright would make this adapter untestable against a real server — which
 * for a module whose entire substance is SQL means untested. Pointing it at a
 * remote host with `sslmode=disable` still throws: the rule permits a
 * developer's own machine, never plaintext across a network.
 */
function allowsPlaintext(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.searchParams.get('sslmode') !== 'disable') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return true;
    throw new AuroraConfigError(
      `sslmode=disable is only permitted for loopback hosts, and ${JSON.stringify(host)} is not one. ` +
        'Refusing to open a plaintext connection to a remote database. ' +
        'Set AURORA_CA_BUNDLE_PATH instead, or AURORA_SSL_INSECURE=true if you must skip verification.',
    );
  } catch (err) {
    if (err instanceof AuroraConfigError) throw err;
    return false;
  }
}

function resolveSsl(env: NodeJS.ProcessEnv): PoolConfig['ssl'] {
  if (allowsPlaintext((env.AURORA_DATABASE_URL ?? '').trim())) {
    console.warn('[aurora] sslmode=disable on a loopback host — plaintext connection (local/test only).');
    return false;
  }
  const caPath = (env.AURORA_CA_BUNDLE_PATH ?? '').trim();
  if (caPath) {
    if (!existsSync(caPath)) {
      throw new AuroraConfigError(
        `AURORA_CA_BUNDLE_PATH is set to ${JSON.stringify(caPath)} but no such file exists. ` +
          'Download the RDS CA bundle (rds-combined-ca-bundle.pem) and mount it on the task.',
      );
    }
    return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }
  if ((env.AURORA_SSL_INSECURE ?? '').trim().toLowerCase() === 'true') {
    console.warn(
      '[aurora] AURORA_SSL_INSECURE=true — TLS certificate verification is DISABLED. ' +
        'Acceptable only for a migration rehearsal; set AURORA_CA_BUNDLE_PATH for real use.',
    );
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

export function resolveAuroraConfig(env: NodeJS.ProcessEnv = process.env): AuroraConfig {
  const url = (env.AURORA_DATABASE_URL ?? '').trim();
  if (!url) {
    throw new AuroraConfigError(
      'AURORA_DATABASE_URL is not set. Expected a postgres:// URL for the Aurora WRITER endpoint ' +
        '(vitana-aurora-prod). The reader endpoint will reject writes with a read-only transaction error.',
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new AuroraConfigError('AURORA_DATABASE_URL must be a postgres:// or postgresql:// URL.');
  }
  return { connectionString: url, ssl: resolveSsl(env), describe: redact(url) };
}

/**
 * Writes are gated on their OWN flag, separate from connectivity.
 *
 * Being able to reach Aurora is not permission to write to it. Aurora receives
 * `nav_catalog_i18n` and `journey_checklist_translations` from Supabase over
 * DMS; a second writer against a replicated table is the hazard that got
 * `oasis-projector` excluded from the VTID-03419 cutover and that the
 * migration plan names as "Option C — the one to argue against". Reads and
 * reconciliation are safe today; writes are not, until DMS for these tables is
 * stopped or Aurora is promoted.
 *
 * So the default is READ-ONLY even when Aurora is fully configured. Enabling
 * writes is a deliberate act with a recorded reason.
 */
export function assertAuroraWritesAllowed(
  operation: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if ((env.AURORA_I18N_WRITES ?? '').trim().toLowerCase() === 'enabled') return;
  throw new AuroraConfigError(
    [
      `Refusing to ${operation} against Aurora: AURORA_I18N_WRITES is not 'enabled'.`,
      '',
      'Reaching Aurora is not permission to write to it. These two tables are DMS',
      'replication targets from Supabase, so a write here makes the gateway a second',
      'writer over replicated rows — the "Option C" hazard in',
      'docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md, and the reason oasis-projector was',
      'excluded from the VTID-03419 cutover.',
      '',
      'Before setting it, one of these must be true:',
      '  - DMS replication for these two tables is stopped, or',
      '  - Aurora has been promoted and Supabase is no longer the source.',
      '',
      'Reads and `--verify` reconciliation need no flag and are safe now.',
    ].join('\n'),
  );
}

let pool: Pool | null = null;

/** Lazily-built shared pool. Small: this is batch seeding, not request traffic. */
export function getAuroraPool(env: NodeJS.ProcessEnv = process.env): Pool {
  if (pool) return pool;
  const cfg = resolveAuroraConfig(env);
  pool = new Pool({
    connectionString: cfg.connectionString,
    ssl: cfg.ssl,
    max: Number(env.AURORA_POOL_MAX ?? 4),
    connectionTimeoutMillis: Number(env.AURORA_CONNECT_TIMEOUT_MS ?? 10_000),
    idleTimeoutMillis: 30_000,
    application_name: 'vitana-gateway-db-i18n',
  });
  // A pool that emits 'error' with no listener crashes the process. A dropped
  // idle connection is normal and must not take the seeder down mid-run.
  pool.on('error', (err) => console.error('[aurora] idle client error:', err.message));
  console.log(`[aurora] pool created for ${cfg.describe}`);
  return pool;
}

export async function closeAuroraPool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

/** Reset for tests — lets a suite point successive pools at different servers. */
export function __resetAuroraPoolForTests(): void {
  pool = null;
}

export async function withAuroraClient<T>(
  fn: (client: PoolClient) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const client = await getAuroraPool(env).connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * The schema these two surfaces need, as Aurora must have it.
 *
 * Kept here rather than reusing the Supabase migration file verbatim because
 * the two are NOT the same artifact: the Supabase migration ALTERs tables that
 * already exist and carries RLS policies tied to Supabase roles, while Aurora
 * may need the tables created from nothing and has no `service_role`/`anon` to
 * grant to. Sharing one file would mean one of the two paths silently doing
 * the wrong thing.
 *
 * `nav_catalog` is referenced but deliberately NOT created here — it is a
 * platform table owned by the wider migration, and creating a stub would
 * produce an empty catalog that looks real. The FK is added only if it exists.
 */
export const AURORA_DB_I18N_SCHEMA = `
CREATE TABLE IF NOT EXISTS public.supported_locales (
  code            text PRIMARY KEY,
  english_name    text NOT NULL,
  informal_hint   text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('ga', 'beta', 'draft', 'legacy')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.nav_catalog_i18n (
  catalog_id     uuid NOT NULL,
  lang           text NOT NULL,
  title          text NOT NULL,
  description    text NOT NULL DEFAULT '',
  when_to_visit  text NOT NULL DEFAULT '',
  source_sha     text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (catalog_id, lang)
);

CREATE TABLE IF NOT EXISTS public.journey_checklist_translations (
  topic_id                 text NOT NULL,
  locale                   text NOT NULL,
  display_label            text,
  short_description        text,
  explanation_what_it_is   text,
  explanation_user_benefit text,
  explanation_when_to_use  text,
  explanation_try_this     text,
  source_version_id        uuid,
  source_sha               text,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, locale)
);

ALTER TABLE public.nav_catalog_i18n ADD COLUMN IF NOT EXISTS source_sha text;
ALTER TABLE public.journey_checklist_translations ADD COLUMN IF NOT EXISTS source_sha text;

CREATE INDEX IF NOT EXISTS nav_catalog_i18n_lang_sha_idx
  ON public.nav_catalog_i18n (lang, source_sha);
CREATE INDEX IF NOT EXISTS journey_checklist_translations_locale_sha_idx
  ON public.journey_checklist_translations (locale, source_sha);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nav_catalog_i18n_lang_fkey'
  ) THEN
    ALTER TABLE public.nav_catalog_i18n
      ADD CONSTRAINT nav_catalog_i18n_lang_fkey
      FOREIGN KEY (lang) REFERENCES public.supported_locales(code) ON UPDATE CASCADE
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'journey_checklist_translations_locale_fkey'
  ) THEN
    ALTER TABLE public.journey_checklist_translations
      ADD CONSTRAINT journey_checklist_translations_locale_fkey
      FOREIGN KEY (locale) REFERENCES public.supported_locales(code) ON UPDATE CASCADE
      NOT VALID;
  END IF;
END $$;
`;
