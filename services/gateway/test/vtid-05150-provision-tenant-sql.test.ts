/**
 * VTID-05150 — tenant brand pack (20261014000400) and provision_tenant()
 * (20261014000500).
 *  - static pins (always): expand-only migration 1, the trigger's column list,
 *    the grants, the advisory-lock namespace, the computed notification
 *    baseline, the default-tenant policy copy, the Lane A order guard, the
 *    tables the function must never write, rollback shape;
 *  - the SQL harness (scripts/ci/test-vtid-05150-provision-tenant.sh) when a
 *    local PostgreSQL server is available, as the VTID-05041 suite does.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const MIG = path.join(REPO, 'supabase/migrations');
const M1_FILE = '20261014000400_vtid_05150_tenant_brand_pack.sql';
const M2_FILE = '20261014000500_vtid_05150_provision_tenant.sql';
const M1 = fs.readFileSync(path.join(MIG, M1_FILE), 'utf8');
const M2 = fs.readFileSync(path.join(MIG, M2_FILE), 'utf8');
const RB = fs.readFileSync(path.join(REPO, 'docs/validation/VTID-05150/rollback.sql'), 'utf8');
const RBC = fs.readFileSync(path.join(REPO, 'docs/validation/VTID-05150/rollback-complete.sql'), 'utf8');
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');
const FN_SIG = 'public.provision_tenant(text, text, text, uuid, text, text, numeric, text, text[], text, text)';

describe('VTID-05150 migration 1 — brand pack (expand only)', () => {
  const sql = stripComments(M1);

  it('is one transaction with timeouts, sorted after Lane A and before Lane C', () => {
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(M1_FILE > '20261014000300').toBe(true);
    expect(M2_FILE < '20261014000600').toBe(true);
  });

  it('adds the 14 columns with IF NOT EXISTS and constant defaults equal to today\'s behaviour', () => {
    const cols = [...sql.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)\s+([^\n]+)/g)].map((m) => [m[1], m[2].trim().replace(/[,;]$/, '')]);
    expect(cols.map((c) => c[0])).toEqual([
      'display_name', 'brand', 'legal_entity_line', 'support_email', 'sender_name', 'sender_email', 'default_locale',
      'enabled_locales', 'timezone', 'currency', 'landing', 'persona_facts', 'provisioned_at', 'provisioned_by',
    ]);
    const def = Object.fromEntries(cols);
    expect(def.default_locale).toBe("text   NOT NULL DEFAULT 'de'");
    expect(def.enabled_locales).toBe("text[] NOT NULL DEFAULT '{de,en,es,sr,fr,pl,pt,ru,tr,zh,ar}'::text[]");
    expect(def.timezone).toBe("text   NOT NULL DEFAULT 'Europe/Berlin'");
    expect(def.currency).toBe("text   NOT NULL DEFAULT 'EUR'");
  });

  it('never drops, renames or rewrites an existing column; the backfill writes new columns only', () => {
    expect(sql).not.toMatch(/DROP\s+COLUMN|RENAME|ALTER\s+COLUMN/i);
    const updates = sql.match(/UPDATE public\.tenant_settings SET[\s\S]*?WHERE[^;]*;/g) ?? [];
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u).not.toMatch(/\b(profile|branding|feature_flags|integrations|domains|billing|updated_at|updated_by)\s*=/);
      expect(u).toMatch(/AND provisioned_at IS NULL AND display_name IS NULL/);
    }
    expect(sql).toContain("'2e7528b8-472a-4356-88da-0280d4639cce'");
    expect(sql).toContain("'73cc592f-84ec-457a-b0f7-25a082d7e011'");
  });

  it('CHECKs are added NOT VALID then VALIDATEd', () => {
    expect(sql).toMatch(/\) NOT VALID;/);
    expect(sql).toContain('VALIDATE CONSTRAINT tenant_settings_brand_pack_check');
  });

  it('the validation trigger never fires on the columns the tenant-admin PUT writes', () => {
    const m = sql.match(/BEFORE INSERT OR UPDATE OF ([^\n]+)\n/);
    expect(m).not.toBeNull();
    expect(m![1].split(',').map((s) => s.trim())).toEqual(['enabled_locales', 'default_locale', 'timezone', 'brand', 'landing']);
    expect(sql).toMatch(/tenant_settings_brand_pack_validate\(\)\s*RETURNS trigger\s*LANGUAGE plpgsql\s*SECURITY INVOKER/);
  });

  it('reserved_tenant_slugs is service_role only; the merge function is service_role only and INVOKER', () => {
    expect(sql).toContain('ALTER TABLE public.reserved_tenant_slugs ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.reserved_tenant_slugs FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.tenant_settings_merge_feature_flags(uuid, jsonb, boolean, uuid) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.tenant_settings_merge_feature_flags(uuid, jsonb, boolean, uuid) TO service_role;');
    expect(sql).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(sql).toContain("coalesce(s.feature_flags, '{}'::jsonb) || EXCLUDED.feature_flags");
    expect(sql).toContain("coalesce(p_flags, '{}'::jsonb) - 'jev'");
  });
});

describe('VTID-05150 migration 2 — provision_tenant()', () => {
  const sql = stripComments(M2);

  it('refuses to apply before migration 1 and before Lane A M1 (tenants.is_default/is_platform)', () => {
    expect(sql).toContain("to_regclass('public.reserved_tenant_slugs') IS NULL");
    expect(sql).toContain("column_name IN ('is_default', 'is_platform')) <> 2");
    expect(M2).toContain('apply Lane A M1 (20261014000100, VTID-05149) first');
  });

  it('is SECURITY DEFINER with a pinned search_path, revoked from PUBLIC/anon/authenticated, granted to service_role', () => {
    expect(sql).toMatch(/RETURNS jsonb\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public/);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${FN_SIG} FROM PUBLIC, anon, authenticated;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${FN_SIG} TO service_role;`);
    expect(sql).not.toMatch(/GRANT[^;]*provision_tenant[^;]*TO[^;]*\b(anon|authenticated|public)\b/i);
    expect(sql).toContain('DO $check$');
  });

  it('serialises per slug in the reserved advisory-lock namespace 42001 (documented)', () => {
    expect(sql).toContain('PERFORM pg_advisory_xact_lock(42001, hashtext(p_slug));');
    expect(M2).toMatch(/namespace 42001 is\s+(-- )?reserved for provision_tenant/);
  });

  it('computes the notification baseline at call time (no hardcoded type list) and copies the default tenant\'s policies', () => {
    expect(sql).toContain('HAVING count(DISTINCT c.tenant_id) = v_base_n');
    expect(sql).toContain('bool_or(c.enabled)');
    expect(sql).toContain('WHERE t.is_default LIMIT 1');
    expect(sql).toContain("RAISE EXCEPTION 'NO_DEFAULT_TENANT'");
    expect(sql).not.toMatch(/'(post_like|chat_mention|reminder_due)'/);
    expect(sql).not.toMatch(/'(gpt-4o|chatgpt|claude)'/);
  });

  it('inserts the tenant without naming is_default/is_platform/open_signup/is_active (column defaults: invite-only)', () => {
    expect(sql).toContain('INSERT INTO public.tenants (name, slug) VALUES (v_name, p_slug)');
  });

  it('refuses legacy (never provisioned) slugs and service/test-account admin emails', () => {
    expect(sql).toContain("IF v_existing_prov IS NULL OR v_existing_name IS DISTINCT FROM v_name THEN\n      RAISE EXCEPTION 'SLUG_TAKEN'");
    expect(sql).toContain('public.service_bot_accounts');
    expect(sql).toContain('public.notification_test_actors');
    expect(sql).toContain("raw_app_meta_data ->> 'exafy_admin' = 'true'");
  });

  it('never writes a member-facing table (no fan-out trigger can fire)', () => {
    for (const t of ['user_tenants', 'memberships', 'app_users', 'profiles', 'chat_messages', 'user_notifications', 'founding_members']) {
      expect(sql).not.toMatch(new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+(public\\.)?${t}\\b`, 'i'));
    }
    expect(sql).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+auth\./i);
    const writes = [...sql.matchAll(/INSERT INTO public\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(writes)].sort()).toEqual([
      'ai_provider_policies', 'chat_group_members', 'chat_groups', 'notification_type_controls',
      'tenant_autopilot_settings', 'tenant_invitations', 'tenant_settings', 'tenants',
    ]);
    expect(sql).not.toMatch(/\bUPDATE public\./);
    expect(sql).not.toMatch(/\bDELETE FROM\b/i);
  });

  it('returns the documented shape', () => {
    for (const k of ["'tenant_id'", "'slug'", "'created'", "'invitation'", "'reused'", "'ensured'", "'notification_controls'", "'ai_policies'", "'autopilot_settings'", "'system_group'"]) {
      expect(sql).toContain(k);
    }
  });
});

describe('VTID-05150 rollback', () => {
  it('drops columns only when nothing was provisioned; otherwise backs up and stops', () => {
    expect(RB).toContain('WHERE provisioned_at IS NOT NULL');
    expect(RB).toContain('CREATE TABLE public.bak_vtid_05150_tenant_settings AS');
    expect(RB).toContain('STOPPED before dropping columns');
    expect(RB).toContain(`DROP FUNCTION IF EXISTS ${FN_SIG};`);
    expect(RBC).toContain('MAY RUN ONLY WHEN');
    expect(RBC).toContain("to_regclass('public.bak_vtid_05150_tenant_settings') IS NULL");
  });
});

const pgBin = (() => {
  try {
    const dirs = fs.readdirSync('/usr/lib/postgresql').sort();
    const bin = `/usr/lib/postgresql/${dirs[dirs.length - 1]}/bin`;
    return fs.existsSync(`${bin}/initdb`) ? bin : null;
  } catch {
    return null;
  }
})();

describe('VTID-05150 SQL harness', () => {
  (pgBin ? it : it.skip)('fixture → Lane A M1 → both migrations twice → assertions → rollback rehearsal', () => {
    const out = execFileSync(path.join(REPO, 'scripts/ci/test-vtid-05150-provision-tenant.sh'), {
      env: { ...process.env, PGBIN: pgBin!, PGPORT_TEST: '55452' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('VTID-05150: all assertions passed');
    expect(out).toContain('ok: maxina/alkalma unchanged (md5 of every row), zero member-facing writes');
    expect(out).toContain('rollback: stopped before dropping columns');
    expect(out).toContain('order guard: M2 refused before Lane A M1');
    expect(out).toContain('VTID-05150: harness passed');
  }, 180_000);
});
