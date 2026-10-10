/**
 * VTID-05023 (Aurora cutover, R1(b)) — guard: no new outward-facing Supabase
 * URL may be built from SUPABASE_URL without going through
 * src/lib/supabase-public-url.ts.
 *
 * After the cutover SUPABASE_URL is a VPC-only proxy. supabase-js builds
 * storage public/signed URLs from it, so every `getPublicUrl(` /
 * `createSignedUrl(` call site must route its result through
 * `toPublicSupabaseUrl()`. Today that is exactly one file
 * (services/storage/storage-provider.ts), which every other caller uses.
 *
 * Adding a new call site? Route the URL through `toPublicSupabaseUrl()` and add
 * the file to ALLOWLIST with its call count. Better: call `storagePublicUrl` /
 * `storageSignedUrl` instead of the supabase-js storage API directly.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../src');

// Files allowed to call the supabase-js URL builders, with their exact call
// count. Each such file must also call toPublicSupabaseUrl() at least as many
// times.
const ALLOWLIST: Record<string, number> = {
  'services/storage/storage-provider.ts': 2,
};

const URL_BUILDER = /\.(getPublicUrl|createSignedUrls?|createSignedUploadUrl)\s*\(/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'frontend' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Source with line and block comments blanked, so prose mentioning the APIs doesn't count. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

const files = walk(SRC).map((f) => ({
  rel: path.relative(SRC, f).split(path.sep).join('/'),
  code: codeOnly(fs.readFileSync(f, 'utf8')),
}));

describe('VTID-05023 guard: outward-facing Supabase URLs go through supabase-public-url', () => {
  it('only allowlisted files call getPublicUrl/createSignedUrl(s)/createSignedUploadUrl', () => {
    const offenders: string[] = [];
    for (const { rel, code } of files) {
      const count = (code.match(URL_BUILDER) || []).length;
      if (count === 0) continue;
      if (ALLOWLIST[rel] !== count) offenders.push(`${rel} (${count} call(s), allowlisted ${ALLOWLIST[rel] ?? 0})`);
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlisted file wraps its URLs with toPublicSupabaseUrl()', () => {
    for (const [rel, count] of Object.entries(ALLOWLIST)) {
      const file = files.find((f) => f.rel === rel);
      expect(file).toBeDefined();
      const wrapped = (file!.code.match(/toPublicSupabaseUrl\s*\(/g) || []).length;
      expect({ rel, wrapped: wrapped >= count }).toEqual({ rel, wrapped: true });
    }
  });

  it('no code hand-builds a /storage/v1/ URL from SUPABASE_URL', () => {
    const offenders = files
      .filter(({ code }) => /(SUPABASE_URL|supabaseUrl)[^\n]{0,80}\/storage\/v1\//.test(code))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('browser-facing config (GET /auth/config, Command Hub CSP) uses the public base', () => {
    const auth = files.find((f) => f.rel === 'routes/auth.ts')!.code;
    expect(auth).toMatch(/supabase_url:\s*getSupabasePublicUrl\(\)/);

    const hub = files.find((f) => f.rel === 'routes/command-hub.ts')!.code;
    expect((hub.match(/getSupabasePublicOrigin\(\)/g) || []).length).toBe(2);
    expect(hub).not.toMatch(/new URL\(\s*(process\.env\.SUPABASE_URL|supabaseUrl)/);
  });
});
