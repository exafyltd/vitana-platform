// VTID-05043 — Track S / S3: tenant self-enrolment guard (migrations A, B, C).
// Behaviour is proven on PGlite by docs/validation/VTID-05043/pglite-migration-check.mjs;
// this suite pins the migration text so a later edit cannot quietly drop a guard.
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const stripComments = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

const A_PATH = 'supabase/migrations/20261010170000_vtid_05043_s3_membership_side_effect_guard.sql';
const B_PATH = 'supabase/migrations/data-fixups/20261010170100_vtid_05043_s3_backfill_drifted_memberships.sql';
const C_PATH = 'supabase/migrations/20261010170200_vtid_05043_s3_switch_tenant_open_signup_only.sql';
const EVIDENCE = 'docs/validation/VTID-05043';

const A = stripComments(read(A_PATH));
const B = stripComments(read(B_PATH));
const C = stripComments(read(C_PATH));
const C_RAW = read(C_PATH);

const TRIGGERS: Array<[string, string]> = [
  ['welcome_chat_on_primary_membership', 'fire_welcome_chat_on_membership'],
  ['founding_seat_on_primary_membership', 'claim_founding_seat_on_membership'],
  ['seed_onboarding_autopilot_on_primary_membership', 'seed_onboarding_autopilot_on_membership'],
  ['trg_create_user_live_room', 'create_user_live_room'],
];

describe('VTID-05043 Migration A — side-effect guard + open_signup', () => {
  it('defines the guard from a transaction-local setting', () => {
    expect(A).toMatch(/CREATE OR REPLACE FUNCTION public\.membership_side_effects_suppressed\(\)\s+RETURNS boolean/);
    expect(A).toContain("current_setting('vitana.suppress_membership_side_effects', true)");
  });

  it.each(TRIGGERS)('recreates %s with the guard, same timing and function', (name, fn) => {
    expect(A).toContain(`DROP TRIGGER IF EXISTS ${name} ON public.user_tenants;`);
    const re = new RegExp(
      `CREATE TRIGGER ${name}\\s+AFTER INSERT ON public\\.user_tenants\\s+FOR EACH ROW\\s+` +
        `WHEN \\(NEW\\.is_primary = true AND NOT public\\.membership_side_effects_suppressed\\(\\)\\)\\s+` +
        `EXECUTE FUNCTION public\\.${fn}\\(\\);`,
    );
    expect(A).toMatch(re);
  });

  it('does not re-emit any trigger function body', () => {
    for (const [, fn] of TRIGGERS) expect(A).not.toMatch(new RegExp(`FUNCTION public\\.${fn}\\(\\)\\s+RETURNS`));
  });

  it('opens exactly maxina and alkalma, asserted with GET DIAGNOSTICS', () => {
    expect(A).toContain('ADD COLUMN IF NOT EXISTS open_signup boolean NOT NULL DEFAULT false');
    expect(A).toContain("UPDATE public.tenants SET open_signup = true WHERE slug IN ('maxina', 'alkalma');");
    expect(A).toContain('GET DIAGNOSTICS n = ROW_COUNT;');
    expect(A).toMatch(/IF n <> 2 THEN\s+RAISE EXCEPTION/);
  });

  it('runs in one transaction', () => {
    expect(A).toMatch(/^BEGIN;/m);
    expect(A).toMatch(/^COMMIT;/m);
  });
});

describe('VTID-05043 Migration B — backfill drifted memberships', () => {
  it('suppresses side effects for its own transaction only', () => {
    expect(B).toMatch(/^BEGIN;/m);
    expect(B).toMatch(/^COMMIT;/m);
    expect(B).toContain("SET LOCAL lock_timeout = '3s';");
    expect(B).toContain("set_config('vitana.suppress_membership_side_effects', 'on', true)");
  });

  it('asserts the drift set: open-signup tenants only, at most 30', () => {
    expect(B).toMatch(/IF n > 30 THEN\s+RAISE EXCEPTION/);
    expect(B).toMatch(/WHERE NOT t\.open_signup;\s+IF closed <> 0 THEN\s+RAISE EXCEPTION/);
  });

  it('asserts the claim set: at most 50', () => {
    expect(B).toMatch(/IF n > 50 THEN\s+RAISE EXCEPTION/);
  });

  it('snapshots into the unexposed archive schema before writing', () => {
    expect(B).toContain('CREATE TABLE legacy_archive.bak_s3_drift_20261010 AS');
    expect(B).toContain('CREATE TABLE legacy_archive.bak_s3_claims_20261010 AS');
    expect(B).toContain('REVOKE ALL ON SCHEMA legacy_archive FROM PUBLIC, anon, authenticated;');
    expect(B.indexOf('bak_s3_drift_20261010 AS')).toBeLessThan(B.indexOf('INSERT INTO public.user_tenants'));
    expect(B.indexOf('bak_s3_claims_20261010 AS')).toBeLessThan(B.indexOf('UPDATE auth.users'));
  });

  it('marks welcome_chat_sent and inserts with ON CONFLICT, primary only when none exists', () => {
    expect(B).toMatch(/UPDATE public\.app_users au\s+SET welcome_chat_sent = true/);
    expect(B).toContain('ON CONFLICT (tenant_id, user_id) DO NOTHING;');
    expect(B).toMatch(/d\.rn = 1 AND NOT EXISTS \(SELECT 1 FROM public\.user_tenants p\s+WHERE p\.user_id = d\.user_id AND p\.is_primary\)/);
  });

  it('leaves exafy_admin claims alone', () => {
    expect(B).toContain("NOT coalesce(u.raw_app_meta_data->>'exafy_admin' = 'true', false)");
  });

  it('post-checks drift = 0 and claims = 0 inside the transaction', () => {
    expect(B).toMatch(/IF drift <> 0 THEN\s+RAISE EXCEPTION/);
    expect(B).toMatch(/IF claims <> 0 THEN\s+RAISE EXCEPTION/);
  });

  it('never deletes', () => {
    expect(B).not.toMatch(/\bDELETE\b/i);
  });
});

describe('VTID-05043 Migration C — switch_to_tenant_by_slug, open signup only', () => {
  it('keeps the signature, SECURITY DEFINER and search_path', () => {
    expect(C).toContain('CREATE OR REPLACE FUNCTION public.switch_to_tenant_by_slug(p_tenant_slug text)');
    expect(C).toContain('SECURITY DEFINER');
    expect(C).toContain("SET search_path TO 'public'");
  });

  it('uses tenants.tenant_id (the live table has no id column)', () => {
    expect(C).not.toMatch(/tenant_record\.id\b/);
    expect(C).toContain('tenant_record.tenant_id');
  });

  it('joins only open_signup tenants and refuses the rest with 42501', () => {
    expect(C).toContain('ELSIF tenant_record.open_signup THEN');
    expect(C).toContain("RAISE EXCEPTION 'TENANT_NOT_JOINABLE' USING ERRCODE = '42501';");
    expect(C).toMatch(/IF v_uid IS NULL THEN\s+RAISE EXCEPTION/);
    expect(C).toMatch(/IF v_is_member OR v_is_exafy THEN/);
  });

  it('writes user_tenants idempotently, primary only when none exists', () => {
    expect(C).toMatch(/INSERT INTO public\.user_tenants[\s\S]*ON CONFLICT \(tenant_id, user_id\) DO NOTHING;/);
    expect(C).toContain('NOT EXISTS (SELECT 1 FROM public.user_tenants p WHERE p.user_id = v_uid AND p.is_primary)');
  });

  it('is write-free in steady state: IS DISTINCT FROM guard, audit only on a real change', () => {
    expect(C).toContain("raw_app_meta_data->>'active_tenant_id' IS DISTINCT FROM tenant_record.tenant_id::text");
    expect(C).toContain('GET DIAGNOSTICS v_switched = ROW_COUNT;');
    expect(C).toMatch(/IF v_switched > 0 OR v_created > 0 THEN\s+INSERT INTO public\.audit_events/);
  });

  it('revokes PUBLIC and anon, grants authenticated', () => {
    expect(C).toContain('REVOKE EXECUTE ON FUNCTION public.switch_to_tenant_by_slug(text) FROM PUBLIC, anon;');
    expect(C).toContain('GRANT EXECUTE ON FUNCTION public.switch_to_tenant_by_slug(text) TO authenticated;');
  });

  it('carries the co-ownership header', () => {
    expect(C_RAW).toMatch(/CO-OWNERSHIP: this function originated in exafyltd\/vitana-v1/);
  });
});

describe('VTID-05043 — the suppression setting is transaction-local everywhere', () => {
  it('no migration in the repo sets vitana.* via ALTER DATABASE / ALTER ROLE', () => {
    const dirs = ['supabase/migrations', 'supabase/migrations/data-fixups'];
    for (const dir of dirs) {
      for (const f of readdirSync(join(root, dir)).filter((n) => n.endsWith('.sql'))) {
        const sql = stripComments(read(`${dir}/${f}`));
        expect({ f, bad: /ALTER\s+(DATABASE|ROLE)[^;]*SET\s+"?vitana\./i.test(sql) }).toEqual({ f, bad: false });
      }
    }
    for (const sql of [A, B, C]) {
      for (const m of sql.match(/set_config\([^)]*\)/g) || []) expect(m).toMatch(/,\s*true\)$/);
    }
  });
});

describe('VTID-05043 — SECURITY DEFINER lockdown rule (VTID-05041)', () => {
  it('sorts after the S2 definer lockdown, so its guard covers these files', () => {
    for (const p of [A_PATH, C_PATH]) expect(p.split('/').pop()! >= '20261010164100').toBe(true);
  });

  it('the only SECURITY DEFINER function (C) revokes PUBLIC and anon in the same file; A creates none', () => {
    expect(A).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(C).toMatch(/REVOKE EXECUTE ON FUNCTION public\.switch_to_tenant_by_slug\(text\) FROM PUBLIC, anon;/);
  });
});

describe('VTID-05043 — rollbacks', () => {
  const rbGuard = `${EVIDENCE}/rollback-s3-guard.sql`;
  const rbSwitch = `${EVIDENCE}/rollback-s3-switch-tenant.sql`;
  const rbBackfill = `${EVIDENCE}/rollback-s3-backfill.sql`;

  it('exist', () => {
    for (const p of [rbGuard, rbSwitch, rbBackfill, `${EVIDENCE}/live-before.sql`]) expect(existsSync(join(root, p))).toBe(true);
  });

  it.each(TRIGGERS)('guard rollback restores the original WHEN for %s', (name, fn) => {
    const sql = stripComments(read(rbGuard));
    expect(sql).toContain(
      `CREATE TRIGGER ${name} AFTER INSERT ON public.user_tenants FOR EACH ROW WHEN ((new.is_primary = true)) EXECUTE FUNCTION public.${fn}();`,
    );
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.membership_side_effects_suppressed();');
  });

  it('switch rollback restores the live body captured before apply, and its grants', () => {
    const live = read(`${EVIDENCE}/live-before.sql`).match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/)![0];
    const rb = read(rbSwitch);
    expect(rb).toContain(live);
    expect(rb).toContain('GRANT EXECUTE ON FUNCTION public.switch_to_tenant_by_slug(text) TO PUBLIC, anon, authenticated;');
  });

  it('backfill rollback deletes only the rows the backfill inserted and restores the snapshots', () => {
    const sql = stripComments(read(rbBackfill));
    expect(sql).toMatch(/DELETE FROM public\.user_tenants ut\s+USING legacy_archive\.bak_s3_drift_20261010 b/);
    expect(sql).toContain('ut.created_at = b.captured_at');
    expect(sql).toContain('welcome_chat_sent = b.welcome_chat_sent_before');
    expect(sql).toContain("jsonb_build_object('active_tenant_id', b.active_tenant_id_before)");
  });
});

describe('VTID-05043 — every file runs under any SQL runner (no psql meta-commands)', () => {
  it.each([A_PATH, B_PATH, C_PATH])('%s', (p) => {
    expect(stripComments(read(p))).not.toMatch(/^\s*\\/m);
  });
});
