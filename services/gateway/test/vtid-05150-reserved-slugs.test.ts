/**
 * VTID-05150 — reserved tenant slugs.
 *  - reserved-slugs.json is sorted, unique, lowercase and slug-shaped;
 *  - the migration seed (20261014000400) is exactly the JSON set;
 *  - every legacy tenant slug and the fixed platform words are reserved;
 *  - scripts/tenants/gen-reserved-slugs.mjs, run on a fixture vitana-v1 tree,
 *    produces the expected list, and --check exits 1 naming a new App.tsx
 *    top-level segment (what TENANT-RESERVED-SLUGS-DRIFT.yml relies on).
 */
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isReservedSlug, RESERVED_SLUGS } from '../src/services/tenant-provisioning/reserved-slugs';

const REPO = path.join(__dirname, '../../..');
const JSON_PATH = path.join(REPO, 'services/gateway/src/services/tenant-provisioning/reserved-slugs.json');
const DOC = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const MIGRATION = fs.readFileSync(path.join(REPO, 'supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql'), 'utf8');
const GEN = path.join(REPO, 'scripts/tenants/gen-reserved-slugs.mjs');
const WORKFLOW = path.join(REPO, '.github/workflows/TENANT-RESERVED-SLUGS-DRIFT.yml');

const PLATFORM = [
  'api', 'auth', 'admin', 'app', 'www', 'static', 'assets', 'vitana', 'vitanaland', 'vitanaland-platform',
  'platform', 'exafy', 'login', 'signup', 'join', 'invite', 'help', 'docs', 'status', 'health', 'alive',
  'command-hub', 'backoffice', 'dev', 'staging', 'preview', 'mail', 'support', 'new', 'null', 'undefined',
];

describe('VTID-05150 reserved-slugs.json', () => {
  it.each(['spa_routes', 'public_files', 'platform'])('%s is sorted, unique, lowercase, slug characters only', (key) => {
    const list: string[] = DOC[key];
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect([...list].sort()).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
    for (const s of list) expect(s).toMatch(/^[a-z0-9-]+$/);
  });

  it('records the vitana-v1 commit it was built from', () => {
    expect(DOC.source_commit).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('reserves the legacy tenant slugs, the fixed platform words and the main SPA segments', () => {
    for (const s of ['maxina', 'alkalma', 'earthlinks', 'u', 'settings', 'wallet', 'admin', 'auth']) expect(isReservedSlug(s)).toBe(true);
    for (const s of PLATFORM) expect(isReservedSlug(s)).toBe(true);
    expect([...DOC.platform].sort()).toEqual([...PLATFORM].sort());
    expect(isReservedSlug('MAXINA')).toBe(true);
    expect(isReservedSlug('wellcircle')).toBe(false);
  });

  it('the migration seed is exactly the JSON set (each slug once)', () => {
    const block = MIGRATION.slice(MIGRATION.indexOf('INSERT INTO public.reserved_tenant_slugs'), MIGRATION.indexOf('ON CONFLICT (slug) DO NOTHING'));
    const rows = [...block.matchAll(/\('([a-z0-9-]+)','(spa_route|public_file|platform)'\)/g)].map((m) => ({ slug: m[1], source: m[2] }));
    const seeded = rows.map((r) => r.slug);
    expect(new Set(seeded).size).toBe(seeded.length);
    expect(new Set(seeded)).toEqual(RESERVED_SLUGS);
    // platform wins over spa_route over public_file when a slug has several sources
    for (const r of rows) {
      const expected = DOC.platform.includes(r.slug) ? 'platform' : DOC.spa_routes.includes(r.slug) ? 'spa_route' : 'public_file';
      expect({ slug: r.slug, source: r.source }).toEqual({ slug: r.slug, source: expected });
    }
  });

  it('the drift workflow is read-only, weekly + manual, and runs --check', () => {
    const wf = fs.readFileSync(WORKFLOW, 'utf8');
    expect(wf).toMatch(/schedule:/);
    expect(wf).toMatch(/workflow_dispatch:/);
    expect(wf).toMatch(/contents: read/);
    expect(wf).not.toMatch(/contents: write/);
    expect(wf).toContain('repository: exafyltd/vitana-v1');
    expect(wf).toContain('VITANA_V1_READ_TOKEN');
    expect(wf).toContain('scripts/tenants/gen-reserved-slugs.mjs --v1');
    expect(wf).toContain('--check');
  });
});

describe('VTID-05150 gen-reserved-slugs.mjs on a fixture vitana-v1 tree', () => {
  let v1: string;
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(v1, rel)), { recursive: true });
    fs.writeFileSync(path.join(v1, rel), content);
  };

  beforeAll(() => {
    v1 = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05150-v1-'));
    write('src/App.tsx', [
      '<Routes>',
      '  <Route path="/" element={<Home />} />',
      '  <Route path="/maxina" element={<Portal />} />',
      '  <Route path="/settings/profile" element={<Settings />} />',
      '  <Route path="/u/:handle" element={<Profile />} />',
      '  <Route path="/:tenantSlug/join" element={<Join />} />',
      '  <Route path="*" element={<NotFound />} />',
      '</Routes>',
    ].join('\n'));
    // Stand-in for vitana-v1's scripts/nav/spa-routes.mjs (same export, no TypeScript dependency).
    write('scripts/nav/spa-routes.mjs',
      'export function extractSpaRoutes(src) { return [...src.matchAll(/path="([^"]+)"/g)].map((m) => ({ path: m[1] })); }\n');
    write('src/navigation/registry/screens.json', JSON.stringify({
      version: 1,
      screens: [{ id: 'A', route: '/wallet/overview' }, { id: 'B', route: '/news', mobileRoute: '/m-news' }],
    }));
    write('src/navigation/registry/exclusions.json', JSON.stringify({
      prefixes: [{ prefix: '/admin', reason: 'x' }], paths: [{ path: '/_intro/:tenantSlug', reason: 'y' }],
    }));
    write('public/robots.txt', '');
    write('public/brand/logo.svg', '');
    write('public/Favicon.ico', '');
  });
  afterAll(() => fs.rmSync(v1, { recursive: true, force: true }));

  it('produces the expected list, then --check passes, then a new App.tsx segment fails --check by name', () => {
    const out = path.join(v1, 'out.json');
    execFileSync('node', [GEN, '--v1', v1, '--out', out, '--commit', 'abc1234'], { encoding: 'utf8' });
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(doc).toEqual({
      source_commit: 'abc1234',
      spa_routes: ['admin', 'm-news', 'maxina', 'news', 'settings', 'u', 'wallet'],
      public_files: ['brand', 'favicon', 'robots'],
      platform: [...PLATFORM].sort(),
    });

    const ok = spawnSync('node', [GEN, '--v1', v1, '--out', out, '--check'], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('reserved slugs in sync');

    write('src/App.tsx', fs.readFileSync(path.join(v1, 'src/App.tsx'), 'utf8').replace('</Routes>', '  <Route path="/garden" element={<G />} />\n</Routes>'));
    const drift = spawnSync('node', [GEN, '--v1', v1, '--out', out, '--check'], { encoding: 'utf8' });
    expect(drift.status).toBe(1);
    expect(drift.stdout).toContain('::error::reserved tenant slug missing: "garden"');
  });
});
