/**
 * Test-session broker — universal agent testing capability.
 *
 * An authorised agent asks for a test session as a named persona. The broker:
 *   1. refuses anything but the staging environment;
 *   2. checks the agent is on the roster, active, and allowed that persona at its tier;
 *   3. asks an identity adapter for a session as that persona (the adapter, not the agent, holds
 *      any privileged key — agents never see a service role or a gateway token);
 *   4. stores only a SHA-256 hash of the bearer token, with an expiry and a revocation flag;
 *   5. writes an audit event for every issue, use-denial, revoke and cleanup, attributed to the agent.
 *
 * Storage, identity and data cleanup are injected, so the rules are tested offline (see
 * test/test-identity/broker.test.ts) and bound to the real stores in a separate adapter module.
 */

import { createHash, randomBytes, randomUUID } from 'crypto';
import { AGENT_ROSTER, AgentRosterEntry, findAgent, tierAllows } from './agent-roster';
import { PERSONAS, PersonaKey } from './personas';

export const SESSION_TTL_MIN_S = 60;
export const SESSION_TTL_MAX_S = 900; // 15 min: short-lived by design
export const SESSION_TTL_DEFAULT_S = 900;
export const ALLOWED_ENVIRONMENTS = ['staging'] as const;

export type BrokerErrorCode =
  | 'environment_not_allowed'
  | 'agent_unknown'
  | 'agent_suspended'
  | 'persona_not_allowed'
  | 'tier_insufficient'
  | 'ttl_invalid'
  | 'token_invalid'
  | 'session_revoked'
  | 'session_expired';

export class BrokerError extends Error {
  constructor(public readonly code: BrokerErrorCode, message: string) {
    super(message);
    this.name = 'BrokerError';
  }
}

export interface SessionRecord {
  session_id: string;
  agent_id: string;
  persona: PersonaKey;
  environment: string;
  user_id: string;
  token_hash: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface AuditEvent {
  at: string;
  action: 'session.issued' | 'session.denied' | 'session.used' | 'session.revoked' | 'session.cleaned' | 'agent.suspended';
  agent_id: string;
  session_id: string | null;
  persona: PersonaKey | null;
  detail: string;
}

/** Storage for session records. Never holds a raw token. */
export interface SessionStore {
  insert(record: SessionRecord): Promise<void>;
  get(sessionId: string): Promise<SessionRecord | null>;
  findByTokenHash(hash: string): Promise<SessionRecord | null>;
  update(sessionId: string, patch: Partial<SessionRecord>): Promise<void>;
  activeForAgent(agentId: string): Promise<SessionRecord[]>;
}

/** Append-only audit trail. */
export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}

/**
 * Mints a session for a persona in the target environment. The real implementation lives in an
 * adapter module and is the ONLY holder of privileged identity keys. It returns the persona user id.
 */
export interface IdentityAdapter {
  ensurePersonaUser(persona: PersonaKey): Promise<{ user_id: string }>;
  revokeUserSessions(userId: string): Promise<void>;
}

/** Removes data written by one test session, identified only by its tag. */
export interface TestDataAdapter {
  deleteTaggedBySession(sessionId: string): Promise<number>;
}

export interface BrokerDeps {
  store: SessionStore;
  audit: AuditSink;
  identity: IdentityAdapter;
  data: TestDataAdapter;
  roster?: readonly AgentRosterEntry[];
  now?: () => Date;
}

export interface SessionGrant {
  session_id: string;
  token: string; // returned once; never stored
  agent_id: string;
  persona: PersonaKey;
  user_id: string;
  expires_at: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class TestSessionBroker {
  private readonly roster: readonly AgentRosterEntry[];
  private readonly now: () => Date;

  constructor(private readonly deps: BrokerDeps) {
    this.roster = deps.roster ?? AGENT_ROSTER;
    this.now = deps.now ?? (() => new Date());
  }

  private async emit(e: Omit<AuditEvent, 'at'>): Promise<void> {
    await this.deps.audit.append({ at: this.now().toISOString(), ...e });
  }

  /** Issue a short-lived session for `agentId` as `persona` in `environment`. */
  async requestSession(input: {
    agent_id: string;
    persona: PersonaKey;
    environment: string;
    ttl_seconds?: number;
  }): Promise<SessionGrant> {
    const { agent_id: agentId, persona, environment } = input;
    const deny = async (code: BrokerErrorCode, message: string): Promise<never> => {
      await this.emit({ action: 'session.denied', agent_id: agentId, session_id: null, persona, detail: code });
      throw new BrokerError(code, message);
    };

    if (!(ALLOWED_ENVIRONMENTS as readonly string[]).includes(environment)) {
      return deny('environment_not_allowed', `environment "${environment}" is not a test environment`);
    }
    const agent = findAgent(agentId, this.roster);
    if (!agent) return deny('agent_unknown', `agent "${agentId}" is not on the roster`);
    if (agent.status !== 'active') return deny('agent_suspended', `agent "${agentId}" is ${agent.status}`);
    if (!agent.personas.includes(persona)) return deny('persona_not_allowed', `agent "${agentId}" may not use persona ${persona}`);
    if (!tierAllows(agent.tier, persona)) return deny('tier_insufficient', `tier ${agent.tier} may not use persona ${persona}`);

    const ttl = input.ttl_seconds ?? SESSION_TTL_DEFAULT_S;
    if (!Number.isInteger(ttl) || ttl < SESSION_TTL_MIN_S || ttl > SESSION_TTL_MAX_S) {
      return deny('ttl_invalid', `ttl must be an integer in [${SESSION_TTL_MIN_S}, ${SESSION_TTL_MAX_S}]`);
    }

    const { user_id: userId } = await this.deps.identity.ensurePersonaUser(persona);
    const token = randomBytes(32).toString('base64url');
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + ttl * 1000);
    const sessionId = randomUUID();

    await this.deps.store.insert({
      session_id: sessionId,
      agent_id: agentId,
      persona,
      environment,
      user_id: userId,
      token_hash: hashToken(token),
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      revoked_at: null,
      revoke_reason: null,
    });
    await this.emit({ action: 'session.issued', agent_id: agentId, session_id: sessionId, persona, detail: `ttl=${ttl}s` });
    return { session_id: sessionId, token, agent_id: agentId, persona, user_id: userId, expires_at: expiresAt.toISOString() };
  }

  /** Resolve a bearer token to its live session, or throw. Each use is audited. */
  async authenticate(token: string): Promise<SessionRecord> {
    const rec = await this.deps.store.findByTokenHash(hashToken(token));
    if (!rec) throw new BrokerError('token_invalid', 'unknown or malformed token');
    if (rec.revoked_at) {
      await this.emit({ action: 'session.denied', agent_id: rec.agent_id, session_id: rec.session_id, persona: rec.persona, detail: 'session_revoked' });
      throw new BrokerError('session_revoked', 'session has been revoked');
    }
    if (new Date(rec.expires_at).getTime() <= this.now().getTime()) {
      await this.emit({ action: 'session.denied', agent_id: rec.agent_id, session_id: rec.session_id, persona: rec.persona, detail: 'session_expired' });
      throw new BrokerError('session_expired', 'session has expired');
    }
    const agent = findAgent(rec.agent_id, this.roster);
    if (!agent || agent.status !== 'active') {
      await this.revokeSession(rec.session_id, 'agent no longer active');
      throw new BrokerError('session_revoked', 'agent is no longer active');
    }
    await this.emit({ action: 'session.used', agent_id: rec.agent_id, session_id: rec.session_id, persona: rec.persona, detail: 'authenticated' });
    return rec;
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    const rec = await this.deps.store.get(sessionId);
    if (!rec || rec.revoked_at) return; // idempotent
    await this.deps.store.update(sessionId, { revoked_at: this.now().toISOString(), revoke_reason: reason });
    await this.deps.identity.revokeUserSessions(rec.user_id).catch(() => undefined);
    await this.emit({ action: 'session.revoked', agent_id: rec.agent_id, session_id: sessionId, persona: rec.persona, detail: reason });
  }

  /** Suspend an agent: it can get no new session, and every live one is revoked. */
  async suspendAgent(agentId: string, reason: string): Promise<number> {
    const live = await this.deps.store.activeForAgent(agentId);
    for (const s of live) await this.revokeSession(s.session_id, `agent suspended: ${reason}`);
    await this.emit({ action: 'agent.suspended', agent_id: agentId, session_id: null, persona: null, detail: reason });
    return live.length;
  }

  /** Remove the rows a session wrote. Deletes only rows tagged with that session id. */
  async cleanupSession(sessionId: string): Promise<number> {
    const rec = await this.deps.store.get(sessionId);
    if (!rec) throw new BrokerError('token_invalid', 'no such session');
    if (!rec.revoked_at) await this.revokeSession(sessionId, 'cleanup');
    const removed = await this.deps.data.deleteTaggedBySession(sessionId);
    await this.emit({ action: 'session.cleaned', agent_id: rec.agent_id, session_id: sessionId, persona: rec.persona, detail: `rows_removed=${removed}` });
    return removed;
  }
}

/** Convenience for callers that want the persona definition alongside a grant. */
export function personaFor(key: PersonaKey) {
  return PERSONAS[key];
}
