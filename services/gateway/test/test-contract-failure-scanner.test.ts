/**
 * VTID-02958 (PR-L3): Unit tests for the failure scanner pure state machine.
 *
 * The networked scheduled-run is tested via the route layer separately;
 * these tests cover only the pure decision logic so a regression in
 * debounce, quarantine, or idempotency is caught locally without DB.
 */

import {
  decideScannerOutcome,
  computeFailureSignature,
  consecutiveSameSignatureFailures,
  repairAttemptsLast24h,
  hasInFlightRepairAttempt,
  type ContractRow,
  type RecentRunRow,
} from '../src/services/test-contract-failure-scanner';

const NOW = Date.now();
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

function contract(overrides: Partial<ContractRow> = {}): ContractRow {
  return {
    id: 'c-uuid-1',
    capability: 'gateway_alive',
    service: 'gateway',
    environment: 'dev',
    command_key: 'gateway.alive',
    target_endpoint: '/alive',
    target_file: 'services/gateway/src/index.ts',
    expected_behavior: { status: 200 },
    status: 'pass',
    last_status: 'pass',
    last_failure_signature: null,
    last_passing_sha: null,
    repairable: true,
    ...overrides,
  };
}

function run(overrides: Partial<RecentRunRow> = {}): RecentRunRow {
  return {
    id: 'r-' + Math.random().toString(36).slice(2),
    passed: false,
    failure_signature: 'gateway.alive:status_mismatch: got 500, expected 200',
    dispatched_at: minsAgo(1),
    repair_vtid: null,
    ...overrides,
  };
}

const RESULT_PASS = {
  passed: true,
  status_code: 200,
  content_type: 'application/json',
  body_excerpt: '{"status":"ok"}',
  duration_ms: 42,
  ran_at: minsAgo(0),
};

const RESULT_FAIL = {
  passed: false,
  status_code: 500,
  content_type: 'application/json',
  body_excerpt: '{"error":"boom"}',
  duration_ms: 42,
  ran_at: minsAgo(0),
  failure_reason: 'status_mismatch: got 500, expected 200',
};

// =============================================================================
// computeFailureSignature
// =============================================================================

describe('computeFailureSignature', () => {
  it('combines command_key + first error line for stable cross-run identity', () => {
    expect(computeFailureSignature('gateway.alive', 'status_mismatch: got 500, expected 200'))
      .toBe('gateway.alive:status_mismatch: got 500, expected 200');
  });

  it('takes only the FIRST line so body excerpts that vary run-to-run do not change the signature', () => {
    const a = computeFailureSignature('gateway.alive', 'connect ETIMEDOUT\nat fetch line 42');
    const b = computeFailureSignature('gateway.alive', 'connect ETIMEDOUT\nat fetch line 47');
    expect(a).toBe(b);
  });

  it('falls back to a stable placeholder when failure_reason is null', () => {
    expect(computeFailureSignature('gateway.alive', null)).toBe('gateway.alive:unknown_failure');
  });

  it('caps first line at 200 chars to keep signatures bounded', () => {
    const longLine = 'x'.repeat(500);
    const sig = computeFailureSignature('gateway.alive', longLine);
    expect(sig.length).toBeLessThan(220);
  });
});

// =============================================================================
// consecutiveSameSignatureFailures
// =============================================================================

describe('consecutiveSameSignatureFailures', () => {
  const sig = 'gateway.alive:status_mismatch: got 500, expected 200';

  it('counts streak of same-signature failures from the most recent run backwards', () => {
    const recent = [run({ failure_signature: sig }), run({ failure_signature: sig })];
    expect(consecutiveSameSignatureFailures(recent, sig)).toBe(2);
  });

  it('stops at the first passing run', () => {
    const recent = [
      run({ failure_signature: sig }),
      run({ passed: true, failure_signature: null }),
      run({ failure_signature: sig }),
    ];
    expect(consecutiveSameSignatureFailures(recent, sig)).toBe(1);
  });

  it('stops at a different failure signature', () => {
    const recent = [
      run({ failure_signature: sig }),
      run({ failure_signature: 'gateway.alive:different_error' }),
    ];
    expect(consecutiveSameSignatureFailures(recent, sig)).toBe(1);
  });

  it('returns 0 for an empty history', () => {
    expect(consecutiveSameSignatureFailures([], sig)).toBe(0);
  });
});

// =============================================================================
// repairAttemptsLast24h
// =============================================================================

describe('repairAttemptsLast24h', () => {
  it('counts distinct repair_vtid values within the 24h window', () => {
    const recent = [
      run({ repair_vtid: 'VTID-1', dispatched_at: hoursAgo(1) }),
      run({ repair_vtid: 'VTID-2', dispatched_at: hoursAgo(5) }),
      run({ repair_vtid: 'VTID-3', dispatched_at: hoursAgo(12) }),
    ];
    expect(repairAttemptsLast24h(recent, NOW)).toBe(3);
  });

  it('deduplicates the same repair_vtid across multiple runs (one VTID = one attempt)', () => {
    const recent = [
      run({ repair_vtid: 'VTID-1', dispatched_at: hoursAgo(1) }),
      run({ repair_vtid: 'VTID-1', dispatched_at: hoursAgo(2) }),
      run({ repair_vtid: 'VTID-1', dispatched_at: hoursAgo(3) }),
    ];
    expect(repairAttemptsLast24h(recent, NOW)).toBe(1);
  });

  it('excludes attempts older than 24h', () => {
    const recent = [
      run({ repair_vtid: 'VTID-1', dispatched_at: hoursAgo(1) }),
      run({ repair_vtid: 'VTID-OLD', dispatched_at: hoursAgo(25) }),
    ];
    expect(repairAttemptsLast24h(recent, NOW)).toBe(1);
  });

  it('returns 0 when no rows have a repair_vtid', () => {
    expect(repairAttemptsLast24h([run(), run()], NOW)).toBe(0);
  });
});

// =============================================================================
// hasInFlightRepairAttempt
// =============================================================================

describe('hasInFlightRepairAttempt', () => {
  const sig = 'gateway.alive:status_mismatch: got 500, expected 200';

  it('returns the VTID when a recent run shows a repair attempt for the SAME signature', () => {
    const recent = [run({ failure_signature: sig, repair_vtid: 'VTID-7', dispatched_at: hoursAgo(2) })];
    expect(hasInFlightRepairAttempt(recent, sig, NOW)).toBe('VTID-7');
  });

  it('returns null when the only recent repair is for a DIFFERENT signature', () => {
    const recent = [
      run({ failure_signature: 'gateway.alive:other_error', repair_vtid: 'VTID-7', dispatched_at: hoursAgo(2) }),
    ];
    expect(hasInFlightRepairAttempt(recent, sig, NOW)).toBeNull();
  });

  it('returns null when the matching repair is older than 24h', () => {
    const recent = [
      run({ failure_signature: sig, repair_vtid: 'VTID-OLD', dispatched_at: hoursAgo(30) }),
    ];
    expect(hasInFlightRepairAttempt(recent, sig, NOW)).toBeNull();
  });
});

// =============================================================================
// decideScannerOutcome — the integrated state machine.
// =============================================================================

describe('decideScannerOutcome', () => {
  const sig = 'gateway.alive:status_mismatch: got 500, expected 200';

  it('PASS → new_status=pass, no repair, no quarantine', () => {
    const d = decideScannerOutcome(RESULT_PASS, contract(), [], NOW);
    expect(d.new_status).toBe('pass');
    expect(d.should_allocate_repair).toBe(false);
    expect(d.should_quarantine).toBe(false);
    expect(d.failure_signature).toBeNull();
    expect(d.reason).toBe('run_passed');
  });

  it('1st FAIL of a new signature → fail, but NO repair yet (debounce against flake)', () => {
    const d = decideScannerOutcome(RESULT_FAIL, contract(), [], NOW);
    expect(d.new_status).toBe('fail');
    expect(d.should_allocate_repair).toBe(false);
    expect(d.failure_signature).toBe(sig);
    expect(d.reason).toBe('first_failure_of_signature_debouncing');
  });

  it('2nd consecutive same-signature FAIL → fail + ALLOCATE repair VTID', () => {
    const recent = [run({ failure_signature: sig })]; // prior failure
    const d = decideScannerOutcome(RESULT_FAIL, contract(), recent, NOW);
    expect(d.new_status).toBe('fail');
    expect(d.should_allocate_repair).toBe(true);
    expect(d.reason).toContain('same_signature_2');
  });

  it('idempotency: a repair VTID already in flight for this signature → fail but NO new allocation', () => {
    const recent = [
      run({ failure_signature: sig, repair_vtid: 'VTID-7', dispatched_at: hoursAgo(2) }),
      run({ failure_signature: sig }),
    ];
    const d = decideScannerOutcome(RESULT_FAIL, contract(), recent, NOW);
    expect(d.should_allocate_repair).toBe(false);
    expect(d.reason).toContain('repair_already_in_flight_VTID-7');
  });

  it('quarantine: 3 distinct repair VTIDs in 24h → 4th failure would be repair-eligible but gets QUARANTINED instead', () => {
    const recent = [
      run({ failure_signature: sig, repair_vtid: 'VTID-1', dispatched_at: hoursAgo(1) }),
      run({ failure_signature: sig, repair_vtid: 'VTID-2', dispatched_at: hoursAgo(5) }),
      run({ failure_signature: sig, repair_vtid: 'VTID-3', dispatched_at: hoursAgo(12) }),
      run({ failure_signature: sig }), // makes consecutive=2 so we'd want a repair
    ];
    const d = decideScannerOutcome(RESULT_FAIL, contract(), recent, NOW);
    expect(d.new_status).toBe('quarantined');
    expect(d.should_quarantine).toBe(true);
    expect(d.should_allocate_repair).toBe(false);
    expect(d.reason).toContain('quarantine_repair_attempts_exceeded');
  });

  it('already-quarantined contract → stays quarantined, no repair, no flip', () => {
    const d = decideScannerOutcome(RESULT_FAIL, contract({ status: 'quarantined' }), [run({ failure_signature: sig })], NOW);
    expect(d.new_status).toBe('quarantined');
    expect(d.should_allocate_repair).toBe(false);
    expect(d.should_quarantine).toBe(false); // already there — not RE-quarantining
    expect(d.reason).toBe('contract_quarantined');
  });

  it('non-repairable contract → fail, but never allocates a repair (e.g. safety-critical surfaces)', () => {
    const recent = [run({ failure_signature: sig })];
    const d = decideScannerOutcome(RESULT_FAIL, contract({ repairable: false }), recent, NOW);
    expect(d.new_status).toBe('fail');
    expect(d.should_allocate_repair).toBe(false);
    expect(d.reason).toBe('contract_marked_non_repairable');
  });

  it('different failure_signature breaks the streak — first occurrence debounces again', () => {
    // Prior failure was for a DIFFERENT signature; this run's failure
    // signature is fresh, so it counts as the 1st of a new streak.
    const recent = [run({ failure_signature: 'gateway.alive:other_error' })];
    const d = decideScannerOutcome(RESULT_FAIL, contract(), recent, NOW);
    expect(d.should_allocate_repair).toBe(false);
    expect(d.reason).toBe('first_failure_of_signature_debouncing');
  });

  it('PASS clears the streak — next fail debounces again from zero', () => {
    const recent = [
      run({ passed: true, failure_signature: null, dispatched_at: minsAgo(5) }),
      run({ failure_signature: sig, dispatched_at: minsAgo(10) }),
      run({ failure_signature: sig, dispatched_at: minsAgo(15) }),
    ];
    const d = decideScannerOutcome(RESULT_FAIL, contract(), recent, NOW);
    expect(d.should_allocate_repair).toBe(false);
    expect(d.reason).toBe('first_failure_of_signature_debouncing');
  });
});
