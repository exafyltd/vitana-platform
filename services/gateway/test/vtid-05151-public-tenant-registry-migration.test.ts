// VTID-05151 — multi-tenant M0 lane C: public tenant registry + legacy landing seed.
// Behaviour is proven on a local Postgres by scripts/ci/test-vtid-05151-public-tenant-registry.sh
// (run below when a Postgres server is installed); this suite pins the migration text so a later
// edit cannot quietly widen what anonymous visitors can read.
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const stripComments = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

const REGISTRY_PATH = 'supabase/migrations/20261014000600_vtid_05151_public_tenant_registry.sql';
const SEED_PATH = 'supabase/migrations/20261014000700_vtid_05151_seed_legacy_tenant_landing.sql';
const EVIDENCE = 'docs/validation/VTID-05151';

const REGISTRY_RAW = read(REGISTRY_PATH);
const REGISTRY = stripComments(REGISTRY_RAW);
const SEED = stripComments(read(SEED_PATH));

const RETURNS =
  /RETURNS TABLE \(\s*tenant_id\s+uuid,\s*slug\s+text,\s*name\s+text,\s*display_name\s+text,\s*open_signup\s+boolean,\s*brand\s+jsonb,\s*landing\s+jsonb,\s*locales\s+jsonb\s*\)/;

const fnBody = (name: string) => {
  const m = REGISTRY.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([^)]*\\)([\\s\\S]*?)\\$fn\\$([\\s\\S]*?)\\$fn\\$`));
  if (!m) throw new Error(`function ${name} not found`);
  return { header: m[1], body: m[2] };
};

describe('VTID-05151 public tenant registry migration', () => {
  it('runs in one transaction with lock and statement timeouts', () => {
    expect(REGISTRY).toMatch(/^BEGIN;/m);
    expect(REGISTRY).toMatch(/^COMMIT;/m);
    expect(REGISTRY).toContain("SET LOCAL lock_timeout = '3s';");
    expect(REGISTRY).toContain("SET LOCAL statement_timeout = '30s';");
  });

  it('is expand-only: no table, column or policy change', () => {
    expect(REGISTRY).not.toMatch(/\b(ALTER|DROP|CREATE)\s+(TABLE|POLICY)\b/i);
    expect(REGISTRY).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO|public\.|FROM)/i);
  });

  it('the internal function is not SECURITY DEFINER and is revoked from every client role', () => {
    const internal = fnBody('_tenant_public_registry');
    expect(internal.header).toMatch(RETURNS);
    expect(internal.header).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(internal.header).toMatch(/LANGUAGE sql\s+STABLE/);
    expect(REGISTRY).toContain('REVOKE ALL ON FUNCTION public._tenant_public_registry() FROM PUBLIC, anon, authenticated;');
    expect(REGISTRY).not.toMatch(/GRANT[^;]*_tenant_public_registry[^;]*;/);
  });

  it.each(['list_public_tenants', 'resolve_tenant'])('%s is a STABLE SECURITY DEFINER wrapper with a pinned search_path', (fn) => {
    const { header, body } = fnBody(fn);
    expect(header).toMatch(RETURNS);
    expect(header).toMatch(/LANGUAGE sql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public, pg_temp/);
    expect(body).toContain('FROM public._tenant_public_registry() r');
    // Explicit column list, never SELECT * or a raw row.
    expect(body).not.toMatch(/SELECT\s+\*/i);
    expect(body).not.toMatch(/to_jsonb/);
  });

  it('revokes PUBLIC/anon/authenticated first, then grants EXECUTE to anon, authenticated, service_role only', () => {
    for (const sig of ['list_public_tenants()', 'resolve_tenant(text)']) {
      expect(REGISTRY).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(REGISTRY).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO anon, authenticated, service_role;`);
      expect(REGISTRY.indexOf(`REVOKE ALL ON FUNCTION public.${sig}`)).toBeLessThan(
        REGISTRY.indexOf(`GRANT EXECUTE ON FUNCTION public.${sig}`),
      );
    }
  });

  it('carries the definer-public reason the VTID-05041 guard asks for', () => {
    expect(REGISTRY_RAW).toMatch(/^--\s*definer-public:\s*anonymous visitors resolve a community's public brand\/landing fields/m);
  });

  it('resolve_tenant matches one exact normalised slug and never falls back', () => {
    const { body } = fnBody('resolve_tenant');
    expect(body).toContain('WHERE r.slug = lower(btrim(p_slug))');
    expect(body).not.toMatch(/maxina|coalesce|LIMIT|ILIKE|LIKE/i);
  });

  it('only whitelisted keys leave the internal function', () => {
    const { body } = fnBody('_tenant_public_registry');
    // The raw rows stay inside the CTE: the final SELECT reads named columns of src only.
    const finalSelect = body.slice(body.lastIndexOf('SELECT src.tenant_id'));
    // Only these whitelisted columns of the raw settings row may be read (lane B, VTID-05150, names included).
    expect(finalSelect).not.toMatch(/src\.(tj|sj)\b(?!\s*->>?\s*'(locales|enabled_locales|display_name)')/);
    expect(finalSelect).not.toMatch(/to_jsonb\(/);
    const brandKeys = [...finalSelect.matchAll(/'(\w+)',\s+coalesce\(src\.b/g)].map((m) => m[1]);
    expect(brandKeys).toEqual(['accent', 'bg', 'fg', 'logo_path', 'favicon_path', 'og_image_path']);
    const landingKeys = [...finalSelect.matchAll(/'(\w+)',\s+(?:\(SELECT|CASE WHEN jsonb_typeof\(src\.l)/g)].map((m) => m[1]);
    expect(landingKeys).toEqual(['tagline', 'intro', 'auto_switch_on_visit', 'post_login_path', 'oauth']);
    for (const secret of ['policy_profile', 'feature_flags', 'integrations', 'billing', 'domains', 'support_email']) {
      expect(body).not.toContain(secret);
    }
  });

  it('filters inactive, slug-less and (once lane A adds the column) platform rows', () => {
    const { body } = fnBody('_tenant_public_registry');
    expect(body).toMatch(/WHERE t\.is_active\s+AND t\.slug IS NOT NULL\s+AND coalesce\(\(to_jsonb\(t\) ->> 'is_platform'\)::boolean, false\) = false/);
  });

  it('asserts its end state by effect', () => {
    expect(REGISTRY).toContain("has_function_privilege('anon', 'public.list_public_tenants()', 'EXECUTE')");
    expect(REGISTRY).toContain("has_function_privilege('anon', 'public.resolve_tenant(text)', 'EXECUTE')");
    expect(REGISTRY).toContain("has_function_privilege('authenticated', 'public._tenant_public_registry()', 'EXECUTE')");
    expect(REGISTRY).toContain("WHERE slug IN ('maxina', 'alkalma')) <> 2");
    expect(REGISTRY).toContain("public.resolve_tenant('zz-not-a-tenant')");
  });
});

describe('VTID-05151 legacy landing seed migration', () => {
  it('snapshots to legacy_archive before writing, in one transaction', () => {
    expect(SEED).toMatch(/^BEGIN;/m);
    expect(SEED).toMatch(/^COMMIT;/m);
    expect(SEED).toContain('REVOKE ALL ON SCHEMA legacy_archive FROM PUBLIC, anon, authenticated;');
    expect(SEED.indexOf('CREATE TABLE IF NOT EXISTS legacy_archive.bak_vtid_05151_tenant_settings')).toBeLessThan(
      SEED.indexOf('UPDATE public.tenant_settings'),
    );
  });

  it('lets existing keys win (seed || existing) and touches exactly 2 rows', () => {
    expect(SEED).toContain(`'{"display_name":"AlKalma","brand_accent":"#3B82F6","brand_bg":"#EFF6FF","brand_fg":"#1A1A1A"}'::jsonb\n                    || coalesce(s.branding, '{}'::jsonb)`);
    expect(SEED).toContain(`'{"intro":true,"auto_switch_on_visit":true,"post_login_path":"/home","oauth":true}'::jsonb`);
    expect(SEED).toContain(`'{"intro":true,"auto_switch_on_visit":true,"post_login_path":"/onboarding/welcome","oauth":true}'::jsonb`);
    expect(SEED).toMatch(/IF total <> 2 THEN\s+RAISE EXCEPTION/);
    expect(SEED).not.toMatch(/DELETE|DROP|TRUNCATE/i);
  });
});

describe('VTID-05151 evidence', () => {
  it.each(['rollback-registry.sql', 'rollback-seed.sql', 'pre-check.sql', 'post-check.sql', 'plan-sparring.md', 'acceptance.md'])(
    '%s exists',
    (f) => {
      expect(existsSync(join(root, EVIDENCE, f))).toBe(true);
    },
  );

  it('the registry rollback drops exactly the three functions and touches no data', () => {
    const rb = stripComments(read(`${EVIDENCE}/rollback-registry.sql`));
    expect(rb).toContain('DROP FUNCTION IF EXISTS public.resolve_tenant(text), public.list_public_tenants(), public._tenant_public_registry();');
    expect(rb).not.toMatch(/\b(UPDATE|DELETE|INSERT|TABLE)\b/i);
  });

  it('the seed rollback restores the two rows from the snapshot', () => {
    const rb = stripComments(read(`${EVIDENCE}/rollback-seed.sql`));
    expect(rb).toContain('FROM legacy_archive.bak_vtid_05151_tenant_settings b');
    expect(rb).toContain("WHERE t.slug IN ('maxina', 'alkalma')");
    expect(rb).toMatch(/IF n <> 2 THEN\s+RAISE EXCEPTION/);
  });

  it('both migrations are recorded in the migration queue', () => {
    const queue = read('docs/multitenancy/MIGRATION-QUEUE.md');
    expect(queue).toContain('20261014000600_vtid_05151_public_tenant_registry.sql');
    expect(queue).toContain('20261014000700_vtid_05151_seed_legacy_tenant_landing.sql');
  });

  const pgBin = (() => {
    try {
      const dirs = readdirSync('/usr/lib/postgresql').sort();
      const bin = `/usr/lib/postgresql/${dirs[dirs.length - 1]}/bin`;
      return existsSync(`${bin}/initdb`) ? bin : null;
    } catch {
      return null;
    }
  })();
  (pgBin ? it : it.skip)('applies twice, rolls back, re-applies and passes the SQL assertions on a local Postgres', () => {
    const out = execFileSync(join(root, 'scripts/ci/test-vtid-05151-public-tenant-registry.sh'), {
      env: { ...process.env, PGBIN: pgBin!, PGPORT_TEST: '55452' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('order guard: seed refused before the registry and rolled back');
    expect(out).toContain('idempotent: second registry and seed apply changed nothing');
    expect(out).toContain('rollback: seed restored, functions dropped');
    expect(out).toContain('VTID-05151: all assertions passed');
  }, 120_000);
});
