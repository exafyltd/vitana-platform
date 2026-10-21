#!/usr/bin/env node
/**
 * VTID-05067 — one-time, idempotent setup of the PRIVATE Supabase Storage bucket
 * `operator-media` (Operator Console images), through the Storage API — never an
 * INSERT into storage.buckets (plan sparring F15).
 *
 *   SUPABASE_URL=https://<project>.supabase.co SUPABASE_SERVICE_ROLE=<key> \
 *     node scripts/supabase/setup-operator-media-bucket.mjs [--dry-run]
 *
 * or run the workflow_dispatch job `.github/workflows/SETUP-OPERATOR-MEDIA-BUCKET.yml`.
 *
 * - bucket missing → POST /storage/v1/bucket { id, name, public: false, file_size_limit, allowed_mime_types }
 * - bucket present and private → nothing to do (exit 0)
 * - bucket present but PUBLIC → refused (exit 2): a person decides, the script never flips it
 *
 * No client policies are created: only the gateway (service role) reads or writes the bucket.
 * Exit codes: 0 ok / already ok, 1 error, 2 bucket exists but is public.
 */

export const BUCKET = 'operator-media';
export const BUCKET_CONFIG = {
  id: BUCKET,
  name: BUCKET,
  public: false,
  file_size_limit: 5 * 1024 * 1024,
  allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
};

/** Pure decision, unit-testable: what to do given the GET /bucket/:id answer. */
export function planBucketSetup(getStatus, existing) {
  if (getStatus === 200 && existing) {
    if (existing.public === true) return { action: 'refuse', reason: 'bucket exists and is PUBLIC' };
    return { action: 'none', reason: 'bucket exists and is private' };
  }
  if (getStatus === 404 || getStatus === 400) return { action: 'create', reason: 'bucket missing' };
  return { action: 'error', reason: `unexpected status ${getStatus} reading the bucket` };
}

export async function setupOperatorMediaBucket({ url, key, dryRun = false, fetchImpl = fetch, log = console.log }) {
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE are required');
  const base = url.replace(/\/+$/, '');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const got = await fetchImpl(`${base}/storage/v1/bucket/${BUCKET}`, { headers });
  let existing = null;
  if (got.ok) existing = await got.json().catch(() => null);
  // Supabase answers a missing bucket with 400 {"statusCode":"404","error":"Bucket not found"} on some versions.
  let status = got.status;
  if (!got.ok) {
    const body = await got.text().catch(() => '');
    if (/not\s*found/i.test(body)) status = 404;
  }
  const plan = planBucketSetup(status, existing);
  log(`[VTID-05067] ${BUCKET}: ${plan.reason} → ${plan.action}${dryRun ? ' (dry run)' : ''}`);
  if (plan.action === 'refuse') return { ok: false, code: 2, plan };
  if (plan.action === 'error') return { ok: false, code: 1, plan };
  if (plan.action === 'none' || dryRun) return { ok: true, code: 0, plan };
  const res = await fetchImpl(`${base}/storage/v1/bucket`, { method: 'POST', headers, body: JSON.stringify(BUCKET_CONFIG) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // A concurrent run created it first: still fine.
    if (/already exists/i.test(text)) return { ok: true, code: 0, plan: { action: 'none', reason: 'created concurrently' } };
    log(`[VTID-05067] create failed (${res.status}): ${text.slice(0, 300)}`);
    return { ok: false, code: 1, plan };
  }
  log(`[VTID-05067] ${BUCKET} created (private, 5 MB, png/jpeg/webp/gif)`);
  return { ok: true, code: 0, plan };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  setupOperatorMediaBucket({
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE,
    dryRun: process.argv.includes('--dry-run'),
  })
    .then((r) => process.exit(r.code))
    .catch((err) => { console.error(`[VTID-05067] ${err instanceof Error ? err.message : err}`); process.exit(1); });
}
