/**
 * VTID-01952 — Memory Audit Chokepoint
 *
 * Single application-layer entry point for memory writes that need:
 *   1. Identity Lock enforcement (Maria → Kemal class of bug)
 *   2. Provenance fields enforced + propagated
 *   3. HIPAA audit trail emitted via OASIS
 *
 * Existing writers (cognee-extractor-client, orb-live, conversation, memory.ts)
 * route their identity-class fact writes through assertWriteFact() before
 * calling write_fact() RPC. The Postgres trigger
 * `enforce_identity_lock_memory_facts` (migration vtid_01952) is defense-in-depth
 * for any code path that bypasses this chokepoint.
 *
 * Plan reference: /home/dstev/.claude/plans/the-vitana-system-has-wild-puffin.md
 *                 Part 1.5 + Part 6 (Unified Write Broker)
 */

import { emitOasisEvent } from './oasis-event-service';
import {
  IdentityLockViolation,
  assertIdentityLockOk,
  composeIdentityRefusal,
  isIdentityLockedKey,
  type IdentityLockedKey,
  type RedirectTarget,
  type SupportedLocale,
} from './memory-identity-lock';

// ============================================================================
// Types
// ============================================================================

export interface MemoryWriteAttemptInput {
  /** The key being written (e.g. 'user_first_name', 'favorite_food'). */
  fact_key: string;
  /** The intended provenance source (e.g. 'assistant_inferred', 'user_stated_via_settings'). */
  provenance_source: string | null | undefined;
  /** Provenance confidence 0..1. */
  provenance_confidence?: number;
  /** Who is performing the write (e.g. 'orb-live', 'cognee-extractor', 'profile-ui'). */
  actor_id: string;
  /** Tenant + user scope (REQUIRED — never skip). */
  tenant_id: string;
  user_id: string;
  /** Optional: which engine produced this (closes OASIS provenance gap). */
  source_engine?: string;
  /** Optional: the OASIS event id of the originating user turn. */
  source_event_id?: string;
  /** Optional: locale for the user-facing refusal message. */
  user_locale?: SupportedLocale;
  /** Optional: classification flags for HIPAA audit. */
  classification?: {
    health?: boolean;
    pii?: boolean;
    ephemeral?: boolean;
  };
}

export type MemoryWriteAttemptResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'identity_locked';
      fact_key: string;
      attempted_provenance_source: string | null | undefined;
      redirect_target: RedirectTarget;
      refusal_message: string;
    };

// Memory governance policy version. Bump when the rules change so audit logs
// can be replayed against the version that was in force at write time.
export const MEMORY_POLICY_VERSION = 'mem-2026.04';

// ============================================================================
// The chokepoint: assertWriteFact()
//
// Call this BEFORE any write_fact() RPC call. If it returns ok=true, proceed
// with the write. If ok=false, do NOT write — instead, surface the
// refusal_message + redirect_target up to the caller (ORB / brain / etc.) so
// the user gets the sanctioned refusal-and-redirect response.
//
// Always emits a memory.identity.write_attempted OASIS event for any write
// to an identity-class key (allowed or rejected). Non-identity writes are
// silently allowed (no event spam).
// ============================================================================

export async function assertWriteFact(
  input: MemoryWriteAttemptInput
): Promise<MemoryWriteAttemptResult> {
  // Fast path: not identity-locked → allow without audit overhead.
  if (!isIdentityLockedKey(input.fact_key)) {
    return { ok: true };
  }

  // Identity-locked key path: check + audit either way.
  const factKey = input.fact_key as IdentityLockedKey;
  const locale = input.user_locale ?? 'en';

  try {
    assertIdentityLockOk({
      fact_key: input.fact_key,
      provenance_source: input.provenance_source,
      actor_id: input.actor_id,
    });

    // Allowed.
    await emitOasisEvent({
      vtid: 'VTID-01952',
      type: 'memory.identity.write_attempted',
      source: 'memory-audit',
      status: 'success',
      message: `identity write allowed: ${factKey} via ${input.provenance_source ?? '<null>'}`,
      payload: {
        fact_key: factKey,
        provenance_source: input.provenance_source ?? null,
        provenance_confidence: input.provenance_confidence ?? null,
        actor_id: input.actor_id,
        source_engine: input.source_engine ?? null,
        source_event_id: input.source_event_id ?? null,
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        allowed: true,
        policy_version: MEMORY_POLICY_VERSION,
        health_scope: !!input.classification?.health,
      },
      actor_id: input.actor_id,
      actor_role: 'system',
      surface: 'system',
    }).catch((err: unknown) => {
      // Audit must never block the actual write. Log and continue.
      console.warn('[VTID-01952] failed to emit memory.identity.write_attempted (allowed):', err);
    });

    return { ok: true };
  } catch (err) {
    if (!(err instanceof IdentityLockViolation)) {
      throw err; // Unknown error: bubble up.
    }

    // Rejected. Build the structured refusal for the caller.
    const refusal = composeIdentityRefusal(factKey, locale);

    await emitOasisEvent({
      vtid: 'VTID-01952',
      type: 'memory.identity.write_attempted',
      source: 'memory-audit',
      status: 'warning', // not 'error' — rejection is the system working as designed
      message: `identity write REJECTED: ${factKey} attempted via ${input.provenance_source ?? '<null>'} from ${input.actor_id}`,
      payload: {
        fact_key: factKey,
        provenance_source: input.provenance_source ?? null,
        provenance_confidence: input.provenance_confidence ?? null,
        actor_id: input.actor_id,
        source_engine: input.source_engine ?? null,
        source_event_id: input.source_event_id ?? null,
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        allowed: false,
        rejection_reason: 'locked_key_unauthorized_provenance',
        redirect_target: refusal.redirect_target,
        policy_version: MEMORY_POLICY_VERSION,
        health_scope: !!input.classification?.health,
      },
      actor_id: input.actor_id,
      actor_role: 'system',
      surface: 'system',
    }).catch((emitErr: unknown) => {
      console.warn('[VTID-01952] failed to emit memory.identity.write_attempted (rejected):', emitErr);
    });

    return {
      ok: false,
      reason: 'identity_locked',
      fact_key: factKey,
      attempted_provenance_source: input.provenance_source,
      redirect_target: refusal.redirect_target,
      refusal_message: refusal.message,
    };
  }
}

// ============================================================================
// auditWritePersisted() — emit memory.write.persisted after a successful write.
// HIPAA-grade audit trail for all writes that touch health-classified data.
// ============================================================================

export interface PersistedAuditInput {
  fact_key: string;
  fact_id?: string;
  provenance_source: string;
  provenance_confidence: number;
  actor_id: string;
  source_engine: string;
  source_event_id?: string;
  tenant_id: string;
  user_id: string;
  classification?: {
    health?: boolean;
    pii?: boolean;
    ephemeral?: boolean;
  };
}

export async function auditWritePersisted(input: PersistedAuditInput): Promise<void> {
  const isHealth = !!input.classification?.health;

  // Skip event spam for non-health, non-identity writes — they're already
  // captured by the existing memory.write.completed event flow.
  if (!isHealth && !isIdentityLockedKey(input.fact_key)) {
    return;
  }

  await emitOasisEvent({
    vtid: 'VTID-01952',
    type: 'memory.write.persisted',
    source: 'memory-audit',
    status: 'success',
    message: `memory write persisted: ${input.fact_key} (${input.provenance_source})`,
    payload: {
      fact_key: input.fact_key,
      fact_id: input.fact_id ?? null,
      provenance_source: input.provenance_source,
      provenance_confidence: input.provenance_confidence,
      actor_id: input.actor_id,
      source_engine: input.source_engine,
      source_event_id: input.source_event_id ?? null,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      health_scope: isHealth,
      identity_scope: isIdentityLockedKey(input.fact_key),
      policy_version: MEMORY_POLICY_VERSION,
    },
    actor_id: input.actor_id,
    actor_role: 'system',
    surface: 'system',
  }).catch((err: unknown) => {
    console.warn('[VTID-01952] failed to emit memory.write.persisted:', err);
  });
}

// ============================================================================
// VTID-01966 Phase 2 — HIPAA-grade memory_audit_log writes
//
// Dedicated audit table (separate from oasis_events) so:
//   1. Every memory READ + WRITE is captured uniformly with rich provenance.
//   2. HIPAA replay queries (give me everything user X accessed in date
//      range Y) are O(index) instead of O(table scan on oasis_events).
//   3. Append-only + monthly partitions enable cheap retention drops.
//
// Writes are fire-and-forget — audit must NEVER block the actual memory
// operation. If Postgres is slow or down, log + proceed.
//
// Plan: Part 7 schema + Part 8 Phase 2.
// ============================================================================

const SUPABASE_URL_ENV = process.env.SUPABASE_URL;
const SUPABASE_SR_ENV = process.env.SUPABASE_SERVICE_ROLE;

export type MemoryAuditOp = 'read' | 'write' | 'delete' | 'consolidate';

export interface MemoryAuditRow {
  /** REQUIRED. Tenant scope. */
  tenant_id: string;
  /** REQUIRED. User UUID (the subject of the read/write). */
  user_id: string;
  /** REQUIRED. read | write | delete | consolidate. */
  op: MemoryAuditOp;
  /** REQUIRED. Storage tier or logical layer (tier0, tier1, tier2, tier3, identity-lock, etc.). */
  tier: string;
  /** REQUIRED. Who/what performed the operation. */
  actor_id: string;
  /** Optional: which engine produced this (orb-live, conversation-client, etc.). */
  source_engine?: string;
  /** Optional: 0..1. Null when it doesn't apply (e.g. consolidator runs). */
  confidence?: number;
  /** Optional: upstream OASIS event id if applicable. */
  source_event_id?: string;
  /** Optional: defaults to MEMORY_POLICY_VERSION. */
  policy_version?: string;
  /** Optional: HIPAA classification flag. */
  health_scope?: boolean;
  /** Optional: identity-locked fact_key touched? */
  identity_scope?: boolean;
  /** Optional: free-form context (intent, fact_keys, latency_ms, etc.). */
  details?: Record<string, unknown>;
}

/**
 * Append a row to memory_audit_log. Fire-and-forget — never throws, never
 * blocks. Failures log a single warn line.
 *
 * Use this for both reads AND writes. Cheaper than emitting a full OASIS
 * event for every read (which would balloon the events table).
 */
export async function appendMemoryAuditRow(row: MemoryAuditRow): Promise<void> {
  if (!SUPABASE_URL_ENV || !SUPABASE_SR_ENV) {
    // Tests / misconfigured environments — silently skip.
    return;
  }

  // Fire-and-forget. Any error is caught + logged, never re-thrown.
  try {
    const body = {
      p_tenant_id: row.tenant_id,
      p_user_id: row.user_id,
      p_op: row.op,
      p_tier: row.tier,
      p_actor_id: row.actor_id,
      p_policy_version: row.policy_version ?? MEMORY_POLICY_VERSION,
      p_source_engine: row.source_engine ?? null,
      p_confidence: row.confidence ?? null,
      p_source_event_id: row.source_event_id ?? null,
      p_health_scope: !!row.health_scope,
      p_identity_scope: !!row.identity_scope,
      p_details: row.details ?? {},
    };

    const resp = await fetch(`${SUPABASE_URL_ENV}/rest/v1/rpc/memory_audit_log_insert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SR_ENV,
        Authorization: `Bearer ${SUPABASE_SR_ENV}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok && resp.status !== 200 && resp.status !== 201 && resp.status !== 204) {
      const text = await resp.text().catch(() => '');
      console.warn(`[VTID-01966] memory_audit_log_insert failed ${resp.status}: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn('[VTID-01966] memory_audit_log_insert threw (non-fatal):', (err as Error)?.message);
  }
}

// ----------------------------------------------------------------------------
// Read-side audit helper — call this AFTER a memory read completes.
// Captures intent, tier(s) hit, latency, and result counts as `details`.
// ----------------------------------------------------------------------------

export interface MemoryReadAuditInput {
  tenant_id: string;
  user_id: string;
  /** Logical tier or read-source name (e.g. 'tier0+tier1', 'context-pack-builder', 'memory_get_context'). */
  tier: string;
  actor_id: string;
  source_engine?: string;
  source_event_id?: string;
  /** What the read returned + how it was performed. */
  details?: {
    intent?: string;
    query_preview?: string;
    blocks_returned?: string[];
    item_counts?: Record<string, number>;
    latency_ms?: number;
    cache_hit?: boolean;
    degraded?: boolean;
    [k: string]: unknown;
  };
  health_scope?: boolean;
}

export async function auditMemoryRead(input: MemoryReadAuditInput): Promise<void> {
  await appendMemoryAuditRow({
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    op: 'read',
    tier: input.tier,
    actor_id: input.actor_id,
    source_engine: input.source_engine,
    source_event_id: input.source_event_id,
    health_scope: input.health_scope,
    identity_scope: false,
    details: input.details ?? {},
  });
}

// ----------------------------------------------------------------------------
// Write-side audit helper — call this AFTER a memory write succeeds (or fails).
// For identity-locked writes, use auditWritePersisted() above (which also
// emits the dedicated OASIS event); for ordinary writes, this is the
// lightweight HIPAA-grade trail.
// ----------------------------------------------------------------------------

export interface MemoryWriteAuditInput {
  tenant_id: string;
  user_id: string;
  tier: string;          // 'memory_items', 'memory_facts', 'mem_episodes', 'tier0', etc.
  actor_id: string;
  source_engine?: string;
  source_event_id?: string;
  confidence?: number;
  health_scope?: boolean;
  identity_scope?: boolean;
  details?: Record<string, unknown>;
}

export async function auditMemoryWrite(input: MemoryWriteAuditInput): Promise<void> {
  await appendMemoryAuditRow({
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    op: 'write',
    tier: input.tier,
    actor_id: input.actor_id,
    source_engine: input.source_engine,
    source_event_id: input.source_event_id,
    confidence: input.confidence,
    health_scope: input.health_scope,
    identity_scope: input.identity_scope,
    details: input.details ?? {},
  });
}
