/**
 * VTID-05041 — Track S / S2: SECURITY DEFINER functions exposed to clients.
 *
 * write_fact, get_current_facts, recall_at_time_range and
 * memory_facts_semantic_search take p_user_id, never check auth.uid(), and
 * were executable by `authenticated` (any member could read/overwrite any
 * member's memory facts). get_user_profile_by_identifier returned every
 * visible member's email to `anon`. fn_consume_credits is closed by
 * VTID-04981, which the S2 self-check requires. This suite:
 *  - pins the S2 migration (revokes, profile shape, grants, self-check),
 *  - fails the build if any LATER migration grants these functions to
 *    members again or puts `email` back into the profile lookup,
 *  - pins that every gateway caller uses the service-role key,
 *  - guards new SECURITY DEFINER functions: a migration newer than S2 that
 *    creates one must revoke PUBLIC and anon in the same file, or say why
 *    not with `-- definer-public: <reason>`,
 *  - runs the SQL harness (scripts/ci/test-vtid-05041-…) when a local
 *    PostgreSQL server is available, as the VTID-04981 suite does.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const MIGRATIONS = path.join(REPO, 'supabase/migrations');
const S2 = '20261010164100_vtid_05041_definer_functions_lockdown.sql';
const CONSUME_LOCKDOWN = '20261008170000_vtid_04981_consume_credits_lockdown.sql';
const MIGRATION = fs.readFileSync(path.join(MIGRATIONS, S2), 'utf8');
const MEMORY_FNS = ['write_fact', 'get_current_facts', 'recall_at_time_range', 'memory_facts_semantic_search'];

const PROFILE_COLUMNS =
  'user_id uuid, display_name text, full_name text, handle text, avatar_url text, cover_url text, bio text, location text, created_at timestamp with time zone, linkedin_url text, linkedin_headline text, linkedin_summary text, linkedin_synced_at timestamp with time zone, instagram_url text, instagram_bio text, instagram_followers_count integer, instagram_synced_at timestamp with time zone, instagram_interests text[], tiktok_url text, tiktok_bio text, tiktok_followers_count integer, tiktok_synced_at timestamp with time zone, tiktok_content_themes text[], youtube_url text, youtube_description text, youtube_subscribers_count integer, youtube_synced_at timestamp with time zone, youtube_content_categories text[], facebook_url text, facebook_bio text, facebook_synced_at timestamp with time zone, facebook_interests text[], x_url text, x_bio text, x_followers_count integer, x_synced_at timestamp with time zone, x_topics text[], longevity_archetype text, account_type text, verification_status text';

/** SQL without `--` comments, so prose in headers never satisfies or trips a check. */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');
const sqlFiles = () => fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));

describe('VTID-05041 SECURITY DEFINER lockdown (S2)', () => {
  it('sorts after VTID-04981, which it requires', () => {
    expect(S2 > CONSUME_LOCKDOWN).toBe(true);
    expect(fs.existsSync(path.join(MIGRATIONS, CONSUME_LOCKDOWN))).toBe(true);
    expect(MIGRATION).toContain('apply VTID-04981 (20261008170000) first');
  });

  it('revokes members from every overload of the four memory functions and keeps the gateway', () => {
    const sql = stripComments(MIGRATION);
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
    expect(sql).toContain(
      "WHERE p.proname IN ('write_fact', 'get_current_facts', 'recall_at_time_range', 'memory_facts_semantic_search')",
    );
    expect(sql).toContain("EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.fn);");
    expect(sql).toContain("EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.fn);");
    // Access only: no memory function body is redefined here.
    for (const fn of MEMORY_FNS) expect(sql).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION[^(]*\\b${fn}\\(`, 'i'));
    // fn_consume_credits is owned by VTID-04981, not re-revoked here.
    expect(sql).not.toMatch(/(REVOKE|GRANT)[^;]*fn_consume_credits/i);
  });

  it('recreates the profile lookup without email and re-grants anon/authenticated/service_role', () => {
    const sql = stripComments(MIGRATION);
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.get_user_profile_by_identifier(text);');
    const m = sql.match(/CREATE FUNCTION public\.get_user_profile_by_identifier\(identifier text\)\s+RETURNS TABLE\(([^)]*)\)/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(PROFILE_COLUMNS);
    expect(sql).not.toMatch(/p\.email/);
    // Same three branches and the same visibility gate as vitana-v1 20260721124500.
    expect(sql.match(/AND gcp\.is_visible = true;/g)).toHaveLength(3);
    expect(sql).toContain('WHERE p.handle = ident');
    expect(sql).toContain('WHERE p.vitana_id = ident');
    expect(sql).toContain('WHERE p.user_id = identifier::uuid');
    expect(sql).toMatch(/SECURITY DEFINER\s+SET search_path TO 'public'/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.get_user_profile_by_identifier(text) FROM PUBLIC;');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.get_user_profile_by_identifier(text) TO anon, authenticated, service_role;',
    );
  });

  it('checks the end state on apply, by effect', () => {
    expect(MIGRATION).toContain('DO $check$');
    expect(MIGRATION).toContain('must not be executable by members (authenticated/anon)');
    expect(MIGRATION).toContain('the gateway (service_role) must keep EXECUTE on');
    expect(MIGRATION).toContain("to_regprocedure('public.fn_consume_credits(uuid, uuid, integer, text, text, text)')");
    expect(MIGRATION).toContain("pg_get_function_result(profile) ILIKE '%email%'");
    expect(MIGRATION).not.toMatch(/schema_migrations/);
  });

  it('no later migration grants the locked functions to members again or re-adds email to the profile lookup', () => {
    const later = sqlFiles().filter((f) => f > S2);
    for (const f of later) {
      const sql = stripComments(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
      for (const fn of [...MEMORY_FNS, 'fn_consume_credits']) {
        const grants = sql.match(new RegExp(`GRANT[^;]*\\b${fn}\\b[^;]*;`, 'gi')) ?? [];
        for (const g of grants) {
          // Only the grantees count: `public.<fn>` is the schema, not the PUBLIC role.
          const grantees = g.replace(/^[\s\S]*?\bTO\b/i, '');
          expect({ file: f, grantees }).toEqual({
            file: f,
            grantees: expect.not.stringMatching(/\b(authenticated|anon|public)\b/i),
          });
        }
      }
      const profile = sql.match(/FUNCTION\s+(public\.)?get_user_profile_by_identifier\s*\([^)]*\)\s*RETURNS\s+TABLE\s*\(([^)]*)\)/i);
      if (profile) expect({ file: f, returns: profile[2] }).toEqual({ file: f, returns: expect.not.stringMatching(/\bemail\b/i) });
    }
  });

  it('every gateway caller of the memory functions uses the service-role key', () => {
    const read = (p: string) => fs.readFileSync(path.join(REPO, 'services/gateway/src', p), 'utf8');
    const remember = read('services/memory/remember.ts');
    expect(remember).toContain('`${url}/rest/v1/rpc/write_fact`');
    expect(remember).toContain('process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE');
    expect(remember).toContain("client.rpc('write_fact', payload)");
    expect(read('services/memory-facts-service-repository.ts')).toContain("sb.rpc('get_current_facts', args)");
    const facts = read('services/memory-facts-service.ts');
    expect(facts).toMatch(/function createServiceClient\(\)[\s\S]*?SUPABASE_SERVICE_ROLE_KEY \|\| process\.env\.SUPABASE_SERVICE_ROLE/);
    expect(facts).toContain('/rest/v1/rpc/memory_facts_semantic_search');
    const recall = read('services/tool-recall-conversation.ts');
    expect(recall).toContain('/rest/v1/rpc/recall_at_time_range');
    expect(recall).toContain('Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`');
    // The client-path callers of rememberFact() pass the service client.
    expect(read('routes/memory-garden.ts')).toContain("import { getSupabase } from '../lib/supabase';");
  });

  it('a migration newer than S2 that creates a SECURITY DEFINER function revokes PUBLIC and anon, or says why not', () => {
    const offenders: string[] = [];
    for (const f of sqlFiles().filter((n) => n >= S2)) {
      const raw = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
      const sql = stripComments(raw);
      if (!/SECURITY\s+DEFINER/i.test(sql)) continue;
      const revokes = sql.match(/REVOKE[^;]*;/gi) ?? [];
      const revokesPublic = revokes.some((r) => /\bFROM\b[\s\S]*\bPUBLIC\b/i.test(r));
      const revokesAnon = revokes.some((r) => /\bFROM\b[\s\S]*\banon\b/i.test(r));
      const reasoned = /^\s*--\s*definer-public:\s*\S/m.test(raw);
      if (!reasoned && !(revokesPublic && revokesAnon)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
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
  (pgBin ? it : it.skip)('reproduces the live exposure, refuses before VTID-04981, applies twice and passes the SQL assertions', () => {
    const out = execFileSync(path.join(REPO, 'scripts/ci/test-vtid-05041-definer-lockdown.sh'), {
      env: { ...process.env, PGBIN: pgBin!, PGPORT_TEST: '55443' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('order guard: S2 refused before VTID-04981 and rolled back');
    expect(out).toContain('VTID-05041: all assertions passed');
  }, 120_000);
});
