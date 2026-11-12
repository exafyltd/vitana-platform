/**
 * VTID-05576 (mt-network-r2/messaging-send-db): the chat_messages scope + send RPC + lockdown migrations' safety
 * properties, read from the files, and the pgTAP plan that proves them behaviourally.
 *
 * The behavioural twin is docs/validation/VTID-05576/pgtap/mt-network-messaging-send-db.pgtap.sql (62 cases, throwaway Postgres only:
 * `supabase test db` or the PGlite harness in docs/validation/VTID-05576/pglite-harness). This suite pins the same properties
 * from source so gateway CI checks them without a database: a bare client INSERT and a direct service-role INSERT of a
 * network row fail, the catch-all service_role_manage_chat policy stays gone, the RPCs are SECURITY DEFINER with a pinned
 * search_path, send_message_as is service_role-only, and the network branch enforces visibility, preference, block and rate limit.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(REPO, p));
const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');

const SCOPE = 'supabase/migrations/20261102050000_vtid_05576_chat_messages_scope.sql';
const RPCS = 'supabase/migrations/20261102050100_vtid_05576_send_message_rpcs.sql';
const LOCK = 'supabase/migrations/20261102050200_vtid_05576_chat_messages_lockdown.sql';
const VALIDATION = 'docs/validation/VTID-05576';
const PGTAP = `${VALIDATION}/pgtap/mt-network-messaging-send-db.pgtap.sql`;

const scope = exists(SCOPE) ? strip(read(SCOPE)) : '';
const rpcs = exists(RPCS) ? strip(read(RPCS)) : '';
const lock = exists(LOCK) ? strip(read(LOCK)) : '';
const pgtap = exists(PGTAP) ? read(PGTAP) : '';

function fnBody(src: string, name: string): string {
  const m = src.match(new RegExp(`FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  return m ? m[0] : '';
}

describe('VTID-05576 migration files', () => {
  it('exist, apply in order, and no other migration shares their version', () => {
    for (const f of [SCOPE, RPCS, LOCK]) expect(exists(f)).toBe(true);
    expect(path.basename(SCOPE) < path.basename(RPCS)).toBe(true);
    expect(path.basename(RPCS) < path.basename(LOCK)).toBe(true);
    const versions = fs
      .readdirSync(path.join(REPO, 'supabase/migrations'))
      .filter((f) => /^\d{14}_.*\.sql$/.test(f))
      .map((f) => f.slice(0, 14));
    for (const v of ['20261102050000', '20261102050100', '20261102050200']) {
      expect(versions.filter((x) => x === v)).toHaveLength(1);
    }
  });

  it('each runs in one transaction with a lock timeout', () => {
    for (const sql of [scope, rpcs, lock]) {
      expect(sql).toMatch(/^BEGIN;/m);
      expect(sql).toMatch(/^COMMIT;/m);
      expect(sql).toMatch(/SET LOCAL lock_timeout/);
      expect(sql).not.toMatch(/\bTRUNCATE\b|\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
      expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    }
  });

  it('adds no bare current_tenant_id() RLS policy', () => {
    for (const sql of [scope, rpcs, lock]) {
      expect(sql).not.toMatch(/current_tenant_id\(\)/);
    }
    // every auth.uid() in a policy is the once-per-statement (SELECT auth.uid()) form
    for (const m of lock.matchAll(/CREATE POLICY[\s\S]*?;/g)) {
      expect(m[0].replace(/\(SELECT auth\.uid\(\)\)/g, '')).not.toMatch(/auth\.uid\(\)/);
    }
  });
});

describe('VTID-05576 task 1: scope column, expand then contract', () => {
  it('adds scope text NOT NULL DEFAULT community with a CHECK (community, network) and backfills', () => {
    expect(scope).toMatch(/ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'community'/);
    expect(scope).toMatch(/CHECK \(scope IN \('community', 'network'\)\)/);
    expect(scope).toMatch(/UPDATE public\.chat_messages SET scope = 'community' WHERE scope IS NULL/);
  });
  it('drops the default only in the contract file', () => {
    expect(scope).not.toMatch(/DROP DEFAULT/);
    expect(lock).toMatch(/ALTER COLUMN scope DROP DEFAULT/);
  });
  it('a guard trigger lets only the RPCs write a non-community scope', () => {
    expect(scope).toMatch(/BEFORE INSERT OR UPDATE OF scope ON public\.chat_messages/);
    expect(scope).toMatch(/current_setting\('vitana\.chat_send_rpc', true\)/);
    expect(scope).toMatch(/ERRCODE = '42501'/);
    expect(rpcs).toMatch(/set_config\('vitana\.chat_send_rpc', 'on', true\)/);
    expect(rpcs).toMatch(/set_config\('vitana\.chat_send_rpc', '', true\)/);
  });
});

describe('VTID-05576 task 2: send_message / send_message_as', () => {
  it('all three functions are SECURITY DEFINER with a pinned search_path', () => {
    for (const n of ['chat_send_message_core', 'send_message', 'send_message_as']) {
      const body = fnBody(rpcs, n);
      expect(body).toMatch(/SECURITY DEFINER/);
      expect(body).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    }
  });
  it('send_message binds the sender to auth.uid(); send_message_as takes a trusted p_sender', () => {
    const sm = fnBody(rpcs, 'send_message');
    expect(sm).toMatch(/\(SELECT auth\.uid\(\)\)/);
    expect(sm).not.toMatch(/p_sender/);
    expect(fnBody(rpcs, 'send_message_as')).toMatch(/p_sender uuid/);
  });
  it('EXECUTE: send_message to authenticated, send_message_as to service_role only, the core to nobody', () => {
    expect(rpcs).toMatch(/GRANT EXECUTE ON FUNCTION public\.send_message\(uuid, uuid, text, text, text, jsonb, uuid\) TO authenticated;/);
    expect(rpcs).toMatch(/GRANT EXECUTE ON FUNCTION public\.send_message_as\(uuid, uuid, uuid, text, text, text, jsonb, uuid\) TO service_role;/);
    expect(rpcs).toMatch(/REVOKE ALL ON FUNCTION public\.send_message_as\([^)]*\) FROM PUBLIC, anon, authenticated;/);
    expect(rpcs).toMatch(/REVOKE ALL ON FUNCTION public\.chat_send_message_core\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(rpcs).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.chat_send_message_core/);
  });
  it('the community branch needs a shared non-platform tenant and derives tenant_id from it', () => {
    const core = fnBody(rpcs, 'chat_send_message_core');
    expect(core).toMatch(/JOIN public\.user_tenants b ON b\.tenant_id = a\.tenant_id/);
    expect(core).toMatch(/t\.is_platform/);
    expect(core).toMatch(/no_shared_tenant/);
  });
  it('the network branch checks visibility, preference, connection, block, rate limit and rule-45 accounts', () => {
    const core = fnBody(rpcs, 'chat_send_message_core');
    expect(core).toMatch(/network_visible/);
    expect(core).toMatch(/v_pref = 'nobody'/);
    expect(core).toMatch(/v_pref = 'connections' AND NOT EXISTS/);
    expect(core).toMatch(/c\.status = 'accepted'/);
    expect(core).toMatch(/user_blocklist/);
    expect(core).toMatch(/>= 20/);
    expect(core).toMatch(/ERRCODE = '54000'/);
    for (const t of ['service_bot_accounts', 'notification_test_actors', 'platform_only_accounts']) expect(core).toContain(t);
  });
  it('a network group send is refused until the groups lane', () => {
    expect(fnBody(rpcs, 'chat_send_message_core')).toMatch(/network_group_not_supported/);
  });
});

describe('VTID-05576 task 3: client-write lockdown', () => {
  it('asserts the catch-all policy stays gone and does not recreate it', () => {
    expect(lock).toMatch(/DROP POLICY IF EXISTS service_role_manage_chat ON public\.chat_messages/);
    expect(lock).not.toMatch(/CREATE POLICY service_role_manage_chat/);
    expect(lock).toMatch(/RAISE EXCEPTION 'VTID-05576: chat_messages still has an allow-all/);
    expect(read('supabase/migrations/20260608120000_phase_a_security_hotfix.sql')).toMatch(/DROP POLICY IF EXISTS "service_role_manage_chat"\s+ON public\.chat_messages/);
  });
  it('replaces the client policies with narrow SELECT and read-marker UPDATE policies and drops both INSERT policies', () => {
    expect(lock).toMatch(/CREATE POLICY chat_messages_participant_read ON public\.chat_messages FOR SELECT/);
    expect(lock).toMatch(/CREATE POLICY chat_messages_recipient_mark_read ON public\.chat_messages FOR UPDATE/);
    expect(lock).toMatch(/DROP POLICY IF EXISTS users_send_messages ON public\.chat_messages/);
    expect(lock).toMatch(/DROP POLICY IF EXISTS users_send_group_messages ON public\.chat_messages/);
    expect(lock).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|ALL)/);
  });
  it('revokes INSERT and UPDATE from the client roles and grants only read_at / delivered_at back', () => {
    expect(lock).toMatch(/REVOKE INSERT, UPDATE ON TABLE public\.chat_messages FROM PUBLIC, anon, authenticated;/);
    expect(lock).toMatch(/GRANT UPDATE \(read_at, delivered_at\) ON TABLE public\.chat_messages TO authenticated;/);
  });
});

describe('VTID-05576 tasks 4-5: rollback, read-only checks, pgTAP, queue', () => {
  it('has the three rollbacks and the three read-only check files', () => {
    for (const f of ['rollback-050000-chat-messages-scope.sql', 'rollback-050100-send-message-rpcs.sql', 'rollback-050200-chat-messages-lockdown.sql',
      'live-before.sql', 'post-apply-checks.sql', 'rollback-check.sql']) expect(exists(`${VALIDATION}/${f}`)).toBe(true);
    expect(read(`${VALIDATION}/rollback-050000-chat-messages-scope.sql`)).toMatch(/rollback refused/);
    expect(read(`${VALIDATION}/rollback-050200-chat-messages-lockdown.sql`)).not.toMatch(/CREATE POLICY service_role_manage_chat/);
    for (const f of ['live-before.sql', 'post-apply-checks.sql', 'rollback-check.sql']) {
      expect(strip(read(`${VALIDATION}/${f}`))).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/im);
    }
  });
  it('the pgTAP plan covers the four lane cases and its plan count matches its assertions', () => {
    expect(pgtap).toMatch(/a bare authenticated client INSERT fails/);
    expect(pgtap).toMatch(/a direct service-role INSERT of scope = network fails/);
    expect(pgtap).toMatch(/to a recipient who is not network_visible fails/);
    expect(pgtap).toMatch(/to a "nobody" recipient fails/);
    expect(pgtap).toMatch(/a community send with no shared tenant fails/);
    expect(pgtap).toMatch(/the catch-all service_role_manage_chat policy is gone/);
    const planned = Number((pgtap.match(/SELECT plan\((\d+)\);/) || [])[1]);
    const asserted = (pgtap.match(/^SELECT (ok|is|isnt)\(/gm) || []).length;
    expect(planned).toBeGreaterThan(0);
    expect(asserted).toBe(planned);
    expect(pgtap).toMatch(/^ROLLBACK;/m);
  });
  it('is queued in MIGRATION-QUEUE.md in file order', () => {
    const q = read('docs/multitenancy/MIGRATION-QUEUE.md');
    const a = q.indexOf('20261102050000_vtid_05576_chat_messages_scope.sql');
    const b = q.indexOf('20261102050100_vtid_05576_send_message_rpcs.sql');
    const c = q.indexOf('20261102050200_vtid_05576_chat_messages_lockdown.sql');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
  it('keeps the drift baseline count equal to its list', () => {
    const d = JSON.parse(read('scripts/ci/migration-drift-baseline.json'));
    expect(d.count).toBe(d.known_missing_tables.length);
  });
});
