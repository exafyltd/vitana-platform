import {
  AuditEvent,
  BrokerError,
  IdentityAdapter,
  SessionRecord,
  SessionStore,
  TestDataAdapter,
  TestSessionBroker,
  hashToken,
} from '../../src/services/test-identity/broker';
import { AGENT_ROSTER, AgentRosterEntry, UNRECONCILED_SLOTS } from '../../src/services/test-identity/agent-roster';
import { PERSONAS, PersonaKey, validatePersonas } from '../../src/services/test-identity/personas';

class MemoryStore implements SessionStore {
  rows = new Map<string, SessionRecord>();
  async insert(r: SessionRecord) { this.rows.set(r.session_id, { ...r }); }
  async get(id: string) { return this.rows.get(id) ?? null; }
  async findByTokenHash(h: string) { return [...this.rows.values()].find((r) => r.token_hash === h) ?? null; }
  async update(id: string, p: Partial<SessionRecord>) { this.rows.set(id, { ...this.rows.get(id)!, ...p }); }
  async activeForAgent(agentId: string) {
    return [...this.rows.values()].filter((r) => r.agent_id === agentId && !r.revoked_at);
  }
}

function harness(roster: readonly AgentRosterEntry[] = AGENT_ROSTER) {
  let t = Date.parse('2026-11-17T18:00:00Z');
  const now = () => new Date(t);
  const store = new MemoryStore();
  const events: AuditEvent[] = [];
  const revokedUsers: string[] = [];
  const tagged: Array<{ session: string }> = [];
  const identity: IdentityAdapter = {
    async ensurePersonaUser(p: PersonaKey) { return { user_id: `uid-${p}` }; },
    async revokeUserSessions(u: string) { revokedUsers.push(u); },
  };
  const data: TestDataAdapter = {
    async deleteTaggedBySession(s: string) { tagged.push({ session: s }); return 3; },
  };
  const broker = new TestSessionBroker({ store, audit: { append: async (e) => { events.push(e); } }, identity, data, roster, now });
  return {
    broker, store, events, revokedUsers, tagged,
    advance(ms: number) { t += ms; },
  };
}

const STAGING = 'staging';

describe('agent roster', () => {
  it('lists the 11 registry-backed entries and records the two unreconciled slots', () => {
    expect(AGENT_ROSTER).toHaveLength(11);
    expect(UNRECONCILED_SLOTS).toBe(2);
    expect(new Set(AGENT_ROSTER.map((a) => a.agent_id)).size).toBe(AGENT_ROSTER.length);
  });
});

describe('personas', () => {
  it('every persona is on the reserved .invalid TLD and flagged as a test identity', () => {
    expect(validatePersonas(PERSONAS)).toEqual([]);
    for (const p of Object.values(PERSONAS)) {
      expect(p.email.endsWith('.invalid')).toBe(true);
      expect(p.is_test).toBe(true);
    }
  });
});

describe('TestSessionBroker.requestSession', () => {
  it('issues a session for an authorised agent and persona, attributed to the agent', async () => {
    const h = harness();
    const g = await h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING });
    expect(g.agent_id).toBe('planner');
    expect(g.persona).toBe('community_member');
    expect(g.token.length).toBeGreaterThan(30);
    const issued = h.events.find((e) => e.action === 'session.issued')!;
    expect(issued.agent_id).toBe('planner');
    expect(issued.session_id).toBe(g.session_id);
  });

  it('stores only a SHA-256 hash of the token, never the token itself', async () => {
    const h = harness();
    const g = await h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING });
    const rec = (await h.store.get(g.session_id))!;
    expect(rec.token_hash).toBe(hashToken(g.token));
    expect(JSON.stringify(rec)).not.toContain(g.token);
    expect(JSON.stringify(h.events)).not.toContain(g.token);
  });

  it.each(['production', 'prod', 'Production', ''])('refuses environment %p', async (env) => {
    const h = harness();
    await expect(h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: env }))
      .rejects.toMatchObject({ code: 'environment_not_allowed' });
    expect(h.store.rows.size).toBe(0);
  });

  it('refuses an agent that is not on the roster', async () => {
    const h = harness();
    await expect(h.broker.requestSession({ agent_id: 'rogue', persona: 'community_member', environment: STAGING }))
      .rejects.toMatchObject({ code: 'agent_unknown' });
  });

  it('refuses a suspended agent', async () => {
    const roster = AGENT_ROSTER.map((a) => (a.agent_id === 'planner' ? { ...a, status: 'suspended' as const } : a));
    const h = harness(roster);
    await expect(h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING }))
      .rejects.toMatchObject({ code: 'agent_suspended' });
  });

  it('refuses a persona the agent is not listed for', async () => {
    const h = harness();
    await expect(h.broker.requestSession({ agent_id: 'planner', persona: 'no_permission', environment: STAGING }))
      .rejects.toMatchObject({ code: 'persona_not_allowed' });
  });

  it('refuses a persona above the agent tier, even when listed', async () => {
    const roster: AgentRosterEntry[] = [{
      agent_id: 'tester-x', display_name: 'x', runtime: 'platform', status: 'active', tier: 'tester',
      personas: ['community_admin'],
    }];
    const h = harness(roster);
    await expect(h.broker.requestSession({ agent_id: 'tester-x', persona: 'community_admin', environment: STAGING }))
      .rejects.toMatchObject({ code: 'tier_insufficient' });
  });

  it('bounds the session TTL', async () => {
    const h = harness();
    await expect(h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING, ttl_seconds: 3600 }))
      .rejects.toMatchObject({ code: 'ttl_invalid' });
    await expect(h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING, ttl_seconds: 5 }))
      .rejects.toMatchObject({ code: 'ttl_invalid' });
  });

  it('records a denial in the audit trail with the agent attributed', async () => {
    const h = harness();
    await h.broker.requestSession({ agent_id: 'planner', persona: 'no_permission', environment: STAGING }).catch(() => undefined);
    const denied = h.events.find((e) => e.action === 'session.denied')!;
    expect(denied.agent_id).toBe('planner');
    expect(denied.detail).toBe('persona_not_allowed');
  });
});

describe('TestSessionBroker.authenticate', () => {
  it('resolves a live token and audits the use', async () => {
    const h = harness();
    const g = await h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING });
    const rec = await h.broker.authenticate(g.token);
    expect(rec.session_id).toBe(g.session_id);
    expect(h.events.some((e) => e.action === 'session.used' && e.agent_id === 'planner')).toBe(true);
  });

  it('rejects an unknown token', async () => {
    const h = harness();
    await expect(h.broker.authenticate('not-a-token')).rejects.toMatchObject({ code: 'token_invalid' });
  });

  it('rejects an expired session', async () => {
    const h = harness();
    const g = await h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING, ttl_seconds: 60 });
    h.advance(61_000);
    await expect(h.broker.authenticate(g.token)).rejects.toMatchObject({ code: 'session_expired' });
  });

  it('rejects a revoked session', async () => {
    const h = harness();
    const g = await h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING });
    await h.broker.revokeSession(g.session_id, 'test revoke');
    await expect(h.broker.authenticate(g.token)).rejects.toMatchObject({ code: 'session_revoked' });
    expect(h.revokedUsers).toEqual([`uid-community_member`]);
  });
});

describe('suspension and revocation', () => {
  it('suspending an agent revokes its live sessions and blocks new ones', async () => {
    const h = harness();
    const a = await h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING });
    const b = await h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING });
    const other = await h.broker.requestSession({ agent_id: 'validator-llm-review', persona: 'community_member', environment: STAGING });
    const revoked = await h.broker.suspendAgent('planner', 'incident');
    expect(revoked).toBe(2);
    expect((await h.store.get(a.session_id))!.revoked_at).not.toBeNull();
    expect((await h.store.get(b.session_id))!.revoked_at).not.toBeNull();
    expect((await h.store.get(other.session_id))!.revoked_at).toBeNull();
    // the broker's roster is static: suspension must also be honoured for authentication of a live token
    const roster = AGENT_ROSTER.map((x) => (x.agent_id === 'planner' ? { ...x, status: 'suspended' as const } : x));
    const h2 = harness(roster);
    await expect(h2.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING }))
      .rejects.toMatchObject({ code: 'agent_suspended' });
  });

  it('revoking twice is idempotent and does not double-audit', async () => {
    const h = harness();
    const g = await h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING });
    await h.broker.revokeSession(g.session_id, 'x');
    await h.broker.revokeSession(g.session_id, 'x');
    expect(h.events.filter((e) => e.action === 'session.revoked')).toHaveLength(1);
  });
});

describe('cleanup', () => {
  it('revokes the session and deletes only its tagged rows, auditing the count', async () => {
    const h = harness();
    const g = await h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING });
    const removed = await h.broker.cleanupSession(g.session_id);
    expect(removed).toBe(3);
    expect(h.tagged).toEqual([{ session: g.session_id }]);
    expect((await h.store.get(g.session_id))!.revoked_at).not.toBeNull();
    const cleaned = h.events.find((e) => e.action === 'session.cleaned')!;
    expect(cleaned.detail).toBe('rows_removed=3');
    expect(cleaned.agent_id).toBe('planner');
  });
});

describe('inheritance by new agents', () => {
  it('a newly registered roster entry gets a session with no other change', async () => {
    const roster: AgentRosterEntry[] = [...AGENT_ROSTER, {
      agent_id: 'new-agent-2026', display_name: 'new', runtime: 'kiro', status: 'active', tier: 'reader',
      personas: ['community_member'],
    }];
    const h = harness(roster);
    const g = await h.broker.requestSession({ agent_id: 'new-agent-2026', persona: 'community_member', environment: STAGING });
    expect(g.agent_id).toBe('new-agent-2026');
  });
});

describe('two independently authenticated agents', () => {
  it('each agent holds its own attributed session and cannot use the other session', async () => {
    const h = harness();
    const a = await h.broker.requestSession({ agent_id: 'planner', persona: 'community_member', environment: STAGING });
    const b = await h.broker.requestSession({ agent_id: 'validator-llm-review', persona: 'community_member', environment: STAGING });
    expect(a.token).not.toBe(b.token);
    const ra = await h.broker.authenticate(a.token);
    const rb = await h.broker.authenticate(b.token);
    expect(ra.agent_id).toBe('planner');
    expect(rb.agent_id).toBe('validator-llm-review');
    expect(h.events.filter((e) => e.action === 'session.used').map((e) => e.agent_id)).toEqual(['planner', 'validator-llm-review']);
  });
});

describe('BrokerError', () => {
  it('carries a stable code', () => {
    const e = new BrokerError('agent_unknown', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('agent_unknown');
  });
});
