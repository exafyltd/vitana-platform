/**
 * Voice Spec Memory (VTID-01960, PR #3)
 *
 * Read/write helpers for the `voice_healing_spec_memory` table. The adapter's
 * Spec Memory Gate consults `lookupSpecMemory` before dispatching; the
 * synthetic probe (PR #4) and auto-rollback (PR #4) write outcomes via
 * `recordSpecMemory`.
 *
 * Gate semantics (matches plan, see voice-self-healing-adapter.ts):
 *   - probe_failed or rollback in last 72h → block (route to investigator).
 *   - success in last 72h AND signature firing again → block + investigator
 *     (the prior fix didn't actually hold).
 *   - partial in last 72h → allow with elevated telemetry.
 *   - no recent attempt → allow.
 *
 * Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

export type SpecOutcome = 'success' | 'probe_failed' | 'rollback' | 'partial';

const LOOKUP_WINDOW_HOURS = 72;

export interface SpecMemoryRow {
  spec_hash: string;
  normalized_signature: string;
  attempted_at: string;
  outcome: SpecOutcome;
  vtid?: string | null;
  detail?: string | null;
}

export interface SpecMemoryDecision {
  /** True = adapter should block dispatch and route to investigator. */
  block: boolean;
  /** Why we blocked (for telemetry). 'allow' when block=false. */
  reason:
    | 'allow'
    | 'recent_failure'
    | 'recent_rollback'
    | 'recurring_after_success'
    | 'memory_unavailable';
  /** The matched row, if any. */
  matched?: SpecMemoryRow;
  /** All rows in the lookup window (for tests / dashboards). */
  recent: SpecMemoryRow[];
}

function supabaseHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Look up recent spec_memory rows for (spec_hash, normalized_signature) and
 * decide whether the adapter should block dispatch.
 *
 * @param signatureFiring true when the same signature is firing again (i.e.
 *   the classifier returned this signature for the current observation).
 *   Used to escalate "recurring after success" — otherwise success rows
 *   never block.
 */
export async function lookupSpecMemory(
  spec_hash: string,
  normalized_signature: string,
  signatureFiring: boolean = true,
): Promise<SpecMemoryDecision> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { block: false, reason: 'memory_unavailable', recent: [] };
  }

  const cutoff = new Date(Date.now() - LOOKUP_WINDOW_HOURS * 3600_000).toISOString();
  const url =
    `${SUPABASE_URL}/rest/v1/voice_healing_spec_memory?` +
    `spec_hash=eq.${encodeURIComponent(spec_hash)}&` +
    `normalized_signature=eq.${encodeURIComponent(normalized_signature)}&` +
    `attempted_at=gte.${encodeURIComponent(cutoff)}&` +
    `order=attempted_at.desc&limit=20`;

  let recent: SpecMemoryRow[] = [];
  try {
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (res.ok) {
      recent = (await res.json()) as SpecMemoryRow[];
    }
  } catch {
    return { block: false, reason: 'memory_unavailable', recent: [] };
  }

  // Hard blocks: any probe_failed or rollback in window.
  const failure = recent.find((r) => r.outcome === 'probe_failed');
  if (failure) {
    return { block: true, reason: 'recent_failure', matched: failure, recent };
  }
  const rollback = recent.find((r) => r.outcome === 'rollback');
  if (rollback) {
    return { block: true, reason: 'recent_rollback', matched: rollback, recent };
  }

  // Soft block: success in window AND signature is firing again now → the
  // prior fix didn't hold. Route to investigator with concrete evidence.
  if (signatureFiring) {
    const success = recent.find((r) => r.outcome === 'success');
    if (success) {
      return { block: true, reason: 'recurring_after_success', matched: success, recent };
    }
  }

  return { block: false, reason: 'allow', recent };
}

export interface RecordSpecMemoryInput {
  spec_hash: string;
  normalized_signature: string;
  outcome: SpecOutcome;
  vtid?: string | null;
  detail?: string | null;
  evidence_ref?: string | null;
}

/**
 * Insert a spec memory row. Used by the synthetic probe (success / partial),
 * auto-rollback (rollback), and the reconciler verification branch
 * (probe_failed). Returns true on success, false otherwise — never throws.
 */
export async function recordSpecMemory(input: RecordSpecMemoryInput): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return false;
  const row = {
    spec_hash: input.spec_hash,
    normalized_signature: input.normalized_signature,
    outcome: input.outcome,
    vtid: input.vtid ?? null,
    detail: input.detail ?? null,
    evidence_ref: input.evidence_ref ?? null,
  };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/voice_healing_spec_memory`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
    return res.ok;
  } catch {
    return false;
  }
}
