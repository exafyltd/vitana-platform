/**
 * VTID-02958 (PR-L3): Test Contract Failure Scanner.
 *
 * The scheduled runner of the autonomy spine. Runs every contract in
 * the registry on a cadence (live_probe contracts only in PR-L3; jest
 * and typecheck contracts land in PR-L3.1 with Cloud Run Job dispatch),
 * records every run in test_contract_runs, and triggers repair VTIDs
 * when the failure debounce rule fires.
 *
 * State machine (pure — exported for testing):
 *
 *   pass → record run as passed, update test_contracts.{status,
 *          last_passing_sha, last_run_at}. Done.
 *
 *   fail (1st of signature) → record as failed. Update test_contracts
 *          but DO NOT allocate a repair VTID. We need to see the same
 *          signature twice consecutively before we believe it.
 *
 *   fail (2nd consecutive same signature) → record + allocate repair
 *          VTID with metadata.repair_kind='fix_failing_test' and the
 *          full reproducible context. The existing dev_autopilot
 *          pipeline picks it up.
 *
 *   fail (subsequent same signature, repair already in flight) → record
 *          but do NOT allocate another repair VTID. Idempotent.
 *
 *   3 repair allocations within 24h on the same contract → quarantine.
 *          Contract status flips to 'quarantined'. No more repair VTIDs
 *          until a human re-arms it.
 */

import { resolveCommand, type TestContractRunResult } from './test-contract-commands';

export type DispatchedBy = 'scheduled_runner' | 'manual_admin' | 'self_healing_reconciler';

export interface ContractRow {
  id: string;
  capability: string;
  service: string;
  environment: string;
  command_key: string;
  target_endpoint: string | null;
  target_file: string | null;
  expected_behavior: unknown;
  status: 'unknown' | 'pass' | 'fail' | 'pending' | 'quarantined';
  last_status: string | null;
  last_failure_signature: string | null;
  last_passing_sha: string | null;
  repairable: boolean;
}

export interface RecentRunRow {
  id: string;
  passed: boolean;
  failure_signature: string | null;
  dispatched_at: string;
  repair_vtid: string | null;
}

/**
 * Decide what the scanner should do with this run result given the
 * contract's recent history. Pure — no I/O. All side effects (DB
 * writes, OASIS events, VTID allocation) happen in the route layer
 * informed by this decision.
 *
 * @param result - the just-completed run from the allowlist dispatcher
 * @param contract - the contract row at run time
 * @param recentRuns - the last N runs (most-recent-first). N=10 is enough
 *                     for the debounce + 24h quarantine check; more is wasted I/O.
 * @param now - injected clock for deterministic tests
 */
export interface ScannerDecision {
  /** What status to PATCH onto test_contracts.status. */
  new_status: 'pass' | 'fail' | 'quarantined';
  /** Whether the failure passed the debounce gate (2nd consecutive same signature). */
  should_allocate_repair: boolean;
  /** True iff the contract is being quarantined this cycle (3rd repair in 24h). */
  should_quarantine: boolean;
  /** Why this decision was made — surfaced via OASIS for observability. */
  reason: string;
  /** Failure signature for this run (null when result.passed). */
  failure_signature: string | null;
}

export function computeFailureSignature(commandKey: string, failureReason: string | null): string {
  if (!failureReason) return `${commandKey}:unknown_failure`;
  // Take the first line of the reason — keeps the signature stable when
  // body excerpts differ run-to-run but the actual error doesn't.
  const firstLine = failureReason.split('\n')[0].trim().slice(0, 200);
  return `${commandKey}:${firstLine}`;
}

/**
 * Count failed runs going back from "most recent" that share the SAME
 * failure_signature. Stops at the first run that's passed or has a
 * different signature.
 */
export function consecutiveSameSignatureFailures(
  recentRuns: RecentRunRow[],
  signature: string,
): number {
  let count = 0;
  for (const r of recentRuns) {
    if (r.passed) break;
    if (r.failure_signature !== signature) break;
    count += 1;
  }
  return count;
}

/**
 * Count distinct repair_vtid values across runs within the past 24h.
 * Each repair-VTID allocation is a separate attempt; 3 in 24h triggers
 * quarantine to protect against repair loops on a genuinely-broken
 * capability that the LLM cannot fix.
 */
export function repairAttemptsLast24h(
  recentRuns: RecentRunRow[],
  now: number,
): number {
  const cutoff = now - 24 * 3600_000;
  const seen = new Set<string>();
  for (const r of recentRuns) {
    if (!r.repair_vtid) continue;
    if (new Date(r.dispatched_at).getTime() < cutoff) continue;
    seen.add(r.repair_vtid);
  }
  return seen.size;
}

/**
 * Already-in-flight repair check: if any run within the last 24h has a
 * repair_vtid populated AND that VTID isn't already terminal, we don't
 * allocate a duplicate. The caller checks termination state separately
 * (this function only flags "we tried already"); the route then queries
 * vtid_ledger before deciding.
 */
export function hasInFlightRepairAttempt(
  recentRuns: RecentRunRow[],
  signature: string,
  now: number,
): string | null {
  const cutoff = now - 24 * 3600_000;
  for (const r of recentRuns) {
    if (!r.repair_vtid) continue;
    if (r.failure_signature !== signature) continue;
    if (new Date(r.dispatched_at).getTime() < cutoff) continue;
    return r.repair_vtid;
  }
  return null;
}

export function decideScannerOutcome(
  result: TestContractRunResult,
  contract: ContractRow,
  recentRuns: RecentRunRow[],
  now: number = Date.now(),
): ScannerDecision {
  if (result.passed) {
    return {
      new_status: 'pass',
      should_allocate_repair: false,
      should_quarantine: false,
      reason: 'run_passed',
      failure_signature: null,
    };
  }

  const signature = computeFailureSignature(contract.command_key, result.failure_reason || null);

  // Quarantined contracts stay quarantined — only a human re-arm flips
  // status back to 'unknown' or 'fail'. The runner still records runs
  // (so the operator sees the contract is still failing) but allocates
  // no repair work.
  if (contract.status === 'quarantined') {
    return {
      new_status: 'quarantined',
      should_allocate_repair: false,
      should_quarantine: false,
      reason: 'contract_quarantined',
      failure_signature: signature,
    };
  }

  if (!contract.repairable) {
    return {
      new_status: 'fail',
      should_allocate_repair: false,
      should_quarantine: false,
      reason: 'contract_marked_non_repairable',
      failure_signature: signature,
    };
  }

  // This new failure is the (k+1)th in the consecutive same-signature run.
  // recentRuns excludes the current run (it hasn't been inserted yet), so
  // k = consecutiveSameSignatureFailures(recentRuns, signature).
  const priorConsecutive = consecutiveSameSignatureFailures(recentRuns, signature);
  const consecutiveNow = priorConsecutive + 1;

  // Debounce: first failure of a signature is silent (could be flake).
  if (consecutiveNow < 2) {
    return {
      new_status: 'fail',
      should_allocate_repair: false,
      should_quarantine: false,
      reason: 'first_failure_of_signature_debouncing',
      failure_signature: signature,
    };
  }

  // Quarantine: 3 repair attempts in 24h, this would be the 4th. Halt
  // the loop and surface to humans.
  const priorRepairs = repairAttemptsLast24h(recentRuns, now);
  if (priorRepairs >= 3) {
    return {
      new_status: 'quarantined',
      should_allocate_repair: false,
      should_quarantine: true,
      reason: `quarantine_repair_attempts_exceeded_${priorRepairs}_in_24h`,
      failure_signature: signature,
    };
  }

  // Idempotency: a repair VTID is already in flight for this signature
  // within the last 24h. Don't allocate a duplicate; the existing
  // autopilot run will land or fail.
  const inFlight = hasInFlightRepairAttempt(recentRuns, signature, now);
  if (inFlight) {
    return {
      new_status: 'fail',
      should_allocate_repair: false,
      should_quarantine: false,
      reason: `repair_already_in_flight_${inFlight}`,
      failure_signature: signature,
    };
  }

  // Go: allocate a repair VTID.
  return {
    new_status: 'fail',
    should_allocate_repair: true,
    should_quarantine: false,
    reason: `same_signature_${consecutiveNow}_consecutive_failures`,
    failure_signature: signature,
  };
}

/**
 * Resolve + execute a contract via the allowlist. Thin wrapper so the
 * route layer can mock the dispatcher in tests.
 */
export async function runContractOnce(contract: ContractRow): Promise<TestContractRunResult> {
  const cmd = resolveCommand(contract.command_key);
  if (!cmd) {
    return {
      passed: false,
      status_code: null,
      content_type: null,
      body_excerpt: '',
      duration_ms: 0,
      ran_at: new Date().toISOString(),
      failure_reason: `command_key_not_allowlisted:${contract.command_key}`,
    };
  }
  if (cmd.dispatch !== 'sync_http') {
    // PR-L3 only schedules sync_http contracts. Async dispatch (Cloud
    // Run Job for jest/typecheck) lands in PR-L3.1.
    return {
      passed: false,
      status_code: null,
      content_type: null,
      body_excerpt: '',
      duration_ms: 0,
      ran_at: new Date().toISOString(),
      failure_reason: `dispatch_not_yet_scheduled:${cmd.dispatch}`,
    };
  }
  return await cmd.resolve(contract.expected_behavior);
}
