/**
 * VTID-04318 — Orchestrator v2 P0 (docs/ORCHESTRATOR-REDESIGN-PLAN.md §5).
 *
 * AC-1: the ORB and the community AP executor resolve the same role for the
 *       same user (one rule, orchestrator/active-role.ts).
 * AC-2: AP targeting never returns a test/service/automation account.
 * AC-3: no runtime gateway default points at a deleted Cloud Run host.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  pickEffectiveRole,
  applyEffectiveRoles,
} from '../src/services/orchestrator/active-role';
import { fetchUsersByRole } from '../src/services/automation-executor-repository';
import {
  communityAppBaseUrl,
  oasisOperatorBaseUrl,
  gatewayBaseUrl,
} from '../src/env';

describe('pickEffectiveRole', () => {
  test('UI preference wins over the tenant active_role', () => {
    expect(pickEffectiveRole('admin', 'community')).toBe('admin');
  });
  test('falls back to user_tenants.active_role', () => {
    expect(pickEffectiveRole(null, 'patient')).toBe('patient');
    expect(pickEffectiveRole('  ', 'patient')).toBe('patient');
  });
  test('null when neither is set', () => {
    expect(pickEffectiveRole(undefined, null)).toBeNull();
  });
});

describe('applyEffectiveRoles', () => {
  test('newest preference per user wins, original role is kept', () => {
    const out = applyEffectiveRoles(
      [
        { user_id: 'u1', active_role: 'community' },
        { user_id: 'u2', active_role: 'professional' },
      ],
      [
        { user_id: 'u1', role: 'admin' }, // newest first
        { user_id: 'u1', role: 'developer' },
      ],
    );
    expect(out[0]).toMatchObject({ user_id: 'u1', active_role: 'admin', tenant_active_role: 'community' });
    expect(out[1]).toMatchObject({ user_id: 'u2', active_role: 'professional', tenant_active_role: 'professional' });
  });
});

/** Minimal chainable Supabase stub: one canned result per table. */
function stubSupabase(tables: Record<string, { data?: unknown; error?: { message: string } | null }>) {
  return {
    from(table: string) {
      const result = tables[table] ?? { data: [], error: null };
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve, reject),
      };
      return chain;
    },
  } as any;
}

describe('fetchUsersByRole (AP executor targeting)', () => {
  const members = [
    { user_id: 'switched', active_role: 'community' },
    { user_id: 'plain', active_role: 'community' },
    { user_id: 'bot', active_role: 'community' },
  ];

  test('targets on the same effective role the ORB uses', async () => {
    const sb = stubSupabase({
      user_tenants: { data: members },
      role_preferences: { data: [{ user_id: 'switched', role: 'admin' }] },
      service_bot_accounts: { data: [] },
      notification_test_actors: { data: [] },
    });
    const admins = await fetchUsersByRole(sb, 't1', 'user_id, active_role', ['admin']);
    expect(admins.data.map((r: any) => r.user_id)).toEqual(['switched']);
    const community = await fetchUsersByRole(sb, 't1', 'user_id, active_role', ['community']);
    expect(community.data.map((r: any) => r.user_id)).toEqual(['plain', 'bot']);
  });

  test('never returns a registered test/service account', async () => {
    const sb = stubSupabase({
      user_tenants: { data: members },
      role_preferences: { data: [] },
      service_bot_accounts: { data: [{ user_id: 'bot' }] },
      notification_test_actors: { data: [] },
    });
    const all = await fetchUsersByRole(sb, 't1', 'user_id, active_role', 'all');
    expect(all.data.map((r: any) => r.user_id)).toEqual(['switched', 'plain']);
  });

  test('a failed preference read degrades to user_tenants.active_role', async () => {
    const sb = stubSupabase({
      user_tenants: { data: members },
      role_preferences: { error: { message: 'boom' } },
    });
    const community = await fetchUsersByRole(sb, 't1', 'user_id, active_role', ['community']);
    expect(community.data).toHaveLength(3);
  });

  test('a failed membership read is returned as an error, not an empty audience', async () => {
    const sb = stubSupabase({ user_tenants: { error: { message: 'down' } } });
    const res = await fetchUsersByRole(sb, 't1', 'user_id, active_role', 'all');
    expect(res.error).toEqual({ message: 'down' });
    expect(res.data).toBeNull();
  });
});

describe('environment base URLs', () => {
  test('community app follows VITANA_ENV, override wins', () => {
    expect(communityAppBaseUrl({ VITANA_ENV: 'staging' } as any)).toBe('https://preview-aws.vitanaland.com');
    expect(communityAppBaseUrl({} as any)).toBe('https://vitanaland.com');
    expect(communityAppBaseUrl({ COMMUNITY_APP_URL: 'https://x.test/' } as any)).toBe('https://x.test');
  });
  test('oasis operator defaults to the AWS service', () => {
    expect(oasisOperatorBaseUrl({} as any)).toBe('https://dr-oasis-operator.vitanaland.com');
  });
  test('gateway default is never a Cloud Run host', () => {
    expect(gatewayBaseUrl({} as any)).not.toMatch(/run\.app/);
  });
});

describe('no runtime default points at a deleted Cloud Run host', () => {
  const SRC = path.join(__dirname, '..', 'src');
  // Origin allowlists (CORS / ORB) only accept requests and never call out;
  // index.ts's redirector branch runs only under Cloud Run's K_SERVICE.
  // env.ts mentions the host in a comment.
  const ALLOWED = new Set(['middleware/cors.ts', 'routes/orb-live.ts', 'index.ts', 'env.ts']);

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'frontend' || e.name === 'node_modules') continue;
        walk(p, out);
      } else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  test('only allowlisted files mention *.run.app', () => {
    const offenders = walk(SRC)
      .filter((f) => /\.run\.app/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel));
    expect(offenders).toEqual([]);
  });

  test('orb-live mentions run.app only inside the origin allowlist', () => {
    const lines = fs.readFileSync(path.join(SRC, 'routes/orb-live.ts'), 'utf8').split('\n');
    const hits = lines.filter((l) => /\.run\.app/.test(l));
    for (const l of hits) expect(l.trim()).toMatch(/^'https:\/\/[a-z0-9.-]+\.run\.app',$/);
  });
});
