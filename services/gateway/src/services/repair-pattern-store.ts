/**
 * VTID-02970 (PR-L5): Repair pattern store.
 *
 * Records every verified successful repair (fault_signature + fix_diff)
 * and exposes a lookup so the failure scanner can short-circuit
 * diagnose-then-LLM when the same signature recurs.
 *
 * V1 surface (this file):
 *   - recordPattern(input)        upsert; bumps success_count if same
 *                                 (fault_signature, capability) exists
 *   - findPatternBySignature(sig) returns the highest-success_count
 *                                 non-quarantined pattern matching sig,
 *                                 OR null when none
 *   - markPatternOutcome(id, ok)  ++success_count on ok=true,
 *                                 ++failure_count on ok=false; auto-
 *                                 quarantines on 2 consecutive failures
 *   - listPatterns()              cockpit read
 *
 * Pure helpers exported for tests:
 *   - shouldQuarantineAfter(failureCount)
 *   - matchesSignature(stored, query) — exact equality in v1; substring/
 *     regex matching is a v1.1 follow-up to keep false-positive risk low.
 */

export interface RepairPattern {
  id: string;
  fault_signature: string;
  capability: string;
  target_file: string | null;
  fix_diff: string;
  source_pr_url: string | null;
  source_repair_vtid: string | null;
  success_count: number;
  failure_count: number;
  quarantined: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordPatternInput {
  fault_signature: string;
  capability: string;
  target_file?: string | null;
  fix_diff: string;
  source_pr_url?: string | null;
  source_repair_vtid?: string | null;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
  };
}

function supabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE);
}

/**
 * Pure: returns true when the pattern's failure_count just crossed the
 * auto-quarantine threshold. v1 uses 2 consecutive failures as the
 * gate (matching the failure scanner's debounce semantics — both layers
 * tolerate one flake before escalating).
 */
export function shouldQuarantineAfter(failureCount: number): boolean {
  return failureCount >= 2;
}

/**
 * Pure: signature match check. v1 is exact equality so we never apply a
 * recorded fix_diff to a slightly-different failure mode by accident.
 *
 * Future versions may relax to a normalized-prefix match (e.g. ignore
 * line numbers in stack traces) but that needs a corpus to tune
 * against; punting until we have one.
 */
export function matchesSignature(stored: string, query: string): boolean {
  return stored === query;
}

// ============================================================================
// Networked operations
// ============================================================================

/**
 * Upsert a pattern by (fault_signature, capability). When the row
 * already exists we BUMP success_count and refresh fix_diff/source —
 * the most recently verified repair becomes canonical.
 */
export async function recordPattern(input: RecordPatternInput): Promise<RepairPattern | null> {
  if (!supabaseConfigured()) return null;

  // Check existing
  const lookup = await fetch(
    `${SUPABASE_URL}/rest/v1/repair_patterns?fault_signature=eq.${encodeURIComponent(input.fault_signature)}&capability=eq.${encodeURIComponent(input.capability)}&select=id,success_count,failure_count&limit=1`,
    { headers: supabaseHeaders() },
  );
  if (!lookup.ok) return null;
  const existing = (await lookup.json()) as Array<{
    id: string;
    success_count: number;
    failure_count: number;
  }>;

  const now = new Date().toISOString();

  if (existing.length > 0) {
    const row = existing[0];
    const patchResp = await fetch(
      `${SUPABASE_URL}/rest/v1/repair_patterns?id=eq.${row.id}`,
      {
        method: 'PATCH',
        headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
        body: JSON.stringify({
          fix_diff: input.fix_diff,
          source_pr_url: input.source_pr_url ?? null,
          source_repair_vtid: input.source_repair_vtid ?? null,
          success_count: row.success_count + 1,
          // A successful repair RESETS the failure streak — quarantine
          // semantics track CONSECUTIVE failures, not lifetime totals.
          failure_count: 0,
          quarantined: false,
          last_used_at: now,
        }),
      },
    );
    if (!patchResp.ok) return null;
    const rows = (await patchResp.json()) as RepairPattern[];
    return rows[0] ?? null;
  }

  // Insert
  const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/repair_patterns`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({
      fault_signature: input.fault_signature,
      capability: input.capability,
      target_file: input.target_file ?? null,
      fix_diff: input.fix_diff,
      source_pr_url: input.source_pr_url ?? null,
      source_repair_vtid: input.source_repair_vtid ?? null,
      success_count: 1,
      failure_count: 0,
      quarantined: false,
      last_used_at: now,
    }),
  });
  if (!insertResp.ok) return null;
  const rows = (await insertResp.json()) as RepairPattern[];
  return rows[0] ?? null;
}

/**
 * Find the best non-quarantined pattern for a signature. "Best" = highest
 * success_count (ties broken by most-recent last_used_at). Returns null
 * when no proven pattern exists.
 *
 * v1 returns even single-success patterns. The CALLER (failure scanner)
 * decides whether to embed the diff in the spec based on success_count
 * threshold — keeps the policy tunable without redeploying the store.
 */
export async function findPatternBySignature(
  fault_signature: string,
): Promise<RepairPattern | null> {
  if (!supabaseConfigured()) return null;
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/repair_patterns?fault_signature=eq.${encodeURIComponent(fault_signature)}&quarantined=eq.false&order=success_count.desc,last_used_at.desc.nullslast&limit=1`,
    { headers: supabaseHeaders() },
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as RepairPattern[];
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Record outcome of an attempted pattern application. ok=true bumps
 * success_count + clears failure streak. ok=false bumps failure_count;
 * if it crosses the threshold, the pattern auto-quarantines.
 */
export async function markPatternOutcome(
  id: string,
  ok: boolean,
): Promise<RepairPattern | null> {
  if (!supabaseConfigured()) return null;

  const lookup = await fetch(
    `${SUPABASE_URL}/rest/v1/repair_patterns?id=eq.${id}&select=success_count,failure_count&limit=1`,
    { headers: supabaseHeaders() },
  );
  if (!lookup.ok) return null;
  const rows = (await lookup.json()) as Array<{ success_count: number; failure_count: number }>;
  if (rows.length === 0) return null;
  const row = rows[0];
  const now = new Date().toISOString();

  let body: Record<string, unknown>;
  if (ok) {
    body = {
      success_count: row.success_count + 1,
      failure_count: 0,
      quarantined: false,
      last_used_at: now,
    };
  } else {
    const newFailure = row.failure_count + 1;
    body = {
      failure_count: newFailure,
      quarantined: shouldQuarantineAfter(newFailure),
      last_used_at: now,
    };
  }

  const patchResp = await fetch(`${SUPABASE_URL}/rest/v1/repair_patterns?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!patchResp.ok) return null;
  const out = (await patchResp.json()) as RepairPattern[];
  return out[0] ?? null;
}

export async function listPatterns(opts?: { includeQuarantined?: boolean }): Promise<RepairPattern[]> {
  if (!supabaseConfigured()) return [];
  const filter = opts?.includeQuarantined ? '' : '&quarantined=eq.false';
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/repair_patterns?select=*${filter}&order=success_count.desc,last_used_at.desc.nullslast`,
    { headers: supabaseHeaders() },
  );
  if (!r.ok) return [];
  return (await r.json()) as RepairPattern[];
}
