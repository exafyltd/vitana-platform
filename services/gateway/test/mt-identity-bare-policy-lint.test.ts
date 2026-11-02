/**
 * VTID-05465 (mt-identity-r2 / helpers-and-policy-rewrite) — the N3 bare-policy gate.
 *
 * A bare policy filters on `current_tenant_id()` alone, so it opens its table tenant-wide
 * for every caller whose tenant resolves. `scripts/ci/bare-policy-lint.mjs` parses every
 * migration (last definition wins) and must read ZERO before any later lane redefines
 * `current_tenant_id()`. On origin/main it reports the 2026-11-01 recount: 32 policies on
 * 15 tables.
 *
 * This file checks:
 *  1. the lint reads 0 over supabase/migrations;
 *  2. the rewrite migration replaces exactly the recount set with
 *     `tenant_id = (select public.tenant_id_for_policies())` (plan amendment 1: today's
 *     audience, only the helper name changes; no new `user_id = auth.uid()` term, no
 *     `is_member()` in a policy), keeps the two extra predicates, and leaves
 *     current_tenant_id() and the 5 no-policy tables alone;
 *  3. the rollback restores every rewritten policy byte-for-byte (whitespace aside) from
 *     the migration that created it;
 *  4. the parser itself on a small fixture (DROP POLICY, DROP TABLE, last definition
 *     wins, DO blocks, guards, rollback pairing).
 * The lint is an ES module, so it runs in a child `node` process.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const REPO = path.resolve(__dirname, '../../..');
const LINT = path.join(REPO, 'scripts/ci/bare-policy-lint.mjs');
const MIGRATIONS = path.join(REPO, 'supabase/migrations');
const HELPERS = path.join(MIGRATIONS, '20261102030000_vtid_05465_tenant_id_for_policies_is_member.sql');
const REWRITE = path.join(MIGRATIONS, '20261102030100_vtid_05465_bare_policy_rewrite.sql');
const ROLLBACK = path.join(MIGRATIONS, '20261102030100_vtid_05465_bare_policy_rewrite_rollback.sql');

type Bare = { table: string; policy: string; cmd: string; file: string; line: number };
type Report = { count: number; tables: number; bare: Bare[]; allowlisted: Bare[] };

/** The recount (2026-11-01, re-run at implementation on 50e55fd3a4): table -> [policy, cmd]. */
const RECOUNT: Record<string, Array<[string, string]>> = {
  community_groups: [['community_groups_insert', 'INSERT'], ['community_groups_update', 'UPDATE'], ['community_groups_delete', 'DELETE']],
  community_meetups: [['community_meetups_insert', 'INSERT'], ['community_meetups_update', 'UPDATE'], ['community_meetups_delete', 'DELETE']],
  community_listings: [['community_listings_select_public', 'SELECT']],
  d42_domain_weights: [['d42_domain_weights_select', 'SELECT']],
  event_attendance: [['event_attendance_select', 'SELECT']],
  live_highlights: [['live_highlights_select', 'SELECT']],
  live_room_attendance: [['live_room_attendance_select', 'SELECT']],
  live_rooms: [['live_rooms_select', 'SELECT'], ['live_rooms_insert', 'INSERT'], ['live_rooms_update', 'UPDATE']],
  products_catalog: [['products_catalog_select', 'SELECT'], ['products_catalog_insert', 'INSERT']],
  services_catalog: [['services_catalog_select', 'SELECT'], ['services_catalog_insert', 'INSERT']],
  tenant_catalog_overrides: [['tenant_catalog_overrides_select', 'SELECT']],
  match_targets: [['match_targets_select_policy', 'SELECT'], ['match_targets_insert_policy', 'INSERT'], ['match_targets_update_policy', 'UPDATE']],
  relationship_nodes: [['relationship_nodes_select', 'SELECT'], ['relationship_nodes_insert', 'INSERT'], ['relationship_nodes_update', 'UPDATE'], ['relationship_nodes_delete', 'DELETE']],
  social_alignment_signals: [['social_alignment_signals_select', 'SELECT'], ['social_alignment_signals_insert', 'INSERT']],
  topic_registry: [['topic_registry_select', 'SELECT'], ['topic_registry_insert', 'INSERT'], ['topic_registry_update', 'UPDATE'], ['topic_registry_delete', 'DELETE']],
};
const NO_POLICY_TABLES = ['access_audit_log', 'consents', 'retrieval_traces', 'role_sessions', 'user_roles'];

const recountKeys = Object.entries(RECOUNT)
  .flatMap(([t, ps]) => ps.map(([p, c]) => `${t}.${p}:${c}`))
  .sort();

function runLint(args: string[]): { status: number | null; report: Report } {
  const r = spawnSync(process.execPath, [LINT, '--json', ...args], { encoding: 'utf8' });
  if (r.error) throw r.error;
  return { status: r.status, report: JSON.parse(r.stdout) as Report };
}

/** Run an ES-module snippet that imports the lint as `L` and prints JSON. */
function withLint<T>(body: string): T {
  const src = `import * as L from ${JSON.stringify(`file://${LINT}`)};\n${body}`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' });
  return JSON.parse(out) as T;
}

type Ev = { kind: string; table?: string; policy?: string; definition?: string };
function events(file: string): Ev[] {
  return withLint<Ev[]>(
    `import { readFileSync } from 'node:fs';\n`
    + `process.stdout.write(JSON.stringify(L.policyEvents(readFileSync(${JSON.stringify(file)}, 'utf8'))));`,
  );
}

const TENANT_TERM = 'tenant_id = (select public.tenant_id_for_policies())';
const norm = (s: string) => s.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

describe('VTID-05465 N3 bare-policy lint', () => {
  it('reads ZERO bare current_tenant_id() policies over supabase/migrations', () => {
    const { status, report } = runLint([]);
    expect(report.bare.map((b) => `${b.table}.${b.policy}`)).toEqual([]);
    expect(report.count).toBe(0);
    expect(report.allowlisted).toEqual([]);
    expect(status).toBe(0);
  });

  it('the rollback restores exactly the recount set (32 policies on 15 tables)', () => {
    const { status, report } = runLint(['--include-rollbacks']);
    expect(report.bare.map((b) => `${b.table}.${b.policy}:${b.cmd}`).sort()).toEqual(recountKeys);
    expect(report.count).toBe(32);
    expect(report.tables).toBe(15);
    expect(status).toBe(1);
  });
});

describe('VTID-05465 helpers and rewrite migrations', () => {
  it('ships tenant_id_for_policies() and is_member(uuid) as STABLE SECURITY DEFINER and leaves current_tenant_id() alone', () => {
    const sql = fs.readFileSync(HELPERS, 'utf8');
    for (const fn of ['tenant_id_for_policies\\(\\)', 'is_member\\(p_tenant_id uuid\\)']) {
      const m = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}[\\s\\S]*?\\$\\$`, 'i').exec(sql);
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/\bSTABLE\b/);
      expect(m![0]).toMatch(/\bSECURITY DEFINER\b/);
      expect(m![0]).toMatch(/SET search_path = public, pg_temp/);
    }
    for (const f of [HELPERS, REWRITE, ROLLBACK]) {
      expect(fs.readFileSync(f, 'utf8')).not.toMatch(/FUNCTION\s+(public\.)?current_tenant_id\s*\(/i);
    }
  });

  it('rewrites every recounted policy to tenant_id_for_policies() and nothing else (amendment 1)', () => {
    const creates = events(REWRITE).filter((e) => e.kind === 'create');
    const drops = events(REWRITE).filter((e) => e.kind === 'drop_policy');
    const keys = creates.map((e) => `${e.table}.${e.policy}`).sort();
    expect(keys).toEqual(recountKeys.map((k) => k.split(':')[0]));
    expect(drops.map((e) => `${e.table}.${e.policy}`).sort()).toEqual(keys);
    for (const e of creates) {
      const def = norm(e.definition!);
      expect(def).not.toMatch(/current_tenant_id/i);
      expect(def).toMatch(/\bTO authenticated\b/);
      const cmd = RECOUNT[e.table!].find(([p]) => p === e.policy)![1];
      expect(def).toMatch(new RegExp(`\\bFOR ${cmd}\\b`));
      expect(def).toContain(TENANT_TERM);
      expect(def).not.toMatch(/is_member/);
      expect(def).not.toMatch(/auth\.uid/);
      expect(def).not.toMatch(/\buser_id\b/);
    }
    const byName = Object.fromEntries(creates.map((e) => [e.policy!, norm(e.definition!)]));
    expect(byName.community_listings_select_public).toContain(`status IN ('active', 'paused', 'sold') AND ${TENANT_TERM}`);
    expect(byName.d42_domain_weights_select).toContain(`${TENANT_TERM} OR tenant_id = '00000000-0000-0000-0000-000000000001'::UUID`);
    const all = [REWRITE, ROLLBACK].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    for (const t of NO_POLICY_TABLES) expect(all).not.toMatch(new RegExp(`\\b${t}\\b`));
  });

  it('the rollback recreates each policy exactly as the migration that created it, and the rewrite only swaps the helper', () => {
    const originals = withLint<Array<{ table: string; policy: string; definition: string; file: string }>>(
      `const keep = new Set(${JSON.stringify(recountKeys.map((k) => k.split(':')[0]))});\n`
      + `const dir = ${JSON.stringify(MIGRATIONS)};\n`
      + `const files = L.migrationFiles(dir).filter((f) => !f.includes('vtid_05465'));\n`
      + `import { mkdtempSync, symlinkSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os';\n`
      + `const t = mkdtempSync(join(tmpdir(), 'bpl-'));\n`
      + `for (const f of files) symlinkSync(join(dir, f), join(t, f));\n`
      + `process.stdout.write(JSON.stringify(L.finalPolicies(t).filter((p) => keep.has(p.table + '.' + p.policy))));`,
    );
    expect(originals).toHaveLength(32);
    const restored = Object.fromEntries(
      events(ROLLBACK).filter((e) => e.kind === 'create').map((e) => [`${e.table}.${e.policy}`, norm(e.definition!)]),
    );
    expect(Object.keys(restored).sort()).toEqual(recountKeys.map((k) => k.split(':')[0]));
    for (const o of originals) expect(restored[`${o.table}.${o.policy}`]).toBe(norm(o.definition));
    // Amendment 1: the rewrite is each original with only the helper swapped.
    const rewritten = Object.fromEntries(
      events(REWRITE).filter((e) => e.kind === 'create').map((e) => [`${e.table}.${e.policy}`, norm(e.definition!)]),
    );
    for (const o of originals) {
      const swapped = norm(o.definition).replace(/(public\.)?current_tenant_id\(\)/g, '(select public.tenant_id_for_policies())');
      expect(rewritten[`${o.table}.${o.policy}`]).toBe(swapped);
    }
  });
});

describe('VTID-05465 live-body guard', () => {
  it('reads the live current_tenant_id() body in DO $pre$ and raises before any policy is touched unless the three 20260218 markers match', () => {
    const sql = fs.readFileSync(REWRITE, 'utf8');
    const pre = /DO \$pre\$([\s\S]*?)\$pre\$;/.exec(sql);
    expect(pre).not.toBeNull();
    const guard = pre![1];
    expect(guard).toContain("pg_get_functiondef('public.current_tenant_id()'::regprocedure)");
    expect(guard).toContain("position('v_jwt_claims->''app_metadata''->>''active_tenant_id''' IN v_def)");
    expect(guard).toContain("position('FROM public.user_tenants' IN v_def)");
    expect(guard).toContain("position('WHERE user_id = auth.uid()' IN v_def)");
    expect(guard).toMatch(/IF NOT \(v_ok_app_metadata AND v_ok_user_tenants AND v_ok_own_lookup\) THEN\s+RAISE EXCEPTION/);
    expect(guard.indexOf('IF NOT (v_ok_app_metadata')).toBeLessThan(guard.indexOf('FOR r IN'));
  });
});

describe('VTID-05465 lint parser', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpl-fixture-'));
    const w = (name: string, sql: string) => fs.writeFileSync(path.join(dir, name), sql);
    w('001_a.sql', `
      CREATE POLICY a_sel ON public.a FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
      CREATE POLICY a_own ON public.a FOR SELECT TO authenticated USING (tenant_id = current_tenant_id() AND user_id = auth.uid());
      CREATE POLICY a_svc ON a FOR ALL TO service_role USING (tenant_id = current_tenant_id());
      CREATE POLICY "b quoted" ON public.b USING (tenant_id = current_tenant_id());
      CREATE POLICY c_sel ON public.c USING (tenant_id = current_tenant_id());
      CREATE POLICY d_sel ON public.d USING (tenant_id = current_tenant_id());
      -- CREATE POLICY commented ON public.z USING (tenant_id = current_tenant_id());
      DO $$ BEGIN EXECUTE 'CREATE POLICY in_string ON public.z USING (tenant_id = current_tenant_id())'; END $$;
    `);
    w('002_b.sql', `
      DROP POLICY IF EXISTS "b quoted" ON public.b;
      DROP TABLE IF EXISTS public.c, public.x;
      DO $do$ BEGIN
        IF to_regclass('public.d') IS NOT NULL THEN
          DROP POLICY IF EXISTS d_sel ON public.d;
          CREATE POLICY d_sel ON public.d USING ((select public.is_member(tenant_id)));
        END IF;
      END $do$;
    `);
    w('003_e.sql', 'CREATE POLICY e_sel ON public.e USING (tenant_id = current_tenant_id());');
    w('004_e.sql', 'DROP POLICY IF EXISTS e_sel ON public.e;');
    w('004_e_rollback.sql', 'CREATE POLICY e_sel ON public.e USING (tenant_id = current_tenant_id());');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('counts only bare policies left after drops, re-definitions and DO blocks', () => {
    const { status, report } = runLint(['--dir', dir]);
    expect(report.bare.map((b) => `${b.table}.${b.policy}`)).toEqual(['a.a_sel']);
    expect(status).toBe(1);
  });

  it('applies a paired _rollback.sql only when asked', () => {
    const { report } = runLint(['--dir', dir, '--include-rollbacks']);
    expect(report.bare.map((b) => `${b.table}.${b.policy}`)).toEqual(['a.a_sel', 'e.e_sel']);
  });
});
