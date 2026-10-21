/**
 * VTID-04428 — a merged change the bridge reverted on main no longer blocks
 * its own self-heal retry. VTID-04429 — the ledger close retries once.
 *
 * Before: a deploy/verification failure opened and merged a revert PR, the
 * row went `reverted` with its original pr_url, and STRANDED_PR_FILTER then
 * refused the self-heal child ("already has an unmerged PR") — the change was
 * no longer on main, but the guard could not tell.
 */
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  isRevertMergedOnMain,
  PR_REVERTED_KEY,
  STRANDED_PR_FILTER,
} from '../src/services/dev-autopilot-pipeline-guards';
import { applyExecTerminalSideEffects } from '../src/services/dev-autopilot-execute';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('VTID-04428 isRevertMergedOnMain', () => {
  const merged = { ok: true, revert_pr_url: 'https://github.com/x/y/pull/9', reverted_on_main: true };
  it('is true only for a post-merge stage whose revert merged', () => {
    expect(isRevertMergedOnMain('deploy', merged)).toBe(true);
    expect(isRevertMergedOnMain('verification', merged)).toBe(true);
  });
  it('is false for the ci stage (a closed PR, not a revert)', () => {
    expect(isRevertMergedOnMain('ci', merged)).toBe(false);
  });
  it('is false when the revert PR is open but did not merge', () => {
    expect(isRevertMergedOnMain('deploy', {
      ok: true, revert_pr_url: merged.revert_pr_url, error: 'revert PR open but auto-merge failed: x',
    })).toBe(false);
  });
  it('is false for a dry-run stub, a failed revert, or a missing flag', () => {
    expect(isRevertMergedOnMain('deploy', { ok: true, revert_pr_url: 'https://github.com/x/y/pull/REVERT-abc' })).toBe(false);
    expect(isRevertMergedOnMain('deploy', { ok: false, error: 'no merge_sha' })).toBe(false);
    expect(isRevertMergedOnMain('deploy', { ok: true })).toBe(false);
  });
});

describe('VTID-04428 STRANDED_PR_FILTER', () => {
  it('excludes rows stamped reverted-on-main, keeping the earlier clauses', () => {
    expect(PR_REVERTED_KEY).toBe('pr_reverted_at');
    expect(STRANDED_PR_FILTER).toContain('&metadata->>pr_reverted_at=is.null');
    expect(STRANDED_PR_FILTER).toContain('&metadata->>pr_closed_unmerged_at=is.null');
    expect(STRANDED_PR_FILTER).toContain('&pr_url=not.is.null');
  });
});

describe('VTID-04428 bridge wiring (source contract)', () => {
  const bridge = read('src/services/dev-autopilot-bridge.ts');
  it('revertExecutionPR reports reverted_on_main only on the merged-revert path', () => {
    expect(bridge.match(/reverted_on_main: true/g)?.length).toBe(1);
    expect(bridge).toContain("return { ok: true, revert_pr_url: revertPr.html_url, reverted_on_main: true };");
  });
  it('the bridge stamps pr_reverted_at through the pure predicate', () => {
    expect(bridge).toContain('isRevertMergedOnMain(input.failure_stage, revert)');
    expect(bridge).toContain('[PR_REVERTED_KEY]: new Date().toISOString()');
  });
});

describe('VTID-04429 ledger close retries once', () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let ledgerPatchFailures = 0;
  beforeEach(() => {
    calls.length = 0;
    process.env.SUPABASE_URL = 'https://supa.test';
    process.env.SUPABASE_SERVICE_ROLE = 'svc';
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      let body: unknown = [];
      let ok = true;
      if (url.includes('/dev_autopilot_executions?id=eq.')) body = [{ finding_id: 'f1', pr_url: null, pr_number: null }];
      else if (url.includes('/autopilot_recommendations?id=eq.f1')) body = [{ activated_vtid: 'VTID-09999' }];
      else if (url.includes('/vtid_ledger') && init?.method === 'PATCH' && ledgerPatchFailures > 0) {
        ledgerPatchFailures--;
        ok = false;
      }
      return {
        ok, status: ok ? 200 : 503,
        json: async () => body,
        text: async () => (ok ? JSON.stringify(body) : 'upstream blip'),
        headers: { get: () => null },
      } as unknown as Response;
    });
  });
  const ledgerPatches = () => calls.filter((c) => c.url.includes('/vtid_ledger') && c.init?.method === 'PATCH');
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('a transient failure is retried and the second write lands', async () => {
    ledgerPatchFailures = 1;
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    applyExecTerminalSideEffects({ url: 'https://supa.test', key: 'svc' } as never, 'exec-0001', 'cancelled');
    await settle();
    expect(ledgerPatches()).toHaveLength(2);
    expect(err.mock.calls.some((c) => String(c[0]).includes('terminalize FAILED'))).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('terminalize retry'))).toBe(true);
    err.mockRestore(); warn.mockRestore();
  });

  it('two failures stop at two attempts and log the error', async () => {
    ledgerPatchFailures = 2;
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    applyExecTerminalSideEffects({ url: 'https://supa.test', key: 'svc' } as never, 'exec-0002', 'cancelled');
    await settle();
    expect(ledgerPatches()).toHaveLength(2);
    expect(err.mock.calls.some((c) => String(c[0]).includes('terminalize FAILED'))).toBe(true);
    err.mockRestore(); warn.mockRestore();
  });

  it('a first-try success writes once', async () => {
    ledgerPatchFailures = 0;
    applyExecTerminalSideEffects({ url: 'https://supa.test', key: 'svc' } as never, 'exec-0003', 'cancelled');
    await settle();
    expect(ledgerPatches()).toHaveLength(1);
  });
});
