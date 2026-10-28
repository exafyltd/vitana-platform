/**
 * VTID-05324 (mt-launch/pack-intake-db): the pack intake + content pipeline
 * migrations' safety properties, read from the files (P1-P5).
 *
 * The behavioural twin is the pgTAP plan docs/validation/VTID-05324/pgtap-pack-intake.sql
 * (throwaway Postgres only). This suite pins the same properties from source so CI
 * checks them without a database: service-role-only tables (client roles have no
 * privilege, so a client read fails), expand-only, and a read-only
 * get_tenant_launch_readiness that is SECURITY INVOKER, STABLE, search_path pinned,
 * service_role-only and reads only tenant_pack_intake + tenants (no health table).
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');

const INTAKE = 'supabase/migrations/20261101110000_mt_launch_tenant_pack_intake.sql';
const PIPELINE = 'supabase/migrations/20261101110100_mt_launch_tenant_content_pipeline.sql';
const VALIDATION = 'docs/validation/VTID-05324';

const CHECKLIST = [
  'anchor_person_consent',
  'brand_kit',
  'copy',
  'persona_facts',
  'brand_kb_docs',
  'season0_approval',
  'events_calendar_90d',
  'seed_groups',
  'host_moderator_support_sla',
  'founding_invites_30',
  'revenue_share',
  'locales',
  'health_claims_signoff',
];

// Same deny pattern as test/vtid-05025-commerce-health-boundary.test.ts, widened to
// the D18 prefixes of the mt-launch plan (health_*, wearable_*, biomarker_*, lab_*, vitana_index_*).
const HEALTH_TABLE = /\b(health_\w+|wearable_\w+|biomarker_\w+|lab_\w+|vitana_index_\w+|vitana_pillar_agent_outputs)\b/;

const exists = (p: string) => fs.existsSync(path.join(REPO, p));
const intake = exists(INTAKE) ? strip(read(INTAKE)) : '';
const pipeline = exists(PIPELINE) ? strip(read(PIPELINE)) : '';

function quotedList(src: string, constraint: string): string[] {
  const m = src.match(new RegExp(`CONSTRAINT ${constraint} CHECK \\(\\w+ IN \\(([^)]*)\\)\\)`));
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function functionBody(src: string): string {
  const m = src.match(/AS \$fn\$([\s\S]*?)\$fn\$;/);
  return m ? m[1] : '';
}

describe('VTID-05324 migration files', () => {
  it('both files exist, in order, and no other migration shares their version', () => {
    expect(exists(INTAKE)).toBe(true);
    expect(exists(PIPELINE)).toBe(true);
    expect(path.basename(INTAKE) < path.basename(PIPELINE)).toBe(true);
    const versions = fs
      .readdirSync(path.join(REPO, 'supabase/migrations'))
      .filter((f) => /^\d{14}_.*\.sql$/.test(f))
      .map((f) => f.slice(0, 14));
    expect(versions.filter((v) => v === '20261101110000')).toHaveLength(1);
    expect(versions.filter((v) => v === '20261101110100')).toHaveLength(1);
  });

  it('are expand-only: one transaction each, no drop/alter of an existing object, no backfill', () => {
    for (const sql of [intake, pipeline]) {
      expect(sql).toMatch(/^BEGIN;/m);
      expect(sql).toMatch(/^COMMIT;/m);
      expect(sql).not.toMatch(/\bDROP\s+(TABLE|FUNCTION|COLUMN|SCHEMA|INDEX)\b/i);
      expect(sql).not.toMatch(/\bTRUNCATE\b/i);
      expect(sql).not.toMatch(/\bALTER TABLE\s+(?!public\.tenant_(pack_intake|content_pipeline)\s+ENABLE ROW LEVEL SECURITY)/i);
      expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
      expect(sql).not.toMatch(/\bUPDATE\s+public\./i);
      expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    }
  });
});

describe('VTID-05324 P1 tenant_pack_intake', () => {
  it('is keyed (tenant_id, item_key) with an FK to the live tenants key', () => {
    expect(intake).toContain('CREATE TABLE IF NOT EXISTS public.tenant_pack_intake (');
    expect(intake).toMatch(/tenant_id\s+uuid\s+NOT NULL REFERENCES public\.tenants\(tenant_id\) ON DELETE CASCADE/);
    expect(intake).toContain('CONSTRAINT tenant_pack_intake_pkey PRIMARY KEY (tenant_id, item_key)');
    for (const col of ['status', 'evidence', 'decided_by', 'decided_at', 'updated_at']) {
      expect(intake).toMatch(new RegExp(`\\n\\s+${col}\\s+`));
    }
    expect(intake).toContain("column_name = 'tenant_id'");
  });

  it('constrains item_key to the WS8 checklist and status to the four states', () => {
    expect(quotedList(intake, 'tenant_pack_intake_item_key_check')).toEqual(CHECKLIST);
    expect(quotedList(intake, 'tenant_pack_intake_status_check')).toEqual([
      'not_started',
      'in_progress',
      'blocked',
      'approved',
    ]);
  });
});

describe('VTID-05324 P2 tenant_content_pipeline', () => {
  it('is unique on (tenant_id, locale, key) with the plan columns', () => {
    expect(pipeline).toContain('CREATE TABLE IF NOT EXISTS public.tenant_content_pipeline (');
    expect(pipeline).toMatch(/tenant_id\s+uuid\s+NOT NULL REFERENCES public\.tenants\(tenant_id\) ON DELETE CASCADE/);
    expect(pipeline).toContain('UNIQUE (tenant_id, locale, key)');
    for (const col of [
      'locale',
      'key',
      'source_template',
      'candidate_value',
      'lint_report',
      'review_state',
      'reviewed_by',
      'signed_off_by',
      'published_at',
    ]) {
      expect(pipeline).toMatch(new RegExp(`\\n\\s+${col}\\s+`));
    }
    expect(pipeline).toContain("to_regclass('public.tenant_pack_intake') IS NULL");
  });

  it('constrains review_state to the pipeline states', () => {
    expect(quotedList(pipeline, 'tenant_content_pipeline_review_state_check')).toEqual([
      'generated',
      'linted',
      'in_review',
      'signed_off',
      'published',
      'rejected',
    ]);
  });

  it('never writes to WS5 tenant_content_overrides', () => {
    expect(pipeline).not.toContain('tenant_content_overrides');
  });
});

describe('VTID-05324 P1/P2 service-role-only access (a client read fails)', () => {
  it.each([
    ['tenant_pack_intake', () => intake],
    ['tenant_content_pipeline', () => pipeline],
  ])('%s: RLS on, client privileges revoked, only a service_role policy', (table, src) => {
    const sql = src();
    expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
    expect(sql).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`);
    expect(sql).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO service_role;`);
    expect(sql).not.toMatch(/GRANT[^;]*\sTO\s+[^;]*\b(anon|authenticated|PUBLIC)\b/);
    const policies = sql.match(/CREATE POLICY[\s\S]*?;/g) || [];
    expect(policies).toHaveLength(1);
    expect(policies[0]).toContain(`ON public.${table}`);
    expect(policies[0]).toContain("USING (auth.role() = 'service_role')");
    expect(policies[0]).toContain("WITH CHECK (auth.role() = 'service_role')");
    expect(policies[0]).not.toMatch(/\bTO\s+(anon|authenticated|public)\b/i);
  });
});

describe('VTID-05324 P3 get_tenant_launch_readiness', () => {
  const body = functionBody(pipeline);

  it('is SECURITY INVOKER, STABLE, search_path pinned, never DEFINER', () => {
    expect(pipeline).toMatch(
      /CREATE OR REPLACE FUNCTION public\.get_tenant_launch_readiness\(p_tenant_id uuid\)\s+RETURNS jsonb\s+LANGUAGE sql\s+STABLE\s+SECURITY INVOKER\s+SET search_path = public, pg_catalog\s+AS \$fn\$/,
    );
    expect(pipeline).not.toMatch(/SECURITY DEFINER/i);
  });

  it('EXECUTE is revoked from PUBLIC/anon/authenticated and granted only to service_role', () => {
    expect(pipeline).toContain(
      'REVOKE ALL ON FUNCTION public.get_tenant_launch_readiness(uuid) FROM PUBLIC, anon, authenticated;',
    );
    expect(pipeline).toContain('GRANT EXECUTE ON FUNCTION public.get_tenant_launch_readiness(uuid) TO service_role;');
    expect(pipeline).not.toMatch(/GRANT EXECUTE[^;]*\sTO\s+[^;]*\b(anon|authenticated|PUBLIC)\b/);
  });

  it('is read-only and reads only tenant_pack_intake + tenants (no health table)', () => {
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|CREATE|DROP|ALTER|GRANT|REVOKE)\b/i);
    const refs = [...body.matchAll(/\bpublic\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(refs)).toEqual(new Set(['tenants', 'tenant_pack_intake']));
    const fromJoin = [...body.matchAll(/\b(?:FROM|JOIN)\s+([\w.]+)/gi)].map((m) => m[1]);
    for (const t of fromJoin) {
      expect(['public.tenants', 'public.tenant_pack_intake', 'checklist', 'items', 't']).toContain(t);
      expect(t).not.toMatch(HEALTH_TABLE);
    }
    for (const r of refs) expect(r).not.toMatch(HEALTH_TABLE);
  });

  it('the health-table guard catches a planted read (self-test)', () => {
    expect('SELECT * FROM public.wearable_rollup_7d').toMatch(HEALTH_TABLE);
    expect('SELECT * FROM public.health_features_daily').toMatch(HEALTH_TABLE);
    expect('SELECT * FROM public.tenant_pack_intake').not.toMatch(HEALTH_TABLE);
  });

  it('its checklist equals the item_key CHECK constraint, and an unknown tenant returns NULL', () => {
    const values = [...(body.match(/checklist\(item_key\) AS \(\s*VALUES([\s\S]*?)\n\s*\)/) || ['', ''])[1].matchAll(
      /\('([^']+)'\)/g,
    )].map((m) => m[1]);
    expect(values).toEqual(CHECKLIST);
    expect(body).toContain('WHEN NOT EXISTS (SELECT 1 FROM t) THEN NULL');
    expect(body).toContain("COALESCE(i.status, 'not_started')");
  });
});

describe('VTID-05324 P4 queue, drift baseline, rollback', () => {
  it('MIGRATION-QUEUE lists both files after WS5 tenant_content_overrides with rollback + checks', () => {
    const q = read('docs/multitenancy/MIGRATION-QUEUE.md');
    const rows = q.split('\n').filter((l) => l.startsWith('| '));
    const i = rows.findIndex((l) => l.includes(path.basename(INTAKE)));
    const j = rows.findIndex((l) => l.includes(path.basename(PIPELINE)));
    expect(i).toBeGreaterThan(0);
    expect(j).toBe(i + 1);
    expect(rows[i]).toContain('tenant_content_overrides');
    for (const r of [rows[i], rows[j]]) {
      expect(r).toContain(`${VALIDATION}/rollback-pack-intake.sql`);
      expect(r).toContain('VTID-05324');
      expect(r).toContain('post-check.sql');
    }
  });

  it('the drift baseline lists both unapplied tables and its count matches', () => {
    const b = JSON.parse(read('scripts/ci/migration-drift-baseline.json'));
    expect(b.known_missing_tables).toEqual(expect.arrayContaining(['tenant_pack_intake', 'tenant_content_pipeline']));
    expect(b.count).toBe(b.known_missing_tables.length);
  });

  it('rollback drops exactly the new objects; pre/post checks and the pgTAP plan are read-only', () => {
    const rb = strip(read(`${VALIDATION}/rollback-pack-intake.sql`));
    expect(rb).toContain('DROP FUNCTION IF EXISTS public.get_tenant_launch_readiness(uuid);');
    expect(rb).toContain('DROP TABLE IF EXISTS public.tenant_content_pipeline;');
    expect(rb).toContain('DROP TABLE IF EXISTS public.tenant_pack_intake;');
    expect(rb.match(/\bDROP\b/g)).toHaveLength(3);
    for (const f of ['pre-check.sql', 'post-check.sql']) {
      expect(strip(read(`${VALIDATION}/${f}`))).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);
    }
    const tap = read(`${VALIDATION}/pgtap-pack-intake.sql`);
    expect(tap).toMatch(/ROLLBACK;\s*$/);
    expect(tap).toContain("throws_ok('SELECT * FROM public.tenant_pack_intake', '42501'");
    expect(tap).toContain("throws_ok('SELECT * FROM public.tenant_content_pipeline', '42501'");
  });
});
