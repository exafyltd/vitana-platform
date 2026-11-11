/**
 * VTID-05579 (mt-network-r2/network-groups-db): the chat_groups scope migration, the network-group RPCs and the participant-only
 * RLS migration, read from the files, and the pgTAP plan that proves them behaviourally.
 *
 * The behavioural twin is docs/validation/VTID-05579/pgtap/mt-network-groups-db.pgtap.sql (throwaway Postgres only:
 * `supabase test db` or the PGlite harness in docs/validation/VTID-05579/pglite-harness). This suite pins the same properties
 * from source so gateway CI checks them without a database: scope is written only by the RPCs (D27), the 20 member cap and the
 * connection rule live in the DEFINER function and the table guard, rule 43-45 accounts are never members, a network group is never
 * a system group (no fan-out target), the policies are participant-only and none is an allow-all, and the queue rows exist.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(REPO, p));
const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');

const SCOPE = 'supabase/migrations/20261102054000_vtid_05579_chat_groups_scope.sql';
const RPCS = 'supabase/migrations/20261102054100_vtid_05579_network_group_rpcs.sql';
const RLS = 'supabase/migrations/20261102054200_vtid_05579_chat_groups_rls.sql';
const VALIDATION = 'docs/validation/VTID-05579';
const PGTAP = `${VALIDATION}/pgtap/mt-network-groups-db.pgtap.sql`;

const scope = exists(SCOPE) ? strip(read(SCOPE)) : '';
const rpcs = exists(RPCS) ? strip(read(RPCS)) : '';
const rls = exists(RLS) ? strip(read(RLS)) : '';
const pgtap = exists(PGTAP) ? read(PGTAP) : '';

function fnBody(src: string, name: string): string {
  const m = src.match(new RegExp(`FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  return m ? m[0] : '';
}

describe('VTID-05579 migration files', () => {
  it('exist, apply in order, and no other migration shares their version', () => {
    for (const f of [SCOPE, RPCS, RLS]) expect(exists(f)).toBe(true);
    expect(path.basename(SCOPE) < path.basename(RPCS)).toBe(true);
    expect(path.basename(RPCS) < path.basename(RLS)).toBe(true);
    const versions = fs
      .readdirSync(path.join(REPO, 'supabase/migrations'))
      .filter((f) => /^\d{14}_.*\.sql$/.test(f))
      .map((f) => f.slice(0, 14));
    for (const v of ['20261102054000', '20261102054100', '20261102054200']) {
      expect(versions.filter((x) => x === v)).toHaveLength(1);
    }
  });

  it('each runs in one transaction with a lock timeout and drops no table or column', () => {
    for (const sql of [scope, rpcs, rls]) {
      expect(sql).toMatch(/^BEGIN;/m);
      expect(sql).toMatch(/^COMMIT;/m);
      expect(sql).toMatch(/SET LOCAL lock_timeout/);
      expect(sql).not.toMatch(/\bTRUNCATE\b|\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
      expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    }
  });

  it('adds no bare current_tenant_id() RLS policy and evaluates auth.uid() once per statement', () => {
    for (const sql of [scope, rpcs, rls]) expect(sql).not.toMatch(/current_tenant_id\(\)/);
    for (const m of rls.matchAll(/CREATE POLICY[\s\S]*?;/g)) {
      expect(m[0].replace(/\(SELECT auth\.uid\(\)\)/g, '')).not.toMatch(/auth\.uid\(\)/);
    }
  });
});

describe('VTID-05579 task 1: scope columns, backfill, guards', () => {
  it('adds scope text NOT NULL DEFAULT community with a CHECK (community, network) to both tables', () => {
    expect(scope).toMatch(/ALTER TABLE public\.chat_groups ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'community'/);
    expect(scope).toMatch(/ALTER TABLE public\.chat_group_members ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'community'/);
    expect(scope).toMatch(/chat_groups_scope_check/);
    expect(scope).toMatch(/chat_group_members_scope_check/);
    expect(scope.match(/CHECK \(scope IN \('community', 'network'\)\)/g)).toHaveLength(2);
  });
  it('backfills chat_groups.scope from the VTID-05573 flag metadata.legacy_scope = network, and the members from their group', () => {
    expect(scope).toMatch(/metadata ->> 'legacy_scope' = 'network'/);
    expect(scope).toMatch(/UPDATE public\.chat_groups[\s\S]*?SET scope = 'network'/);
    expect(scope).toMatch(/UPDATE public\.chat_group_members m[\s\S]*?SET scope = g\.scope/);
  });
  it('a network group is never a system group and never has a bot member (no system fan-out target)', () => {
    expect(scope).toMatch(/CHECK \(scope = 'community' OR is_system = false\)/);
    expect(scope).toMatch(/CHECK \(scope = 'community' OR role <> 'bot'\)/);
  });
  it('only the RPCs write a non-community group scope or add a network member (transaction-local flag)', () => {
    expect(scope).toMatch(/BEFORE INSERT OR UPDATE OF scope ON public\.chat_groups/);
    expect(scope).toMatch(/BEFORE INSERT OR UPDATE ON public\.chat_group_members/);
    expect(scope).toMatch(/current_setting\('vitana\.chat_group_rpc', true\)/);
    expect(scope).toMatch(/ERRCODE = '42501'/);
    expect(rpcs).toMatch(/set_config\('vitana\.chat_group_rpc', 'on', true\)/);
    expect(rpcs).toMatch(/set_config\('vitana\.chat_group_rpc', '', true\)/);
  });
  it('the member guard re-checks rule 43-45 and the 20 cap, and forces the group scope', () => {
    const g = fnBody(scope, 'chat_group_members_scope_guard');
    expect(g).toMatch(/SECURITY DEFINER/);
    expect(g).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    expect(g).toMatch(/is_network_excluded_account\(NEW\.user_id\)/);
    expect(g).toMatch(/>= 20/);
    expect(g).toMatch(/ERRCODE = '54000'/);
    expect(g).toMatch(/NEW\.scope := /);
  });
  it('is expand only: the default stays so today\'s community writers keep working', () => {
    expect(scope).not.toMatch(/DROP DEFAULT/);
  });
});

describe('VTID-05579 task 2: create_network_group / add_group_member', () => {
  const fns = ['chat_group_create_core', 'chat_group_add_member_core', 'create_network_group', 'create_network_group_as', 'add_group_member', 'add_group_member_as'];
  it('all six functions are SECURITY DEFINER with a pinned search_path', () => {
    for (const n of fns) {
      const body = fnBody(rpcs, n);
      expect(body).not.toBe('');
      expect(body).toMatch(/SECURITY DEFINER/);
      expect(body).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    }
  });
  it('the caller-bound functions use auth.uid(); the _as pair takes a trusted p_actor', () => {
    expect(fnBody(rpcs, 'create_network_group')).toMatch(/\(SELECT auth\.uid\(\)\)/);
    expect(fnBody(rpcs, 'add_group_member')).toMatch(/\(SELECT auth\.uid\(\)\)/);
    expect(fnBody(rpcs, 'add_group_member')).not.toMatch(/p_actor/);
    expect(fnBody(rpcs, 'add_group_member_as')).toMatch(/p_actor uuid/);
    expect(fnBody(rpcs, 'create_network_group_as')).toMatch(/p_actor uuid/);
  });
  it('EXECUTE: callers to authenticated, the _as pair to service_role only, the cores to nobody', () => {
    expect(rpcs).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_network_group\(text, text\) TO authenticated;/);
    expect(rpcs).toMatch(/GRANT EXECUTE ON FUNCTION public\.add_group_member\(uuid, uuid\) TO authenticated;/);
    expect(rpcs).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_network_group_as\(uuid, text, text\) TO service_role;/);
    expect(rpcs).toMatch(/GRANT EXECUTE ON FUNCTION public\.add_group_member_as\(uuid, uuid, uuid\) TO service_role;/);
    expect(rpcs).toMatch(/REVOKE ALL ON FUNCTION public\.add_group_member_as\([^)]*\) FROM PUBLIC, anon, authenticated;/);
    expect(rpcs).toMatch(/REVOKE ALL ON FUNCTION public\.chat_group_add_member_core\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(rpcs).toMatch(/REVOKE ALL ON FUNCTION public\.chat_group_create_core\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(rpcs).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.chat_group_(add_member|create)_core/);
  });
  it('the network branch is admin-only, invite-only between accepted connections, bounded at 20, and refuses rule 43-45 accounts', () => {
    const core = fnBody(rpcs, 'chat_group_add_member_core');
    expect(core).toMatch(/FOR UPDATE/);
    expect(core).toMatch(/not_a_member/);
    expect(core).toMatch(/not_group_admin/);
    expect(core).toMatch(/is_network_excluded_account\(p_user\)/);
    expect(core).toMatch(/network_visible/);
    expect(core).toMatch(/user_blocklist/);
    expect(core).toMatch(/c\.status = 'accepted'/);
    expect(core).toMatch(/not_connected/);
    expect(core).toMatch(/>= 20/);
    expect(core).toMatch(/ERRCODE = '54000'/);
    expect(core).toMatch(/invalid_member/);
  });
  it('the creator\'s tenant is the context: members carry the group tenant, the platform tenant never counts', () => {
    const core = fnBody(rpcs, 'chat_group_add_member_core');
    expect(core).toMatch(/v_g\.tenant_id/);
    const create = fnBody(rpcs, 'chat_group_create_core');
    expect(create).toMatch(/is_platform/);
    expect(create).toMatch(/no_context_tenant/);
    expect(create).toMatch(/is_primary DESC/);
  });
  it('add refuses every non-network group before any membership check, and has no community insert (review fix)', () => {
    const core = fnBody(rpcs, 'chat_group_add_member_core');
    expect(core).toMatch(/v_g\.scope IS DISTINCT FROM 'network'[\s\S]*?not_network_group/);
    expect(core.indexOf('not_network_group')).toBeLessThan(core.indexOf('not_a_member'));
    expect(core).not.toMatch(/not_in_group_tenant/);
    expect(core).not.toMatch(/'community'\)/);
    expect(core.match(/INSERT INTO public\.chat_group_members/g)).toHaveLength(1);
    expect(core.match(/>= 20/g)).toHaveLength(1);
  });
  it('writes no message, notification or system row (no system fan-out)', () => {
    expect(rpcs).not.toMatch(/INSERT INTO public\.(chat_messages|user_notifications|notifications)/);
    expect(rpcs).not.toMatch(/is_system\s*(=|,)\s*true/);
  });
});

describe('VTID-05579 task 1: participant-only RLS', () => {
  it('rewrites the two read policies to participant-only with the once-per-statement form', () => {
    expect(rls).toMatch(/CREATE POLICY chat_groups_member_read ON public\.chat_groups FOR SELECT/);
    expect(rls).toMatch(/CREATE POLICY chat_group_members_read ON public\.chat_group_members FOR SELECT/);
    expect(rls.match(/is_chat_group_member\([^)]*\(SELECT auth\.uid\(\)\)\)/g)).toHaveLength(2);
  });
  it('creates no INSERT / UPDATE / DELETE / ALL policy and asserts no allow-all policy remains', () => {
    expect(rls).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(rls).toMatch(/DROP POLICY IF EXISTS chat_groups_service_role ON public\.chat_groups/);
    expect(rls).toMatch(/DROP POLICY IF EXISTS chat_group_members_service_role ON public\.chat_group_members/);
    expect(rls).toMatch(/RAISE EXCEPTION 'VTID-05579: chat_groups or chat_group_members still has/);
    expect(rls).not.toMatch(/USING \(true\)/);
  });
});

describe('VTID-05579 tasks 3-4: rollback, read-only checks, pgTAP, queue', () => {
  it('has the three rollbacks and the three read-only check files', () => {
    for (const f of ['rollback-054000-chat-groups-scope.sql', 'rollback-054100-network-group-rpcs.sql', 'rollback-054200-chat-groups-rls.sql',
      'live-before.sql', 'post-apply-checks.sql', 'rollback-check.sql']) expect(exists(`${VALIDATION}/${f}`)).toBe(true);
    expect(read(`${VALIDATION}/rollback-054000-chat-groups-scope.sql`)).toMatch(/rollback refused/);
    expect(strip(read(`${VALIDATION}/rollback-054200-chat-groups-rls.sql`))).not.toMatch(/FOR ALL|USING \(true\)/);
    for (const f of ['live-before.sql', 'post-apply-checks.sql', 'rollback-check.sql']) {
      expect(strip(read(`${VALIDATION}/${f}`))).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/im);
    }
  });
  it('the pgTAP plan covers the D27 limits and its plan count matches its assertions', () => {
    expect(pgtap).toMatch(/the 21st member is refused/);
    expect(pgtap).toMatch(/a pending request is not a connection/);
    expect(pgtap).toMatch(/a service bot is never a member/);
    expect(pgtap).toMatch(/a caller who is not a member of the group is refused/);
    expect(pgtap).toMatch(/no permissive FOR ALL USING \(true\) policy for PUBLIC\/authenticated/);
    expect(pgtap).toMatch(/the legacy cross-tenant group \(metadata\.legacy_scope = network\) is backfilled to network/);
    const planned = Number((pgtap.match(/SELECT plan\((\d+)\);/) || [])[1]);
    const asserted = (pgtap.match(/^SELECT (ok|is|isnt)\(/gm) || []).length;
    expect(planned).toBeGreaterThan(0);
    expect(asserted).toBe(planned);
    expect(pgtap).toMatch(/^ROLLBACK;/m);
  });
  it('is queued in MIGRATION-QUEUE.md as rows 63-65 in file order, after the last existing row', () => {
    const q = read('docs/multitenancy/MIGRATION-QUEUE.md');
    const a = q.indexOf('20261102054000_vtid_05579_chat_groups_scope.sql');
    const b = q.indexOf('20261102054100_vtid_05579_network_group_rpcs.sql');
    const c = q.indexOf('20261102054200_vtid_05579_chat_groups_rls.sql');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(a).toBeGreaterThan(q.indexOf('20261102141100_vtid_05506_mt_isolation_health_by_tenant.sql'));
    expect(q).toMatch(/^\| 63 \| `20261102054000_vtid_05579_chat_groups_scope\.sql`/m);
    expect(q).toMatch(/^\| 64 \| `20261102054100_vtid_05579_network_group_rpcs\.sql`/m);
    expect(q).toMatch(/^\| 65 \| `20261102054200_vtid_05579_chat_groups_rls\.sql`/m);
  });
  it('keeps the drift baseline count equal to its list', () => {
    const d = JSON.parse(read('scripts/ci/migration-drift-baseline.json'));
    expect(d.count).toBe(d.known_missing_tables.length);
  });
});
