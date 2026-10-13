/**
 * VTID-05052 — ci_welcome_greeting_health() must not count registered
 * test/service accounts as signups. The welcome trigger never greets them,
 * so counting them made ALERT-WELCOME-GREETING-HEALTH.yml report a false
 * outage on 2026-10-08 (2 test-account signups, 0 greetings).
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const MIGRATION = fs.readFileSync(
  path.join(REPO, 'supabase/migrations/20261010170000_vtid_05052_ci_welcome_greeting_health_exclude_test_accounts.sql'),
  'utf8',
);
const V2 = fs.readFileSync(path.join(REPO, 'supabase/migrations/20260804100000_vtid_03492_ci_health_rpcs_v2.sql'), 'utf8');

/** Body of one json_build_object key: from `'key', (` up to the next key or the end. */
function field(sql: string, key: string): string {
  const start = sql.indexOf(`'${key}', (`);
  expect(start).toBeGreaterThan(-1);
  const rest = sql.slice(start + key.length + 4);
  const next = rest.search(/\n\s*'[a-z_0-9]+', /);
  return next === -1 ? rest : rest.slice(0, next);
}

function keys(sql: string): string[] {
  const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.ci_welcome_greeting_health()'));
  const body = fn.slice(0, fn.indexOf('$$;'));
  return [...body.matchAll(/^\s*'([a-z_0-9]+)', /gm)].map((m) => m[1]);
}

describe('VTID-05052 ci_welcome_greeting_health migration', () => {
  it.each(['signups_24h', 'unflagged_24h'])('%s excludes both test/service allowlists and the welcome bot', (key) => {
    const body = field(MIGRATION, key);
    expect(body).toContain('NOT IN (SELECT s.user_id FROM public.service_bot_accounts s)');
    expect(body).toContain('NOT IN (SELECT n.user_id FROM public.notification_test_actors n)');
    expect(body).toContain("user_id <> '00000000-0000-0000-0000-000000000001'::uuid");
  });

  it('leaves greeted_senders_24h exactly as in v2', () => {
    expect(field(MIGRATION, 'greeted_senders_24h').trim()).toBe(field(V2, 'greeted_senders_24h').trim());
  });

  it('keeps the return keys the workflows parse', () => {
    expect(keys(MIGRATION)).toEqual(keys(V2));
    expect(keys(MIGRATION)).toEqual([
      'trigger_present', 'trigger_enabled', 'function_present', 'function_secdef',
      'trigger_table', 'signups_24h', 'greeted_senders_24h', 'unflagged_24h',
    ]);
  });

  it('stays SECURITY DEFINER, pinned search_path, service_role only', () => {
    expect(MIGRATION).toContain('SECURITY DEFINER');
    expect(MIGRATION).toContain('SET search_path = public, pg_catalog');
    expect(MIGRATION).toContain(
      'REVOKE ALL ON FUNCTION public.ci_welcome_greeting_health() FROM PUBLIC, anon, authenticated;',
    );
    expect(MIGRATION).toContain('GRANT EXECUTE ON FUNCTION public.ci_welcome_greeting_health() TO service_role;');
    expect(MIGRATION).not.toMatch(/GRANT[^;]*TO\s+(anon|authenticated|PUBLIC)/i);
  });

  it('only redefines this one function', () => {
    expect(MIGRATION.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(MIGRATION).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER TABLE)\b/);
  });
});
