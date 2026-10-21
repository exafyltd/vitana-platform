/**
 * VTID-05153 — the supplier-catalog-check routine (Loop Engineering Phase 5,
 * loop L9 Supplier catalog, wave 1). Daily 13:00 UTC in the gateway routine
 * runner (routines/supplier-catalog-check.md).
 *
 * Loads the wave-1 category's supplier rows (source_network supplier_referral,
 * category CATALOG_CHECK_CATEGORY) in organizations that are not rejected,
 * without test and service accounts (fail closed: no exclusion list, no run),
 * checks at most MAX_ROWS_PER_RUN of them with the deterministic checks in
 * validators.ts, writes one result per row to products.attributes.catalog_check
 * and measures the L9 numbers (checks.ts checkSupplierCatalog).
 *
 * Writes, all of them: one PATCH per checked row. It only UPDATEs an existing
 * row, never inserts one. Its SET is `attributes` plus, on a row that is not
 * live, the normalized fields — never is_active or merchant_id (buildWriteBody
 * refuses any other key), so the VTID-04769 gate trigger
 * (BEFORE INSERT OR UPDATE OF is_active, merchant_id) does not fire. A write
 * applies only when the row is unchanged since the read: the PATCH filters on
 * the validated scalars, every written field's read value and jsonb equality
 * on `attributes`; a concurrent supplier edit matches 0 rows and the row is
 * checked again on the next run. Nothing here publishes, and no LLM is called.
 */

import {
  checkSupplierCatalog,
  READY_FOR_APPROVAL_TARGET,
  RoutineVerdict,
  SupplierCatalogMetrics,
  SupplierCatalogRun,
} from '../routine-runner/checks';
import { ClaimCheck, prescreenClaims } from './claim-prescreen';
import {
  CATALOG_CHECK_CATEGORY,
  CatalogCheckResult,
  CheckRow,
  checkRow,
  DuplicateHit,
  findDuplicates,
  ImageProbe,
  imagesToProbe,
  isProbeOutage,
  NORMALIZABLE_FIELDS,
  normalizeRow,
  ProbeOutcome,
  readResult,
  selectCandidates,
  writebackFields,
} from './validators';

export const CATALOG_CHECK_VTID = 'VTID-05153';
export const SUPPLIER_SOURCE = 'supplier_referral';
const PAGE = 1000;
const MAX_POOL = 5000;
const ID_CHUNK = 100;
const PROBE_CONCURRENCY = 6;

/** The product columns the routine reads. */
export const POOL_SELECT =
  'id,merchant_id,title,description,brand,price_cents,compare_at_price_cents,currency,images,affiliate_url,' +
  'origin_country,ships_to_countries,ships_to_regions,availability,category,subcategory,attributes,gtin,sku,' +
  'certifications,is_active,created_at';

export interface CatalogCheckDeps {
  /** Supabase REST GET (path from /rest/v1/…); throws on a failed read. */
  get: <T>(path: string) => Promise<T>;
  /** PATCH /rest/v1/products?<filters>; returns how many rows matched. Throws on a failed write. */
  patchProducts: (filters: string, body: Record<string, unknown>) => Promise<number>;
  /** Test and service accounts (service_bot_accounts ∪ notification_test_actors); throws when unknown. */
  excludedAccounts: () => Promise<Set<string>>;
  probe: ImageProbe;
  claimCheck: ClaimCheck;
}

// =============================================================================
// The guarded write (pure)
// =============================================================================

/** The only keys a catalog-check write may SET. */
export const ALLOWED_WRITE_KEYS: readonly string[] = ['attributes', ...NORMALIZABLE_FIELDS];

export function buildWriteBody(
  attributes: Record<string, unknown>,
  writeback: Partial<Record<string, unknown>>
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...writeback, attributes };
  for (const k of Object.keys(body)) {
    if (!ALLOWED_WRITE_KEYS.includes(k)) throw new Error(`catalog-check: refusing to write ${k}`);
  }
  return body;
}

const enc = encodeURIComponent;
const pgQuote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function scalarFilter(col: string, v: unknown): string {
  return v === null || v === undefined ? `${col}=is.null` : `${col}=eq.${enc(String(v))}`;
}

/** Set equality on a text[] column: contains AND contained by. */
function arrayFilter(col: string, v: unknown): string {
  if (!Array.isArray(v)) return `${col}=is.null`;
  const lit = `{${(v as unknown[]).map((x) => pgQuote(String(x))).join(',')}}`;
  return `${col}=cs.${enc(lit)}&${col}=cd.${enc(lit)}`;
}

const ARRAY_FIELDS = new Set(['images', 'ships_to_countries', 'ships_to_regions']);

/**
 * PostgREST filters that match the row only as it was read: id, the validated
 * scalars, the read value of every field the write sets, and `attributes`
 * (jsonb equality). A write-back additionally requires the row to be not live.
 */
export function guardFilters(read: CheckRow, writeback: Partial<Record<string, unknown>>): string {
  const parts = [
    `id=eq.${enc(read.id)}`,
    scalarFilter('title', read.title),
    scalarFilter('price_cents', read.price_cents),
    scalarFilter('currency', read.currency),
    scalarFilter('affiliate_url', read.affiliate_url),
    read.attributes == null ? 'attributes=is.null' : `attributes=eq.${enc(JSON.stringify(read.attributes))}`,
  ];
  const guarded = new Set(['title', 'price_cents', 'currency', 'affiliate_url']);
  for (const f of Object.keys(writeback)) {
    if (guarded.has(f)) continue;
    parts.push(ARRAY_FIELDS.has(f) ? arrayFilter(f, (read as any)[f]) : scalarFilter(f, (read as any)[f]));
  }
  if (Object.keys(writeback).length > 0) parts.push('is_active=eq.false');
  return parts.join('&');
}

// =============================================================================
// Loading
// =============================================================================

interface MerchantRow {
  id: string;
  owner_user_id: string | null;
  partner_organization_id: string | null;
}
interface OrgRow {
  id: string;
  lifecycle_state: string | null;
  owner_user_id: string | null;
}

async function getPaged<T>(deps: CatalogCheckDeps, path: string): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    if (offset >= MAX_POOL) return { rows, truncated: true };
    const page = await deps.get<T[]>(`${path}&limit=${PAGE}&offset=${offset}`);
    rows.push(...(page || []));
    if (!page || page.length < PAGE) return { rows, truncated: false };
  }
}

async function getByIds<T>(deps: CatalogCheckDeps, table: string, select: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    out.push(...((await deps.get<T[]>(`/rest/v1/${table}?id=in.(${chunk.map(enc).join(',')})&select=${select}`)) || []));
  }
  return out;
}

export interface PoolRow extends CheckRow {
  supplier_key: string;
}

/**
 * The category's supplier rows that may be checked: the merchant is known,
 * its organization (when it has one) is not rejected, and neither the
 * merchant's nor the organization's owner is a test or service account.
 */
export async function loadPool(deps: CatalogCheckDeps): Promise<{ rows: PoolRow[]; truncated: boolean; excluded: number }> {
  const excluded = await deps.excludedAccounts();
  const { rows, truncated } = await getPaged<CheckRow>(
    deps,
    `/rest/v1/products?source_network=eq.${SUPPLIER_SOURCE}&category=eq.${enc(CATALOG_CHECK_CATEGORY)}` +
      `&select=${POOL_SELECT}&order=created_at.asc,id.asc`
  );
  const merchantIds = [...new Set(rows.map((r) => r.merchant_id).filter(Boolean))];
  const merchants = new Map(
    (await getByIds<MerchantRow>(deps, 'merchants', 'id,owner_user_id,partner_organization_id', merchantIds)).map((m) => [m.id, m])
  );
  const orgIds = [...new Set([...merchants.values()].map((m) => m.partner_organization_id).filter((x): x is string => !!x))];
  const orgs = new Map(
    (await getByIds<OrgRow>(deps, 'partner_organizations', 'id,lifecycle_state,owner_user_id', orgIds)).map((o) => [o.id, o])
  );
  const out: PoolRow[] = [];
  let excludedRows = 0;
  for (const r of rows) {
    const m = merchants.get(r.merchant_id);
    if (!m) {
      excludedRows += 1;
      continue;
    }
    const org = m.partner_organization_id ? orgs.get(m.partner_organization_id) : null;
    if (m.partner_organization_id && (!org || org.lifecycle_state === 'rejected')) {
      excludedRows += 1;
      continue;
    }
    if ((m.owner_user_id && excluded.has(m.owner_user_id)) || (org?.owner_user_id && excluded.has(org.owner_user_id))) {
      excludedRows += 1;
      continue;
    }
    out.push({ ...r, supplier_key: m.partner_organization_id ? `org:${m.partner_organization_id}` : `merchant:${m.id}` });
  }
  return { rows: out, truncated, excluded: excludedRows };
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// =============================================================================
// The run
// =============================================================================

export async function runSupplierCatalogCheck(
  deps: CatalogCheckDeps = productionCatalogCheckDeps(),
  now: Date = new Date()
): Promise<RoutineVerdict> {
  const pool = await loadPool(deps);

  // Duplicates are searched within one supplier only.
  const bySupplier = new Map<string, PoolRow[]>();
  for (const r of pool.rows) {
    const list = bySupplier.get(r.supplier_key) ?? [];
    list.push(r);
    bySupplier.set(r.supplier_key, list);
  }
  const duplicates = new Map<string, DuplicateHit>();
  for (const list of bySupplier.values()) {
    for (const [id, hit] of findDuplicates(list.map((r) => normalizeRow(r).row))) duplicates.set(id, hit);
  }

  const candidates = selectCandidates(pool.rows, now);

  // Media: probe first, so an egress outage is known before any row is judged.
  const probeLists: ProbeOutcome[][] = candidates.map(() => []);
  const jobs: Array<{ row: number; url: string }> = [];
  candidates.forEach((c, row) => imagesToProbe(normalizeRow(c).row).forEach((url) => jobs.push({ row, url })));
  const outcomes = await mapLimited(jobs, PROBE_CONCURRENCY, async (j) => {
    try {
      return await deps.probe(j.url);
    } catch {
      return { kind: 'network_error' } as ProbeOutcome;
    }
  });
  jobs.forEach((j, i) => probeLists[j.row].push(outcomes[i]));
  const outage = isProbeOutage(outcomes);

  const run: SupplierCatalogRun = {
    pool_rows: pool.rows.length,
    pool_truncated: pool.truncated,
    excluded_rows: pool.excluded,
    candidates: candidates.length,
    probes: { total: outcomes.length, network_errors: outcomes.filter((o) => o.kind === 'network_error').length, outage },
    write_conflicts: 0,
    write_errors: 0,
  };

  const written = new Map<string, CatalogCheckResult>();
  const byErrorCode: Record<string, number> = {};
  let failing = 0;
  let autoNormalized = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const prev = readResult(c);
    const checked = checkRow(c, {
      now,
      probes: probeLists[i],
      outage,
      duplicate: duplicates.get(c.id) ?? null,
      claimCheck: deps.claimCheck,
    });
    // Normalization is written back only to a row that is not live.
    const writeback = c.is_active === false ? writebackFields(checked.normalizedRow, checked.normalizedFields) : {};
    const result: CatalogCheckResult = { ...checked.result, normalized: Object.keys(writeback) };
    const body = buildWriteBody({ ...((c.attributes as Record<string, unknown>) ?? {}), catalog_check: result }, writeback);
    let matched: number;
    try {
      matched = await deps.patchProducts(guardFilters(c, writeback), body);
    } catch {
      run.write_errors += 1;
      continue;
    }
    if (matched === 0) {
      run.write_conflicts += 1; // changed since the read — checked again next run
      continue;
    }
    written.set(c.id, result);
    for (const e of result.errors) byErrorCode[e.code] = (byErrorCode[e.code] ?? 0) + 1;
    if (result.state === 'needs_fix' || result.state === 'returned_to_supplier') failing += 1;
    if (
      result.state === 'ready_for_review' &&
      prev?.state !== 'ready_for_review' &&
      (!prev || prev.content_hash === result.content_hash)
    ) {
      autoNormalized += 1;
    }
  }

  const byState: Record<string, number> = {};
  let withResult = 0;
  let ready = 0;
  for (const r of pool.rows) {
    const res = written.get(r.id) ?? readResult(r);
    if (!res) continue;
    withResult += 1;
    byState[res.state] = (byState[res.state] ?? 0) + 1;
    if (res.state === 'ready_for_review' && !res.flags.includes('image_unchecked')) ready += 1;
  }

  const metrics: SupplierCatalogMetrics = {
    category: CATALOG_CHECK_CATEGORY,
    rows_checked: written.size,
    rows_auto_normalized: autoNormalized,
    validation_failure_rate: written.size ? failing / written.size : null,
    ready_for_approval_share: withResult ? ready / withResult : null,
    ready_for_approval_target: READY_FOR_APPROVAL_TARGET,
    by_state: byState,
    by_error_code: byErrorCode,
    time_to_listing: {
      state: 'not_measured',
      reason: 'listing is a human decision (org review + allow-listing); no listing timestamp per row is joined to its check yet',
    },
    human_edits_per_listing: {
      state: 'not_measured',
      reason: 'supplier and admin edits to a product are not recorded per row',
    },
  };
  return checkSupplierCatalog(metrics, run);
}

// =============================================================================
// Production dependencies
// =============================================================================

function supa(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE not set');
  return { url, key };
}

/** The SSRF-guarded HEAD probe → a ProbeOutcome. */
export async function productionProbe(url: string): Promise<ProbeOutcome> {
  const { ssrfGuardedHead } = require('../platform-detect');
  try {
    const r = await ssrfGuardedHead(url);
    if (r.status >= 200 && r.status < 300) {
      const ct = (r.contentType || '').toLowerCase();
      return ct.startsWith('image/') ? { kind: 'ok' } : { kind: 'not_image', content_type: r.contentType };
    }
    return { kind: 'http_error', status: r.status };
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg === 'blocked_private_address' || msg === 'unsupported_protocol' || err?.code === 'ERR_INVALID_URL') {
      return { kind: 'blocked' };
    }
    if (msg === 'too_many_redirects' || msg === 'redirect_without_location') return { kind: 'http_error', status: null };
    return { kind: 'network_error' };
  }
}

export function productionCatalogCheckDeps(): CatalogCheckDeps {
  return {
    get: async <T>(path: string): Promise<T> => {
      const s = supa();
      const res = await fetch(`${s.url}${path}`, { headers: { apikey: s.key, Authorization: `Bearer ${s.key}` } });
      if (!res.ok) throw new Error(`GET ${path.split('?')[0]} → ${res.status} ${(await res.text()).slice(0, 300)}`);
      return (await res.json()) as T;
    },
    patchProducts: async (filters, body) => {
      const s = supa();
      const res = await fetch(`${s.url}/rest/v1/products?${filters}&select=id`, {
        method: 'PATCH',
        headers: {
          apikey: s.key,
          Authorization: `Bearer ${s.key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`PATCH products → ${res.status} ${(await res.text()).slice(0, 300)}`);
      const rows = (await res.json()) as unknown[];
      return Array.isArray(rows) ? rows.length : 0;
    },
    excludedAccounts: async () => {
      const { getSupabase } = require('../../lib/supabase');
      const { fetchExcludedTestServiceAccountIdsStrict } = require('../../lib/excluded-test-service-accounts');
      const sb = getSupabase();
      if (!sb) throw new Error('Supabase client not configured');
      const r = await fetchExcludedTestServiceAccountIdsStrict(sb);
      if (!r.ok) throw new Error(`excluded accounts unavailable: ${r.error}`);
      return r.ids;
    },
    probe: productionProbe,
    claimCheck: prescreenClaims,
  };
}
