/**
 * VTID-05504 (mt-m3-r2 / morning-health-pertenant): row 21c of MORNING-SYSTEM-HEALTH-CHECK.yml.
 *
 * Runs the real `run:` script of step "21c" with `curl` replaced by a stub that serves a fixture, and checks:
 *  - report-only: every row is INFO, the script exits 0 on every failure shape, nothing counts towards TOTAL_CHECKS;
 *  - per tenant: one row per tenant that has a finding, each row carries only that tenant's own numbers;
 *  - read-only: the only call is the POST of ci_tenant_isolation_health_by_tenant(); row 21b is unchanged.
 *
 * Run: JEST_ROOT=<checkout> npx jest --config <jest config with rootDir = this folder> morning-health-pertenant
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.VTID_ROOT || path.resolve(__dirname, '../../..');
const WF_TEXT = fs.readFileSync(path.join(ROOT, '.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml'), 'utf8');

/** The raw text of one step: from its `- name:` line to the next step or comment at step indent. */
function stepBlock(prefix: string): string {
  const lines = WF_TEXT.split('\n');
  const start = lines.findIndex((l) => l.startsWith("      - name: '" + prefix));
  if (start < 0) throw new Error(`step ${prefix} not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^      (- name:|#)/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** The `run: |` script of a step, dedented by its block indent. */
function stepScript(prefix: string): string {
  const lines = stepBlock(prefix).split('\n');
  const at = lines.findIndex((l) => /^        run: \|\s*$/.test(l));
  if (at < 0) throw new Error(`step ${prefix} has no run block`);
  return lines.slice(at + 1).map((l) => l.replace(/^          /, '')).join('\n');
}

const tenant = (o: Record<string, unknown>) => ({
  tenant_id: '00000000-0000-0000-0000-000000000001',
  slug: 'alpha',
  is_registered: true,
  foreign_tenant_rows: 0,
  null_tenant_rows: 0,
  users_zero_primary: 0,
  users_multi_primary: 0,
  auth_users_without_membership: 0,
  memberships_not_in_user_tenants: 0,
  user_tenants_not_in_memberships: 0,
  default_tenant_count: 0,
  platform_tenant_count: 0,
  ...o,
});

function run21c(status: number, body: string): { report: string; calls: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05504-'));
  const fixture = path.join(dir, 'rpc.json');
  fs.writeFileSync(fixture, body);
  const calls = path.join(dir, 'calls.txt');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/bash\necho "$@" >> "${calls}"\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then cp "${fixture}" "$2"; shift; fi; shift; done\nprintf ${status}\n`,
    { mode: 0o755 },
  );
  const report = path.join(dir, 'report.md');
  execFileSync('bash', ['-c', stepScript('21c.')], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPORT: report, SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE: 'k' },
  });
  return {
    report: fs.existsSync(report) ? fs.readFileSync(report, 'utf8').trim() : '',
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '',
  };
}

const payload = (tenants: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ generated_at: 'now', tenants, totals: {}, scan_errors: [], ...extra });

describe('morning row 21c (per-tenant isolation breakdown, report-only)', () => {
  it('exists, is report-only, and reads only the by-tenant function', () => {
    const block = stepBlock('21c.');
    expect(block).toContain('ci_tenant_isolation_health_by_tenant');
    expect(block).not.toMatch(/-X (PUT|PATCH|DELETE)/);
    expect(block).not.toContain('TOTAL_CHECKS');
    expect(block).not.toMatch(/\|\s*(PASS|FAIL)\s*\|/);
    expect(block).not.toMatch(/exit [1-9]/);
  });

  it('keeps row 21b on the whole-database function, unchanged', () => {
    const b = stepBlock('21b.');
    expect(b).toContain('rpc/ci_tenant_isolation_health"');
    expect(b).not.toContain('by_tenant');
  });

  it('puts 21c after 21b and before the self-audit', () => {
    const i = (s: string) => WF_TEXT.indexOf("- name: '" + s);
    expect(i('21b.')).toBeGreaterThan(0);
    expect(i('21c.')).toBeGreaterThan(i('21b.'));
    expect(i('22.')).toBeGreaterThan(i('21c.'));
  });

  it('posts only to the by-tenant rpc, once', () => {
    const { calls } = run21c(200, payload([tenant({})]));
    const lines = calls.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('-X POST');
    expect(lines[0]).toContain('/rest/v1/rpc/ci_tenant_isolation_health_by_tenant');
  });

  it('writes one INFO row per tenant with findings, each with its own numbers only', () => {
    const { report } = run21c(
      200,
      payload([
        tenant({ slug: 'alpha', foreign_tenant_rows: 11, memberships_not_in_user_tenants: 2 }),
        tenant({ tenant_id: '00000000-0000-0000-0000-000000000002', slug: 'beta', users_multi_primary: 7 }),
        tenant({ tenant_id: '00000000-0000-0000-0000-000000000003', slug: 'clean' }),
      ]),
    );
    const rows = report.split('\n');
    const alpha = rows.filter((r) => r.includes('alpha'));
    const beta = rows.filter((r) => r.includes('beta'));
    expect(alpha).toHaveLength(1);
    expect(beta).toHaveLength(1);
    expect(alpha[0]).toContain('11');
    expect(alpha[0]).not.toContain('beta');
    expect(beta[0]).toContain('7');
    expect(beta[0]).not.toContain('alpha');
    expect(report).not.toContain('clean');
    expect(rows.every((r) => /\| INFO \|/.test(r))).toBe(true);
    expect(rows.every((r) => r.startsWith('| 21c'))).toBe(true);
  });

  it('adds a summary row that counts the tenants and those with findings', () => {
    const { report } = run21c(
      200,
      payload([tenant({ slug: 'alpha', foreign_tenant_rows: 1 }), tenant({ tenant_id: '00000000-0000-0000-0000-000000000002', slug: 'zeta' })]),
    );
    const summary = report.split('\n')[0];
    expect(summary).toMatch(/2 tenants/);
    expect(summary).toMatch(/1 with findings/);
  });

  it('labels the row without a tenant as unattributed and an unregistered id as unregistered', () => {
    const { report } = run21c(
      200,
      payload([
        tenant({ tenant_id: null, slug: null, is_registered: false, null_tenant_rows: 5 }),
        tenant({ tenant_id: '00000000-0000-0000-0000-0000000000ff', slug: null, is_registered: false, foreign_tenant_rows: 3 }),
      ]),
    );
    expect(report).toMatch(/unattributed[^\n]*null 5/);
    expect(report).toMatch(/unregistered 00000000-0000-0000-0000-0000000000ff[^\n]*foreign 3/);
  });

  it('caps the rows and says how many were left out', () => {
    const many = Array.from({ length: 20 }, (_, n) =>
      tenant({ tenant_id: `00000000-0000-0000-0000-${String(n + 10).padStart(12, '0')}`, slug: `t${n}`, foreign_tenant_rows: n + 1 }),
    );
    const { report } = run21c(200, payload(many));
    const rows = report.split('\n');
    expect(rows.length).toBeLessThanOrEqual(17);
    expect(report).toMatch(/\+\d+ more/);
  });

  it('cleans a hostile slug so it cannot break the table', () => {
    const { report } = run21c(200, payload([tenant({ slug: 'a|b\nc', foreign_tenant_rows: 1 })]));
    const rows = report.split('\n');
    expect(rows.every((r) => r.startsWith('| 21c'))).toBe(true);
    expect(rows[1].split('|').length).toBe(6);
  });

  it('shows scan errors without failing', () => {
    const { report } = run21c(200, payload([tenant({})], { scan_errors: [{ table: 'x', sqlstate: '42P01' }] }));
    expect(report).toMatch(/scan errors 1/);
  });

  it.each([
    ['HTTP 404 (function not applied yet)', 404, '{}', /RPC HTTP 404/],
    ['HTTP 500', 500, '{}', /RPC HTTP 500/],
    ['a reply that is not an object', 200, '[]', /not a JSON object/],
    ['an object with no tenants list', 200, '{"generated_at":"x"}', /no tenants list/],
  ])('%s → one INFO row, exit 0', (_n, status, body, re) => {
    const { report } = run21c(status as number, body as string);
    const rows = report.split('\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/\| INFO \|/);
    expect(rows[0]).toMatch(re as RegExp);
  });
});
