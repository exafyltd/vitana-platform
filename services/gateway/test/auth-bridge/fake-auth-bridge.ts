/**
 * VTID-05023 part 4 test double: an in-memory Aurora (app_users / profiles /
 * processed deletions) and GoTrue (paged users, app_metadata) with the same
 * idempotent semantics as the SQL functions in
 * scripts/aws/aurora-cutover-auth-bridge.sql (those are proven on a real
 * Postgres by scripts/aws/test/auth-bridge.sh).
 */

import type {
  AuthBridgeDeps,
  BridgeAuthUser,
  EnsureProvisionedResult,
} from '../../src/services/auth-bridge/auth-bridge';

export const TENANT = '00000000-0000-0000-0000-0000000000a1';

export function authUser(n: number, extra: Partial<BridgeAuthUser> = {}): BridgeAuthUser {
  return {
    id: `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    email: `user${n}@example.com`,
    user_metadata: {},
    app_metadata: {},
    created_at: '2026-10-20T10:00:00.000Z',
    email_confirmed_at: null,
    ...extra,
  };
}

export class FakeAuthBridge {
  appUsers = new Set<string>();
  profiles = new Set<string>();
  deleted = new Map<string, string>();
  authUsers: BridgeAuthUser[] = [];
  appMetadataWrites: Array<{ id: string; tenant: string }> = [];
  ensureCalls: BridgeAuthUser[] = [];
  listCalls: Array<{ page: number; perPage: number }> = [];
  failListOnPage: number | null = null;
  failEnsureFor = new Set<string>();

  /** Provisioned as if the Supabase triggers had run (pre-cutover member). */
  seedProvisioned(id: string): void {
    this.appUsers.add(id);
    this.profiles.add(id);
  }

  deps(): AuthBridgeDeps {
    return {
      store: {
        ensureProvisioned: async (user): Promise<EnsureProvisionedResult> => {
          this.ensureCalls.push(user);
          if (this.failEnsureFor.has(user.id)) throw new Error('ensure_provisioned failed: duplicate key value');
          const created: string[] = [];
          if (!this.profiles.has(user.id)) { this.profiles.add(user.id); created.push('profiles'); }
          if (!this.appUsers.has(user.id)) { this.appUsers.add(user.id); created.push('app_users'); }
          return { user_id: user.id, created, provisioned: created.length > 0, active_tenant_id: TENANT };
        },
        handleDeletedUser: async (userId, source) => {
          this.profiles.delete(userId);
          this.deleted.set(userId, source);
          return { user_id: userId, affected: {}, passes: 1 };
        },
        unprovisioned: async (ids) => ids.filter((id) => !this.appUsers.has(id)),
        appUserExists: async (id) => this.appUsers.has(id),
        listProfileUserIds: async (offset, limit) => [...this.profiles].sort().slice(offset, offset + limit),
        processedDeletions: async (ids) => new Set(ids.filter((id) => this.deleted.has(id))),
      },
      gotrue: {
        listUsers: async (page, perPage) => {
          this.listCalls.push({ page, perPage });
          if (this.failListOnPage === page) throw new Error('GoTrue list users failed: HTTP 502');
          return this.authUsers.slice((page - 1) * perPage, page * perPage);
        },
        getUser: async (id) => this.authUsers.find((u) => u.id === id) ?? null,
        setActiveTenant: async (id, tenant) => {
          this.appMetadataWrites.push({ id, tenant });
          const u = this.authUsers.find((x) => x.id === id);
          if (u) u.app_metadata = { ...u.app_metadata, active_tenant_id: tenant };
        },
      },
    };
  }
}
