/**
 * Tests for Developer Autopilot Synthesis service — fingerprint + scoring
 * helpers, plus ingestScan's run-finalization contract (the fix for
 * dev_autopilot_runs getting stuck at status='ingesting' forever — see
 * CLAUDE.md CHANGE LOG under "dev_autopilot_runs never finalizes").
 */

process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' }),
}));
jest.mock('../src/services/dev-autopilot-planning', () => ({
  eagerlyPlanTopK: jest.fn().mockResolvedValue({ planned: 0, errors: 0 }),
}));

import {
  fingerprintSignal,
  scoreSignal,
  titleForSignal,
  domainForPath,
  TYPE_RISK_CLASS,
  DevAutopilotSignal,
  ingestScan,
  ScanInput,
} from '../src/services/dev-autopilot-synthesis';

const signal = (overrides: Partial<DevAutopilotSignal> = {}): DevAutopilotSignal => ({
  type: 'dead_code',
  severity: 'medium',
  file_path: 'services/gateway/src/routes/foo.ts',
  line_number: 42,
  message: 'Unused export `foo`',
  suggested_action: 'Remove export',
  scanner: 'knip',
  ...overrides,
});

describe('fingerprintSignal', () => {
  it('produces stable 16-char hex fingerprints', () => {
    const fp = fingerprintSignal(signal());
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });

  it('is stable for identical inputs', () => {
    expect(fingerprintSignal(signal())).toBe(fingerprintSignal(signal()));
  });

  it('changes when any keying field changes', () => {
    const base = fingerprintSignal(signal());
    expect(fingerprintSignal(signal({ type: 'todo' }))).not.toBe(base);
    expect(fingerprintSignal(signal({ file_path: 'other.ts' }))).not.toBe(base);
    expect(fingerprintSignal(signal({ line_number: 43 }))).not.toBe(base);
  });

  it('treats missing line_number as 0 consistently', () => {
    const a = fingerprintSignal(signal({ line_number: undefined }));
    const b = fingerprintSignal(signal({ line_number: 0 }));
    expect(a).toBe(b);
  });
});

describe('scoreSignal', () => {
  it('scales impact with severity', () => {
    expect(scoreSignal(signal({ severity: 'low' })).impact_score).toBeLessThan(
      scoreSignal(signal({ severity: 'medium' })).impact_score,
    );
    expect(scoreSignal(signal({ severity: 'medium' })).impact_score).toBeLessThan(
      scoreSignal(signal({ severity: 'high' })).impact_score,
    );
  });

  it('marks dead_code as low risk + auto-exec eligible', () => {
    const s = scoreSignal(signal({ type: 'dead_code' }));
    expect(s.risk_class).toBe('low');
    expect(s.auto_exec_eligible).toBe(true);
  });

  it('marks large_file as high risk + auto-exec ineligible', () => {
    const s = scoreSignal(signal({ type: 'large_file' }));
    expect(s.risk_class).toBe('high');
    expect(s.auto_exec_eligible).toBe(false);
  });

  it('marks medium-risk types ineligible for auto-exec (human review required)', () => {
    const s = scoreSignal(signal({ type: 'missing_tests' }));
    expect(s.risk_class).toBe('medium');
    expect(s.auto_exec_eligible).toBe(false);
  });

  it('marks low-risk but trivial-impact signals ineligible for auto-exec', () => {
    const s = scoreSignal(signal({ type: 'dead_code', severity: 'low' }));
    expect(s.risk_class).toBe('low');
    expect(s.auto_exec_eligible).toBe(false);
  });
});

describe('titleForSignal', () => {
  it('uses the basename of the file', () => {
    expect(titleForSignal(signal({ file_path: 'a/b/foo.ts' }))).toContain('foo.ts');
  });

  it('varies title by signal type', () => {
    const a = titleForSignal(signal({ type: 'dead_code' }));
    const b = titleForSignal(signal({ type: 'missing_tests' }));
    expect(a).not.toBe(b);
  });
});

describe('domainForPath', () => {
  it('buckets known prefixes', () => {
    expect(domainForPath('services/gateway/src/routes/auth.ts')).toBe('routes');
    expect(domainForPath('services/gateway/src/services/foo.ts')).toBe('services');
    expect(domainForPath('services/gateway/src/frontend/command-hub/app.js')).toBe('frontend');
    expect(domainForPath('services/agents/orb-agent/main.py')).toBe('agents');
    expect(domainForPath('supabase/migrations/x.sql')).toBe('database');
  });

  it('falls back to general', () => {
    expect(domainForPath('random/path.md')).toBe('general');
  });
});

describe('TYPE_RISK_CLASS invariant', () => {
  it('covers every SignalType with a risk_class', () => {
    const types: Array<keyof typeof TYPE_RISK_CLASS> = [
      'dead_code', 'unused_dep', 'missing_docs', 'todo', 'missing_tests',
      'circular_dep', 'duplication', 'cognitive_complexity', 'large_file',
    ];
    for (const t of types) {
      expect(TYPE_RISK_CLASS[t]).toMatch(/^(low|medium|high)$/);
    }
  });
});

// =============================================================================
// ingestScan — run finalization contract
//
// Root cause of "dev_autopilot_runs never finalizes" (observed live: run
// cf77d23c stuck at status='ingesting' forever): the finalize PATCH at the
// end of ingestScan fired without checking its result, and nothing wrapped
// the ingestion body — any thrown exception after the run row was created
// (step 1) skipped the finalize step entirely with no error recorded
// anywhere. These tests pin the fix: every exit path finalizes the row.
// =============================================================================

describe('ingestScan — run finalization', () => {
  const fetchMock = global.fetch as jest.Mock;

  beforeEach(() => {
    fetchMock.mockReset();
  });

  function jsonRes(status: number, body: unknown = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  type Handler = (url: string, opts: any) => any | undefined;

  function routeFetch(handler: Handler) {
    fetchMock.mockImplementation((url: any, opts: any = {}) => {
      const result = handler(String(url), opts);
      return Promise.resolve(result !== undefined ? result : jsonRes(200, []));
    });
  }

  it('finalizes the run row with status=done on success', async () => {
    const patchCalls: any[] = [];
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_runs') && method === 'POST') return jsonRes(201, {});
      if (url.includes('/dev_autopilot_runs') && method === 'PATCH') {
        patchCalls.push(JSON.parse(opts.body));
        return jsonRes(204, {});
      }
      if (url.includes('/dev_autopilot_signals')) return jsonRes(201, {});
      if (url.includes('/autopilot_recommendations') && method === 'GET') return jsonRes(200, []);
      if (url.includes('/autopilot_recommendations') && method === 'POST') return jsonRes(201, {});
      return undefined;
    });

    const result = await ingestScan({ triggered_by: 'test', signals: [signal()] });

    expect(result.ok).toBe(true);
    expect(result.new_finding_count).toBe(1);
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].status).toBe('done');
    expect(patchCalls[0].new_finding_count).toBe(1);
    expect(patchCalls[0].completed_at).toBeDefined();
  });

  it('finalizes the run row with status=failed (not stuck at ingesting) when ingestion throws after the run row is created', async () => {
    const patchCalls: any[] = [];
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_runs') && method === 'POST') return jsonRes(201, {});
      if (url.includes('/dev_autopilot_runs') && method === 'PATCH') {
        patchCalls.push(JSON.parse(opts.body));
        return jsonRes(204, {});
      }
      return undefined;
    });

    // A circular `raw` object makes JSON.stringify throw synchronously while
    // building the dev_autopilot_signals insert body — the exact "unexpected
    // exception mid-ingestion" shape the wrapping try/catch exists to catch.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const badSignal = signal({ raw: circular });

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await ingestScan({ triggered_by: 'test', signals: [badSignal] });
    errSpy.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.run_id).toBeTruthy();
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].status).toBe('failed');
    expect(patchCalls[0].completed_at).toBeDefined();
    expect(typeof patchCalls[0].error).toBe('string');
    expect(patchCalls[0].error.length).toBeGreaterThan(0);
  });

  it('still reports ok:true when only the finalize PATCH itself fails (findings were already written)', async () => {
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_runs') && method === 'POST') return jsonRes(201, {});
      if (url.includes('/dev_autopilot_runs') && method === 'PATCH') return jsonRes(500, { message: 'db unavailable' });
      if (url.includes('/dev_autopilot_signals')) return jsonRes(201, {});
      if (url.includes('/autopilot_recommendations') && method === 'GET') return jsonRes(200, []);
      if (url.includes('/autopilot_recommendations') && method === 'POST') return jsonRes(201, {});
      return undefined;
    });

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await ingestScan({ triggered_by: 'test', signals: [signal()] });

    // The findings themselves were successfully written; only the run row's
    // own bookkeeping PATCH failed, and that failure is logged, not silenced.
    // (Asserted before mockRestore() — restoring clears the spy's call history.)
    expect(result.ok).toBe(true);
    expect(result.new_finding_count).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('returns ok:false without attempting any writes when the initial run-row insert fails', async () => {
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_runs') && method === 'POST') return jsonRes(500, { message: 'insert failed' });
      return undefined;
    });

    const result = await ingestScan({ triggered_by: 'test', signals: [signal()] });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('run insert failed');
    // No finalize PATCH should have been attempted — there is no row to finalize.
    const patchCalls = fetchMock.mock.calls.filter(([, opts]) => (opts?.method) === 'PATCH');
    expect(patchCalls).toHaveLength(0);
  });
});

describe('ingestScan — dedup lookup covers activated findings (VTID-04274)', () => {
  // Live evidence: autopilot_recommendations rows 9e1bdb97 (status=activated,
  // VTID-04250) and 7a93bca4 (status=new, VTID-04261) share the identical
  // signal_fingerprint 42c32f9e7e689576 — the SAME npm-audit signal spawned a
  // second, fully duplicate finding + VTID + execution because the dedup
  // lookup filtered status=in.(new,snoozed), excluding 'activated'. A finding
  // that already has a VTID and an in-flight execution is still the same
  // live problem, not a resolved one.
  const fetchMock = global.fetch as jest.Mock;

  beforeEach(() => {
    fetchMock.mockReset();
  });

  function jsonRes(status: number, body: unknown = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  type Handler = (url: string, opts: any) => any | undefined;

  function routeFetch(handler: Handler) {
    fetchMock.mockImplementation((url: any, opts: any = {}) => {
      const result = handler(String(url), opts);
      return Promise.resolve(result !== undefined ? result : jsonRes(200, []));
    });
  }

  it('the dedup GET query includes activated alongside new/snoozed', async () => {
    const getUrls: string[] = [];
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_runs') && method === 'POST') return jsonRes(201, {});
      if (url.includes('/dev_autopilot_runs') && method === 'PATCH') return jsonRes(204, {});
      if (url.includes('/dev_autopilot_signals')) return jsonRes(201, {});
      if (url.includes('/autopilot_recommendations') && method === 'GET') {
        getUrls.push(url);
        return jsonRes(200, []);
      }
      if (url.includes('/autopilot_recommendations') && method === 'POST') return jsonRes(201, {});
      return undefined;
    });

    await ingestScan({ triggered_by: 'test', signals: [signal()] });

    // VTID-04666 added one per-run GET for recently rejected fingerprints
    // (status=eq.rejected); this test is about the per-signal dedup lookup.
    const dedupUrls = getUrls.filter((u) => u.includes('signal_fingerprint=eq.'));
    expect(getUrls.filter((u) => u.includes('status=eq.rejected'))).toHaveLength(1);
    expect(dedupUrls).toHaveLength(1);
    getUrls.splice(0, getUrls.length, ...dedupUrls);
    expect(getUrls[0]).toContain('status=in.(new,snoozed,activated)');
    expect(getUrls[0]).not.toContain('status=in.(new,snoozed)&');
  });

  it('bumps seen_count on an existing ACTIVATED finding instead of inserting a duplicate', async () => {
    const patchBodies: any[] = [];
    let postCount = 0;
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_runs') && method === 'POST') return jsonRes(201, {});
      if (url.includes('/dev_autopilot_runs') && method === 'PATCH') return jsonRes(204, {});
      if (url.includes('/dev_autopilot_signals')) return jsonRes(201, {});
      if (url.includes('/autopilot_recommendations') && method === 'GET') {
        // Simulate the live-bug scenario: the existing row is 'activated',
        // not 'new'/'snoozed'.
        return jsonRes(200, [{ id: 'existing-activated-id', seen_count: 3, last_seen_at: '2026-09-21T00:00:00Z', status: 'activated' }]);
      }
      if (url.includes('/autopilot_recommendations') && method === 'POST') {
        postCount++;
        return jsonRes(201, {});
      }
      if (url.includes('/autopilot_recommendations') && method === 'PATCH') {
        patchBodies.push(JSON.parse(opts.body));
        return jsonRes(204, {});
      }
      return undefined;
    });

    const result = await ingestScan({ triggered_by: 'test', signals: [signal()] });

    expect(result.ok).toBe(true);
    // The whole point: no new finding/VTID is created for an already-live one.
    expect(postCount).toBe(0);
    expect(result.new_finding_count).toBe(0);
    expect(patchBodies).toHaveLength(1);
    expect(patchBodies[0].seen_count).toBe(4);
  });

  it('still inserts a new finding when no live (new/snoozed/activated) match exists', async () => {
    let postCount = 0;
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_runs') && method === 'POST') return jsonRes(201, {});
      if (url.includes('/dev_autopilot_runs') && method === 'PATCH') return jsonRes(204, {});
      if (url.includes('/dev_autopilot_signals')) return jsonRes(201, {});
      if (url.includes('/autopilot_recommendations') && method === 'GET') return jsonRes(200, []);
      if (url.includes('/autopilot_recommendations') && method === 'POST') {
        postCount++;
        return jsonRes(201, {});
      }
      return undefined;
    });

    const result = await ingestScan({ triggered_by: 'test', signals: [signal()] });

    expect(result.ok).toBe(true);
    expect(postCount).toBe(1);
    expect(result.new_finding_count).toBe(1);
  });
});

// =============================================================================
// System-wide rollup — safety_gap exemption (VTID-04277)
//
// Live evidence: autopilot_recommendations rows b0aa6815 (snoozed) and
// e89e7537 (activated -> VTID-02012) are both a "[rollup] safety-gap-scanner-v1
// flagged 8 files with the same fix class" finding. safety-gap-scanner-v1
// (scripts/ci/dev-autopilot-scan.mjs scanSafetyGaps()) emits from a small,
// fixed catalog of ~10 hand-authored, UNRELATED gaps (a new RLS-write-deny
// test suite, an admin auth-coverage test, a schema-vs-migrations validator,
// ...) that happen to share (scanner, type='safety_gap', severity='medium')
// — the exact key the generic rollup groups on — so >=ROLLUP_THRESHOLD
// unaddressed gaps collapsed into one finding claiming a shared "fix class"
// that does not exist, with directory paths (services/gateway/src/routes/admin)
// listed as if they were files. safety_gap must always pass through
// individually; every other type's collapse behaviour is unchanged.
// =============================================================================

describe('ingestScan — safety_gap rollup exemption (VTID-04277)', () => {
  const fetchMock = global.fetch as jest.Mock;

  beforeEach(() => {
    fetchMock.mockReset();
  });

  function jsonRes(status: number, body: unknown = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  type Handler = (url: string, opts: any) => any | undefined;

  function routeFetch(handler: Handler) {
    fetchMock.mockImplementation((url: any, opts: any = {}) => {
      const result = handler(String(url), opts);
      return Promise.resolve(result !== undefined ? result : jsonRes(200, []));
    });
  }

  const safetyGapSignal = (key: string, filePath: string): DevAutopilotSignal => ({
    type: 'safety_gap',
    severity: 'medium',
    file_path: filePath,
    line_number: 1,
    message: `${key} test missing`,
    suggested_action: `Add the ${key} test. Distinct scope per gap, not a mechanical per-file fix.`,
    scanner: 'safety-gap-scanner-v1',
  });

  it('never collapses safety_gap signals into a rollup, even at/above ROLLUP_THRESHOLD', async () => {
    const postBodies: any[] = [];
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_runs') && method === 'POST') return jsonRes(201, {});
      if (url.includes('/dev_autopilot_runs') && method === 'PATCH') return jsonRes(204, {});
      if (url.includes('/dev_autopilot_signals')) return jsonRes(201, {});
      if (url.includes('/autopilot_recommendations') && method === 'GET') return jsonRes(200, []);
      if (url.includes('/autopilot_recommendations') && method === 'POST') {
        postBodies.push(JSON.parse(opts.body));
        return jsonRes(201, {});
      }
      return undefined;
    });

    // The scanner's real catalog: 8 of its ~10 hardcoded gaps, each a
    // distinct source_file (some directory-scoped, some file-scoped) and a
    // distinct suggested_action — the exact live shape.
    const signals: DevAutopilotSignal[] = [
      safetyGapSignal('approvals-integration', 'services/gateway/src/routes/approvals.ts'),
      safetyGapSignal('autopilot-integration', 'services/gateway/src/routes/autopilot.ts'),
      safetyGapSignal('route-guard', 'services/gateway/src/index.ts'),
      safetyGapSignal('admin-auth-coverage', 'services/gateway/src/routes/admin'),
      safetyGapSignal('schema-vs-migrations', 'services/gateway/src'),
      safetyGapSignal('rls-write-guard', 'supabase/migrations'),
      safetyGapSignal('oasis-event-emission', 'services/gateway/src/routes'),
      safetyGapSignal('e2e-playwright-autopilot', 'e2e/command-hub/roles/developer'),
    ];

    const result = await ingestScan({ triggered_by: 'test', signals });

    expect(result.ok).toBe(true);
    // 8 in, 8 individual findings out — never one "[rollup]" finding.
    expect(result.new_finding_count).toBe(8);
    expect(postBodies).toHaveLength(8);
    for (const body of postBodies) {
      expect(body.summary).not.toMatch(/^\[rollup\]/);
      expect(body.summary).not.toContain('same fix class');
      expect(body.spec_snapshot?.rollup).toBeUndefined();
    }
    // Each gap's own distinct message survives — nothing was merged.
    const messages = postBodies.map(b => b.summary).sort();
    expect(messages).toEqual([
      'admin-auth-coverage test missing',
      'approvals-integration test missing',
      'autopilot-integration test missing',
      'e2e-playwright-autopilot test missing',
      'oasis-event-emission test missing',
      'rls-write-guard test missing',
      'route-guard test missing',
      'schema-vs-migrations test missing',
    ]);
  });

  it('still collapses a non-exempt type (dead_code) at/above ROLLUP_THRESHOLD — the exemption is scoped to safety_gap only', async () => {
    const postBodies: any[] = [];
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_runs') && method === 'POST') return jsonRes(201, {});
      if (url.includes('/dev_autopilot_runs') && method === 'PATCH') return jsonRes(204, {});
      if (url.includes('/dev_autopilot_signals')) return jsonRes(201, {});
      if (url.includes('/autopilot_recommendations') && method === 'GET') return jsonRes(200, []);
      if (url.includes('/autopilot_recommendations') && method === 'POST') {
        postBodies.push(JSON.parse(opts.body));
        return jsonRes(201, {});
      }
      return undefined;
    });

    const signals: DevAutopilotSignal[] = Array.from({ length: 6 }, (_, i) =>
      signal({ type: 'dead_code', file_path: `services/gateway/src/routes/file${i}.ts`, scanner: 'knip' }),
    );

    const result = await ingestScan({ triggered_by: 'test', signals });

    expect(result.ok).toBe(true);
    expect(result.new_finding_count).toBe(1);
    expect(postBodies).toHaveLength(1);
    expect(postBodies[0].summary).toMatch(/^\[rollup\] knip flagged 6 files/);
    expect(postBodies[0].spec_snapshot.rollup).toBe(true);
    expect(postBodies[0].spec_snapshot.total_files).toBe(6);
  });

  it('a small safety_gap cluster (below threshold) already passed through unchanged before this fix — still does', async () => {
    const postBodies: any[] = [];
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_runs') && method === 'POST') return jsonRes(201, {});
      if (url.includes('/dev_autopilot_runs') && method === 'PATCH') return jsonRes(204, {});
      if (url.includes('/dev_autopilot_signals')) return jsonRes(201, {});
      if (url.includes('/autopilot_recommendations') && method === 'GET') return jsonRes(200, []);
      if (url.includes('/autopilot_recommendations') && method === 'POST') {
        postBodies.push(JSON.parse(opts.body));
        return jsonRes(201, {});
      }
      return undefined;
    });

    const signals: DevAutopilotSignal[] = [
      safetyGapSignal('governance-gates', 'services/gateway/src/services'),
      safetyGapSignal('deploy-smoke', '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'),
    ];

    const result = await ingestScan({ triggered_by: 'test', signals });

    expect(result.ok).toBe(true);
    expect(result.new_finding_count).toBe(2);
    expect(postBodies).toHaveLength(2);
  });
});
