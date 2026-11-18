#!/usr/bin/env node
// VTID-05546 — vitana-v1 merge-request previews on GitLab (plan agentic-delivery §3.7; T4, deploy class).
//
//   preview.mjs upload --service community-app --prefix mr-<iid>/|gl-main/ --dist dist [--mode live|shadow]
//                      [--distribution-id ID]
//   preview.mjs stop   --service community-app --prefix mr-<iid>/ [--mode live] [--distribution-id ID]
//
// Writes only s3://vitana-pr-previews/<prefix> with role gl-v1-preview (plan §7) and invalidates only that path of the
// preview CloudFront distribution. Only two prefixes exist: `mr-<iid>/` (a merge request, live mode only) and
// `gl-main/` (the shadow build of main, plan §8.1 step 3). The `mr-` prefix keeps GitLab previews apart from GitHub's
// `pr-<n>/`. The trailing slash is required, so `mr-12/` can never match `mr-123/`. Teardown (`stop`, the
// `review/mr-<iid>` environment's on_stop job) removes only its own `mr-<iid>/` prefix. Upload mirrors
// PREVIEW-DEPLOY-FRONTEND.yml:120-136 (vitana-v1): hashed assets immutable, index.html never cached.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PREVIEW_BUCKET, DeployError, defaultRunner, aws, assertIdentity, parseArgs } from './lib.mjs';

export const PREVIEW_ROLE = 'gl-v1-preview';
export const PREVIEW_SERVICES = Object.freeze(['community-app']);
const MR_PREFIX_RE = /^mr-[1-9][0-9]{0,9}\/$/;
const DIST_ID_RE = /^[A-Z0-9]{10,20}$/;

export function checkPrefix(prefix, { mode, action }) {
  const p = String(prefix || '');
  const isMr = MR_PREFIX_RE.test(p);
  const isMain = p === 'gl-main/';
  if (!isMr && !isMain) throw new DeployError(`preview prefix '${p}' is not mr-<iid>/ or gl-main/: refused`, 2);
  if (isMr && mode !== 'live') throw new DeployError(`merge-request previews are written only in live mode (DELIVERY_MODE=${mode || 'unset'}): refused`, 2);
  if (action === 'stop' && !isMr) throw new DeployError(`only a merge request preview (mr-<iid>/) is torn down; '${p}' is kept: refused`, 2);
  return p;
}

function common(o) {
  if (!PREVIEW_SERVICES.includes(o.service)) throw new DeployError(`service '${o.service}' has no preview (plan §3.7: ${PREVIEW_SERVICES.join(', ')}): refused`, 2);
  const dist = String(o.distributionId || '');
  if (!DIST_ID_RE.test(dist)) throw new DeployError('the preview CloudFront distribution id (PREVIEW_CF_DISTRIBUTION_ID) is missing or malformed', 2);
  return dist;
}

function invalidate(run, dist, prefix) {
  aws(run, ['cloudfront', 'create-invalidation', '--distribution-id', dist, '--paths', `/${prefix}*`]);
}

export function upload(o, deps = {}) {
  const run = deps.run || defaultRunner;
  const log = deps.log || ((m) => console.log(m));
  const mode = o.mode === 'live' ? 'live' : 'shadow';
  const dist = common(o);
  const prefix = checkPrefix(o.prefix, { mode, action: 'upload' });
  if (!o.dist || !existsSync(join(o.dist, 'index.html'))) throw new DeployError(`no built preview at ${o.dist}/index.html`, 2);
  assertIdentity(run, PREVIEW_ROLE);
  const dest = `s3://${PREVIEW_BUCKET}/${prefix}`;
  aws(run, ['s3', 'sync', `${o.dist}/`, dest, '--delete', '--exclude', 'index.html', '--cache-control', 'public,max-age=31536000,immutable', '--only-show-errors'], { json: false });
  aws(run, ['s3', 'cp', join(o.dist, 'index.html'), `${dest}index.html`, '--cache-control', 'no-cache,no-store,must-revalidate', '--only-show-errors'], { json: false });
  invalidate(run, dist, prefix);
  const url = o.domain ? `https://${o.domain}/${prefix}` : null;
  log(`preview ${prefix} uploaded to ${dest}${url ? ` (${url})` : ''}`);
  return { prefix, dest, url };
}

export function stop(o, deps = {}) {
  const run = deps.run || defaultRunner;
  const log = deps.log || ((m) => console.log(m));
  const mode = o.mode === 'live' ? 'live' : 'shadow';
  const dist = common(o);
  const prefix = checkPrefix(o.prefix, { mode, action: 'stop' });
  assertIdentity(run, PREVIEW_ROLE);
  const dest = `s3://${PREVIEW_BUCKET}/${prefix}`;
  aws(run, ['s3', 'rm', dest, '--recursive', '--only-show-errors'], { json: false });
  invalidate(run, dist, prefix);
  log(`preview ${prefix} removed from ${dest}`);
  return { prefix, dest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = parseArgs(process.argv.slice(2));
  const env = process.env;
  const o = {
    service: a.service || env.PREVIEW_SERVICE,
    prefix: a.prefix || env.PREVIEW_PREFIX,
    dist: a.dist || 'dist',
    mode: a.mode || env.DELIVERY_MODE,
    distributionId: a['distribution-id'] || env.PREVIEW_CF_DISTRIBUTION_ID,
    domain: a.domain || env.PREVIEW_CF_DOMAIN,
  };
  try {
    if (a._[0] === 'upload') upload(o);
    else if (a._[0] === 'stop') stop(o);
    else throw new DeployError('usage: preview.mjs upload|stop …', 2);
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(e instanceof DeployError ? e.exitCode : 1);
  }
}
