#!/usr/bin/env node
/**
 * VTID-05150 — reserved tenant slugs, built from a vitana-v1 checkout.
 *
 *   node scripts/tenants/gen-reserved-slugs.mjs --v1 <path-to-vitana-v1> [--check] [--out <file>] [--commit <sha>]
 *
 * A tenant gets a path URL `vitanaland.com/<slug>` (program D5), so a slug must
 * never equal a top-level SPA segment or a top-level public file. The list is:
 *   spa_routes   — top-level segments of every <Route> in src/App.tsx (the same
 *                  extractSpaRoutes() the v1 registry test uses), of every
 *                  screens.json route / mobileRoute, and of every exclusions.json
 *                  prefix / path;
 *   public_files — top-level names in public/ (extension removed);
 *   platform     — the fixed list below (host and product words).
 * Only segments made of slug characters ([a-z0-9-]) are kept: anything else can
 * never collide with a valid slug.
 *
 * Without --check it writes services/gateway/src/services/tenant-provisioning/reserved-slugs.json.
 * With --check it only compares: a segment v1 has and the JSON lacks fails with
 * `::error::` naming it (the fix is a migration adding the row + this JSON).
 * Segments the JSON has and v1 no longer has stay reserved (never un-reserved
 * automatically) and are only reported.
 *
 * No runtime coupling: the gateway reads the checked-in JSON, the database reads
 * its reserved_tenant_slugs table; TENANT-RESERVED-SLUGS-DRIFT.yml runs --check weekly.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = path.resolve(HERE, '../../services/gateway/src/services/tenant-provisioning/reserved-slugs.json');

export const PLATFORM_SLUGS = [
  'api', 'auth', 'admin', 'app', 'www', 'static', 'assets', 'vitana', 'vitanaland', 'vitanaland-platform',
  'platform', 'exafy', 'login', 'signup', 'join', 'invite', 'help', 'docs', 'status', 'health', 'alive',
  'command-hub', 'backoffice', 'dev', 'staging', 'preview', 'mail', 'support', 'new', 'null', 'undefined',
];

const SLUG_CHARS = /^[a-z0-9-]+$/;

/** '/admin/users/:id' → 'admin'; '*', '/', ':param' → null. */
export function topSegment(route) {
  if (typeof route !== 'string') return null;
  const first = route.split('?')[0].split('#')[0].replace(/^\/+/, '').split('/')[0].trim().toLowerCase();
  if (!first || first === '*' || first.startsWith(':')) return null;
  return SLUG_CHARS.test(first) ? first : null;
}

const sortedUnique = (xs) => [...new Set(xs.filter(Boolean))].sort();

export async function collectFromV1(v1Root) {
  const app = fs.readFileSync(path.join(v1Root, 'src/App.tsx'), 'utf8');
  const { extractSpaRoutes } = await import(pathToFileURL(path.join(v1Root, 'scripts/nav/spa-routes.mjs')).href);
  const spa = extractSpaRoutes(app).map((r) => topSegment(r.path));

  const regDir = path.join(v1Root, 'src/navigation/registry');
  const screens = JSON.parse(fs.readFileSync(path.join(regDir, 'screens.json'), 'utf8')).screens || [];
  for (const s of screens) spa.push(topSegment(s.route), topSegment(s.mobileRoute));
  const exclusions = JSON.parse(fs.readFileSync(path.join(regDir, 'exclusions.json'), 'utf8'));
  for (const p of exclusions.prefixes || []) spa.push(topSegment(p.prefix));
  for (const p of exclusions.paths || []) spa.push(topSegment(p.path));

  const publicDir = path.join(v1Root, 'public');
  const pub = fs.existsSync(publicDir)
    ? fs.readdirSync(publicDir).map((n) => topSegment(n.replace(/\.[^.]+$/, '')))
    : [];

  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['-C', v1Root, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown';
  } catch { /* not a git checkout (fixture) */ }

  return {
    source_commit: commit,
    spa_routes: sortedUnique(spa),
    public_files: sortedUnique(pub),
    platform: sortedUnique(PLATFORM_SLUGS),
  };
}

/** Every slug in the JSON, any source. */
export const allSlugs = (doc) => sortedUnique([...(doc.spa_routes || []), ...(doc.public_files || []), ...(doc.platform || [])]);

/** Segments the fresh scan has that the checked-in JSON lacks. */
export function missingFrom(checkedIn, fresh) {
  const have = new Set(allSlugs(checkedIn));
  return allSlugs(fresh).filter((s) => !have.has(s));
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const v1 = arg('--v1');
  if (!v1) { console.error('usage: gen-reserved-slugs.mjs --v1 <vitana-v1 checkout> [--check] [--out <file>]'); process.exit(2); }
  const out = arg('--out') || DEFAULT_OUT;
  const fresh = await collectFromV1(path.resolve(v1));
  if (arg('--commit')) fresh.source_commit = arg('--commit');

  if (process.argv.includes('--check')) {
    const checkedIn = JSON.parse(fs.readFileSync(out, 'utf8'));
    const missing = missingFrom(checkedIn, fresh);
    const gone = allSlugs(checkedIn).filter((s) => !allSlugs(fresh).includes(s));
    if (gone.length) console.log(`[VTID-05150] still reserved, no longer in v1 (kept): ${gone.join(', ')}`);
    if (missing.length) {
      for (const s of missing) console.log(`::error::reserved tenant slug missing: "${s}" is a new top-level vitana-v1 segment — add it in a migration (reserved_tenant_slugs) and to reserved-slugs.json`);
      process.exit(1);
    }
    console.log(`[VTID-05150] reserved slugs in sync (${allSlugs(checkedIn).length} reserved, v1 ${fresh.source_commit})`);
    return;
  }

  fs.writeFileSync(out, `${JSON.stringify(fresh, null, 2)}\n`);
  console.log(`[VTID-05150] wrote ${path.relative(process.cwd(), out)} (${allSlugs(fresh).length} slugs, v1 ${fresh.source_commit})`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main().catch((err) => { console.error(`[VTID-05150] ${err instanceof Error ? err.stack : err}`); process.exit(1); });
