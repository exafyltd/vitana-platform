/**
 * VTID-04637 — Test catalog loader.
 *
 * TEST-CATALOG.yml builds the catalog of every automated test in both
 * repositories (scripts/test-catalog/) on every merge and publishes it to
 * s3://<CODE_INDEX_BUCKET>/test-catalog/latest.json.gz — the same bucket and
 * the same resource-side grants as the code index (VTID-04229), so no new IAM.
 *
 * This module only reads that object, caches it, and trims it for the API.
 * It never builds a catalog itself: the gateway image does not contain the
 * frontend repository, so a catalog built here would silently miss half the
 * tests.
 */
import zlib from 'zlib';
import { resolveCodeIndexSource, type CodeIndexSource } from '../codeintel-index';

export const TEST_CATALOG_KEY = 'test-catalog/latest.json.gz';
export const TEST_CATALOG_TTL_MS = 10 * 60 * 1000;

export type TestEnvironment = 'dev_pr' | 'nightly' | 'staging' | 'production';

export interface TestCatalogSuite {
  id: string;
  name: string;
  repo: string;
  kind: string;
  runner: string;
  files: number;
  cases: number;
  domain: string;
  domains: Record<string, number>;
  runs_in: string[];
  environments: TestEnvironment[];
  schedules: Array<{ workflow: string; cron: string; human: string }>;
  never_run: boolean;
  flags: string[];
}

export interface TestCatalogWorkflow {
  id: string;
  repo: string;
  file: string;
  name: string;
  kind: string;
  triggers: Record<string, unknown>;
  schedules: Array<{ cron: string; human: string }>;
  hosts: string[];
  dead_hosts: string[];
  runners: string[];
  environments: TestEnvironment[];
  manual_trigger: boolean;
  flags: string[];
}

export interface TestCatalogFile {
  repo: string;
  path: string;
  suite_id: string;
  runner: string;
  cases: number;
  domain: string;
}

export interface TestCatalog {
  schema_version: number;
  generated_at: string | null;
  sources: Record<string, { repo: string; sha: string | null; missing: boolean }>;
  summary: Record<string, unknown>;
  suites: TestCatalogSuite[];
  named_suites: Array<Record<string, unknown>>;
  workflows: TestCatalogWorkflow[];
  other_workflows: Array<Record<string, unknown>>;
  files: TestCatalogFile[];
}

interface CacheEntry { catalog: TestCatalog; loadedAt: number; source: string }
let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;

export function clearTestCatalogCache(): void { cache = null; inflight = null; }

function decode(buf: Buffer): TestCatalog {
  const gz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const parsed = JSON.parse((gz ? zlib.gunzipSync(buf) : buf).toString('utf8')) as TestCatalog;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.suites) || !Array.isArray(parsed.workflows)) {
    throw new Error('test catalog is malformed (no suites/workflows arrays)');
  }
  return parsed;
}

/**
 * Loads the published catalog, re-reading it after `ttlMs`. Concurrent
 * callers share one read. Throws a plain message when the catalog has not
 * been published yet — the route turns that into a 503 that says so.
 */
export async function loadTestCatalog(
  opts: { source?: CodeIndexSource; env?: NodeJS.ProcessEnv; ttlMs?: number; now?: () => number } = {},
): Promise<{ catalog: TestCatalog; fromCache: boolean; source: string }> {
  const now = opts.now || Date.now;
  const ttl = opts.ttlMs ?? TEST_CATALOG_TTL_MS;
  if (cache && now() - cache.loadedAt < ttl) return { catalog: cache.catalog, fromCache: true, source: cache.source };
  if (!inflight) {
    const source = opts.source || resolveCodeIndexSource(opts.env || process.env);
    inflight = (async () => {
      const buf = await source.read(TEST_CATALOG_KEY);
      if (!buf) {
        throw new Error(`test catalog not published at ${source.describe()}/${TEST_CATALOG_KEY} (has TEST-CATALOG.yml run?)`);
      }
      const entry = { catalog: decode(buf), loadedAt: now(), source: source.describe() };
      cache = entry;
      return entry;
    })();
  }
  try {
    const entry = await inflight;
    return { catalog: entry.catalog, fromCache: false, source: entry.source };
  } finally {
    inflight = null;
  }
}

export interface CatalogQuery {
  environment?: string;
  domain?: string;
  runner?: string;
  repo?: string;
  q?: string;
  include_files?: boolean;
}

/** Filters suites/workflows for the API. Pure. */
export function queryCatalog(catalog: TestCatalog, query: CatalogQuery) {
  const env = (query.environment || '').trim();
  const domain = (query.domain || '').trim();
  const runner = (query.runner || '').trim();
  const repo = (query.repo || '').trim();
  const q = (query.q || '').trim().toLowerCase();

  const suites = catalog.suites.filter((s) =>
    (!env || s.environments.includes(env as TestEnvironment) || (env === 'never_run' && s.never_run)) &&
    (!domain || s.domain === domain || (s.domains && s.domains[domain] > 0)) &&
    (!runner || s.runner === runner) &&
    (!repo || s.repo === repo) &&
    (!q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)));

  const workflows = catalog.workflows.filter((w) =>
    (!env || w.environments.includes(env as TestEnvironment)) &&
    (!repo || w.repo === repo) &&
    (!q || w.file.toLowerCase().includes(q) || w.name.toLowerCase().includes(q)));

  let files: TestCatalogFile[] | undefined;
  if (query.include_files) {
    const ids = new Set(suites.map((s) => s.id));
    files = catalog.files.filter((f) => ids.has(f.suite_id));
  }

  return {
    generated_at: catalog.generated_at,
    sources: catalog.sources,
    summary: catalog.summary,
    suites,
    named_suites: catalog.named_suites,
    workflows,
    ...(files ? { files } : {}),
  };
}

/** One suite with its files. Pure. */
export function suiteDetail(catalog: TestCatalog, suiteId: string) {
  const suite = catalog.suites.find((s) => s.id === suiteId);
  if (!suite) return null;
  const files = catalog.files.filter((f) => f.suite_id === suiteId);
  const workflows = catalog.workflows.filter((w) => suite.runs_in.includes(w.file) && w.repo === suite.repo);
  return { suite, files, workflows };
}
