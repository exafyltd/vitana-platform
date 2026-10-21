/**
 * VTID-04888 — CLAUDE.md rule 45: test/service accounts never reach a real member through Find-a-Match,
 * the matchmaker profile fallback, or the member profile lists.
 *
 * The behaviour is proven on a throwaway Postgres by scripts/ci/test-vtid-04888-rule45.sh. This suite pins
 * the migration text against the live definitions captured before apply (only the marked lines may differ),
 * the triggers and grants, the fix-up's guard, and the gateway fallback filter.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const MIGRATION = path.join(ROOT, 'supabase/migrations/20261005120000_vtid_04888_rule45_intents_profiles.sql');
const FIXUP = path.join(ROOT, 'supabase/migrations/data-fixups/20261005120100_vtid_04888_rule45_cleanup.sql');
const BEFORE = path.join(ROOT, 'docs/validation/VTID-04888/live-functions-before.sql');
const ROLLBACK = path.join(ROOT, 'docs/validation/VTID-04888/rollback.sql');
const MARK = '-- VTID-04888 rule 45';
const FUNCTIONS = ['search_intent_catalog_v2', 'compute_intent_matches_v2', 'search_intent_catalog', 'compute_intent_matches'];

const read = (p: string) => fs.readFileSync(p, 'utf8');

function functionBlocks(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)\((?:(?!CREATE OR REPLACE FUNCTION)[\s\S])*?\n\$function\$;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.set(m[1], m[0]);
  return out;
}

describe('VTID-04888 migration: intent RPCs', () => {
  const migration = read(MIGRATION);
  const before = functionBlocks(read(BEFORE));
  const after = functionBlocks(migration);

  it('captures all four live definitions', () => {
    expect([...before.keys()].sort()).toEqual([...FUNCTIONS].sort());
  });

  it.each(FUNCTIONS)('%s differs from the live body only by the marked rule-45 lines', (fn) => {
    const a = after.get(fn)!;
    expect(a).toBeDefined();
    const added = a.split('\n').filter((l) => l.includes(MARK));
    const rest = a.split('\n').filter((l) => !l.includes(MARK)).join('\n');
    expect(rest).toBe(before.get(fn));
    // Two pool predicates (candidates + pool-size count) and one early return.
    expect(added).toHaveLength(3);
    const pool = added.filter((l) => l.includes('AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts xb WHERE xb.user_id = ui.requester_user_id)'));
    expect(pool).toHaveLength(2);
    for (const l of pool) expect(l).toContain('AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors xa WHERE xa.user_id = ui.requester_user_id)');
    const early = added.find((l) => l.trim().startsWith('IF EXISTS'))!;
    expect(early).toBeDefined();
    if (fn.startsWith('compute')) {
      expect(early).toContain('xb.user_id = src.requester_user_id');
      expect(early).toContain('THEN RETURN 0; END IF;');
    } else {
      expect(early).toContain('xb.user_id = p_user_id');
      expect(early).toContain('THEN RETURN; END IF;');
    }
  });

  it('inlines the anti-join in the RPCs (no per-row helper call)', () => {
    for (const fn of FUNCTIONS) expect(after.get(fn)).not.toContain('is_excluded_account');
  });
});

describe('VTID-04888 migration: helper, triggers, grants', () => {
  const migration = read(MIGRATION);

  it('runs in one transaction', () => {
    expect(migration.trim().startsWith('--')).toBe(true);
    expect(migration).toMatch(/^BEGIN;$/m);
    expect(migration.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('helper is not callable by clients', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.is_excluded_account(p_user_id uuid)');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.is_excluded_account(uuid) FROM PUBLIC;');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.is_excluded_account(uuid) FROM anon, authenticated;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.is_excluded_account(uuid) TO service_role;');
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.is_excluded_account\(uuid\) TO (anon|authenticated|PUBLIC)/);
  });

  it.each([
    ['trg_gcp_hide_excluded_accounts', 'BEFORE INSERT OR UPDATE ON public.global_community_profiles', 'gcp_hide_excluded_account'],
    ['trg_service_bot_hide_profile', 'AFTER INSERT ON public.service_bot_accounts', 'hide_profile_of_listed_account'],
    ['trg_test_actor_hide_profile', 'AFTER INSERT ON public.notification_test_actors', 'hide_profile_of_listed_account'],
    ['trg_intent_matches_skip_excluded', 'BEFORE INSERT ON public.intent_matches', 'intent_matches_skip_excluded'],
  ])('%s is created idempotently', (name, on, fn) => {
    expect(migration).toContain(`DROP TRIGGER IF EXISTS ${name} ON`);
    expect(migration).toContain(`CREATE TRIGGER ${name}\n  ${on}\n  FOR EACH ROW EXECUTE FUNCTION public.${fn}();`);
  });

  it('trigger functions are SECURITY DEFINER (members update their own profile as authenticated)', () => {
    for (const fn of ['gcp_hide_excluded_account', 'hide_profile_of_listed_account', 'intent_matches_skip_excluded']) {
      const block = migration.slice(migration.indexOf(`FUNCTION public.${fn}()`));
      expect(block.slice(0, 200)).toContain('SECURITY DEFINER');
      expect(block.slice(0, 200)).toContain("SET search_path TO 'public'");
    }
  });

  it('backstop resolves both intents through user_intents.requester_user_id and the profile target', () => {
    expect(migration).toContain('public.is_excluded_account(NEW.external_target_id)');
    expect(migration).toContain('WHERE ui.intent_id IN (NEW.intent_a_id, NEW.intent_b_id)');
    expect(migration).toContain('AND public.is_excluded_account(ui.requester_user_id)) THEN\n    RETURN NULL;');
  });
});

describe('VTID-04888 data fix-up', () => {
  const fixup = read(FIXUP);

  it('aborts before any change when something real hangs off a match', () => {
    const guard = fixup.indexOf("RAISE EXCEPTION 'VTID-04888 fix-up aborted");
    expect(guard).toBeGreaterThan(0);
    for (const t of ['intent_events', 'intent_disputes', 'user_ratings', 'service_payments', 'match_notifications', 'autopilot_prompts']) {
      expect(fixup).toContain(`FROM public.${t}`);
    }
    for (const write of ['UPDATE public.global_community_profiles', 'UPDATE public.user_intents', 'DELETE FROM public.intent_match_recommendations', 'UPDATE public.intent_match_recommendations', 'DELETE FROM public.intent_matches']) {
      expect(fixup.indexOf(write)).toBeGreaterThan(guard);
    }
  });

  it('only touches excluded accounts and their rows', () => {
    expect(fixup).toContain('SELECT user_id FROM public.service_bot_accounts');
    expect(fixup).toContain('SELECT user_id FROM public.notification_test_actors');
    expect(fixup).not.toMatch(/\bTRUNCATE\b/i);
    expect(fixup).not.toMatch(/DELETE FROM public\.\w+\s*;/);
    expect(fixup.trim().endsWith('COMMIT;')).toBe(true);
  });
});

describe('VTID-04888 rollback', () => {
  it('restores the captured bodies and drops the new objects', () => {
    const rollback = read(ROLLBACK);
    const restored = functionBlocks(rollback);
    const before = functionBlocks(read(BEFORE));
    for (const fn of FUNCTIONS) expect(restored.get(fn)).toBe(before.get(fn));
    expect(rollback).not.toContain(MARK);
    for (const t of ['trg_intent_matches_skip_excluded', 'trg_gcp_hide_excluded_accounts', 'trg_service_bot_hide_profile', 'trg_test_actor_hide_profile']) {
      expect(rollback).toContain(`DROP TRIGGER IF EXISTS ${t}`);
    }
    expect(rollback).toContain('DROP FUNCTION IF EXISTS public.is_excluded_account(uuid);');
  });
});

// ---------------------------------------------------------------------------------------------------------
// Gateway: matchmaker profile fallback never offers an excluded account.
// ---------------------------------------------------------------------------------------------------------

const mockSupabase = { tag: 'sb' };
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => mockSupabase }));
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIds: jest.fn(async () => new Set(['bot-1', 'test-1'])),
}));
jest.mock('../src/services/matchmaker-agent-repository', () => ({
  fetchProfilesWithDancePreferences: jest.fn(async () => ({
    data: [
      { user_id: 'bot-1', vitana_id: 'V-B', display_name: 'Bot', city: null, dance_preferences: { varieties: ['salsa'] } },
      { user_id: 'real-1', vitana_id: 'V-1', display_name: 'Ana', city: 'Berlin', dance_preferences: { varieties: ['salsa'] } },
      { user_id: 'test-1', vitana_id: 'V-T', display_name: 'E2E', city: null, dance_preferences: { varieties: ['salsa'] } },
      { user_id: 'real-2', vitana_id: 'V-2', display_name: 'Ben', city: 'Wien', dance_preferences: { varieties: ['tango'] } },
    ],
  })),
}));

describe('VTID-04888 matchmaker profile fallback', () => {
  it('drops service/test accounts and keeps real members in order', async () => {
    const { loadProfileFallback } = await import('../src/services/matchmaker-agent');
    const out = await loadProfileFallback(
      { intent_id: 'i1', requester_user_id: 'me', kind_payload: { dance: { variety: 'salsa' } }, category: 'dance.salsa' } as any,
      {} as any,
    );
    expect(out.map((p) => p.user_id)).toEqual(['real-1', 'real-2']);
    const { fetchExcludedTestServiceAccountIds } = await import('../src/lib/excluded-test-service-accounts');
    expect(fetchExcludedTestServiceAccountIds).toHaveBeenCalledWith(mockSupabase);
  });
});
