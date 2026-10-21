#!/usr/bin/env node
/**
 * VTID-05150 — one-time, idempotent setup of the PUBLIC-READ Supabase Storage
 * bucket `tenant-assets` (tenant logos, favicons, OG images), through the
 * Storage API — never an INSERT into storage.buckets. Same pattern as
 * setup-operator-media-bucket.mjs (VTID-05067).
 *
 *   SUPABASE_URL=https://<project>.supabase.co SUPABASE_SERVICE_ROLE=<key> \
 *     node scripts/supabase/setup-tenant-assets-bucket.mjs [--dry-run]
 *
 * A production write: run once, in the owner-approved window (RUNBOOK-provision.md),
 * then verify with a read-only bucket listing.
 *
 * - bucket missing → POST /storage/v1/bucket { id, name, public: true, 1 MB, png/jpeg/webp }
 * - bucket present, public, same limits → nothing to do (exit 0)
 * - bucket present but PRIVATE or with other limits/types → refused (exit 2):
 *   a person decides, the script never changes an existing bucket
 *
 * No client write policies: only the gateway (service role) writes, at
 * `<slug>/<kind>.<ext>` (routes/admin-tenants.ts PUT /:id/assets/:kind).
 * No SVG: a public bucket never serves a scriptable image type.
 * Exit codes: 0 ok / already ok, 1 error, 2 bucket exists with other settings.
 */

export const BUCKET = 'tenant-assets';
export const BUCKET_CONFIG = {
  id: BUCKET,
  name: BUCKET,
  public: true,
  file_size_limit: 1024 * 1024,
  allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
};

const sameTypes = (a) => Array.isArray(a)
  && [...a].sort().join(',') === [...BUCKET_CONFIG.allowed_mime_types].sort().join(',');

/** Pure decision, unit-testable: what to do given the GET /bucket/:id answer. */
export function planBucketSetup(getStatus, existing) {
  if (getStatus === 200 && existing) {
    if (existing.public !== true) return { action: 'refuse', reason: 'bucket exists and is PRIVATE' };
    if (Number(existing.file_size_limit) !== BUCKET_CONFIG.file_size_limit || !sameTypes(existing.allowed_mime_types)) {
      return { action: 'refuse', reason: 'bucket exists with other size/type limits' };
    }
    return { action: 'none', reason: 'bucket exists, public, same limits' };
  }
  if (getStatus === 404 || getStatus === 400) return { action: 'create', reason: 'bucket missing' };
  return { action: 'error', reason: `unexpected status ${getStatus} reading the bucket` };
}

export async function setupTenantAssetsBucket({ url, key, dryRun = false, fetchImpl = fetch, log = console.log }) {
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE are required');
  const base = url.replace(/\/+$/, '');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const got = await fetchImpl(`${base}/storage/v1/bucket/${BUCKET}`, { headers });
  let existing = null;
  if (got.ok) existing = await got.json().catch(() => null);
  let status = got.status;
  if (!got.ok) {
    const body = await got.text().catch(() => '');
    if (/not\s*found/i.test(body)) status = 404;
  }
  const plan = planBucketSetup(status, existing);
  log(`[VTID-05150] ${BUCKET}: ${plan.reason} → ${plan.action}${dryRun ? ' (dry run)' : ''}`);
  if (plan.action === 'refuse') return { ok: false, code: 2, plan };
  if (plan.action === 'error') return { ok: false, code: 1, plan };
  if (plan.action === 'none' || dryRun) return { ok: true, code: 0, plan };
  const res = await fetchImpl(`${base}/storage/v1/bucket`, { method: 'POST', headers, body: JSON.stringify(BUCKET_CONFIG) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (/already exists/i.test(text)) return { ok: true, code: 0, plan: { action: 'none', reason: 'created concurrently' } };
    log(`[VTID-05150] create failed (${res.status}): ${text.slice(0, 300)}`);
    return { ok: false, code: 1, plan };
  }
  log(`[VTID-05150] ${BUCKET} created (public read, 1 MB, png/jpeg/webp, no client write policies)`);
  return { ok: true, code: 0, plan };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  setupTenantAssetsBucket({
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE,
    dryRun: process.argv.includes('--dry-run'),
  })
    .then((r) => process.exit(r.code))
    .catch((err) => { console.error(`[VTID-05150] ${err instanceof Error ? err.message : err}`); process.exit(1); });
}
