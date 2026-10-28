/**
 * VTID-04880 — the legacy voice navigator's leftovers stay gone.
 *
 * The navigator reads the screen registry (VTID-04846). Its old catalog
 * tables were archived into `legacy_archive`, so nothing in the gateway or the
 * scripts may read or write them again, and no deploy workflow may set the
 * retired NAV_V2_ENABLED flag. Mentions in comments, docs, migrations and the
 * guarded Aurora restore dumps are history, not usage, and are allowed.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../../..');
const GATEWAY_SRC = path.join(REPO, 'services/gateway/src');
const SCRIPTS = path.join(REPO, 'scripts');

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/** Code with comments removed, so history notes never count as usage. */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*--.*$/gm, '')
    .replace(/^\s*#.*$/gm, '');
}

const TABLE_READ = /\.from\(\s*['"`]nav_catalog(_i18n|_audit)?['"`]\s*\)|\bpublic\.nav_catalog(_i18n|_audit)?\b/;

describe('VTID-04880: no code reads the archived nav_catalog tables', () => {
  it('gateway source', () => {
    const hits = walk(GATEWAY_SRC, ['.ts', '.js']).filter((f) => TABLE_READ.test(code(f)));
    expect(hits.map((f) => path.relative(REPO, f))).toEqual([]);
  });

  it('scripts (the guarded Aurora restore dumps excepted)', () => {
    const hits = walk(SCRIPTS, ['.ts', '.js', '.mjs', '.cjs', '.sh', '.sql'])
      .filter((f) => !/scripts\/aws\/aurora-(cutover-restore-grants|restore-rls-parity)\.sql$/.test(f))
      .filter((f) => TABLE_READ.test(code(f)));
    expect(hits.map((f) => path.relative(REPO, f))).toEqual([]);
  });

  it('every Aurora restore statement on them is guarded', () => {
    const dumps = [
      ...walk(path.join(REPO, 'services/postgrest-aurora-proxy'), ['.sql']),
      path.join(SCRIPTS, 'aws/aurora-cutover-restore-grants.sql'),
      path.join(SCRIPTS, 'aws/aurora-restore-rls-parity.sql'),
    ];
    const unguarded: string[] = [];
    for (const f of dumps) {
      const stmts = fs.readFileSync(f, 'utf8').split(/;\s*\n/);
      for (const st of stmts) {
        const body = st.replace(/^\s*--.*$/gm, '').trim();
        if (/\bnav_catalog/.test(body) && !/to_regclass\('public\.nav_catalog/.test(body)) {
          unguarded.push(`${path.relative(REPO, f)}: ${body.slice(0, 80)}`);
        }
      }
    }
    expect(unguarded).toEqual([]);
  });

  it('the db-i18n pipeline has no nav-catalog surface', () => {
    const { SURFACES } = require('../../src/services/db-i18n/surfaces');
    expect(SURFACES.map((s: { id: string }) => s.id)).not.toContain('nav-catalog');
  });
});

describe('VTID-04880: the retired NAV_V2_ENABLED flag is never pinned', () => {
  it.each(['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml'])('%s', (wf) => {
    const text = fs.readFileSync(path.join(REPO, '.github/workflows', wf), 'utf8');
    expect(text).not.toMatch(/\{\s*name\s*:\s*"NAV_V2_ENABLED"\s*,\s*value\s*:/);
  });
});
