/**
 * VTID-02954 (PR-L1): Test Contract Command Allowlist.
 *
 * The `test_contracts.command_key` column is a string key, NOT a shell
 * command. This file is the SINGLE place that maps keys to typed
 * dispatchers. No exec(), no spawn(), no user-controllable args. Adding
 * a new testable surface = adding an entry here in a code-reviewed PR.
 *
 * PR-L1 ships only `sync_http` dispatchers — they're cheap, fast, and
 * safe to run inline in a gateway request handler.
 * PR-L3 will add `cloud_run_job` and `workflow_dispatch` dispatchers
 * for jest/typecheck contracts (long-running; need async execution).
 */

import { contractGatewayBaseUrl } from './test-contract-config';

export type TestContractDispatchKind = 'sync_http' | 'cloud_run_job' | 'workflow_dispatch';

export interface TestContractRunResult {
  passed: boolean;
  status_code: number | null;
  content_type: string | null;
  body_excerpt: string;
  duration_ms: number;
  ran_at: string;
  failure_reason?: string;
}

export interface AllowlistedCommand {
  command_key: string;
  contract_type: 'jest' | 'typecheck' | 'live_probe' | 'workflow_check';
  dispatch: TestContractDispatchKind;
  // Typed resolver. Receives the contract's `expected_behavior` JSONB
  // so the resolver can validate against the contract's own asserts
  // instead of hard-coding them in the allowlist.
  resolve: (expected: unknown) => Promise<TestContractRunResult>;
}

// =============================================================================
// Sync HTTP probe helper
// =============================================================================

interface ExpectedHttp {
  status?: number | number[];
  content_type_prefix?: string;
  json_must_contain?: Record<string, unknown>;
}

function isExpectedHttp(v: unknown): v is ExpectedHttp {
  return typeof v === 'object' && v !== null;
}

function statusMatches(actual: number, expected: number | number[] | undefined): boolean {
  if (expected === undefined) return actual >= 200 && actual < 500;
  if (Array.isArray(expected)) return expected.includes(actual);
  return actual === expected;
}

function jsonContains(haystack: unknown, needle: Record<string, unknown>): boolean {
  if (typeof haystack !== 'object' || haystack === null) return false;
  const obj = haystack as Record<string, unknown>;
  for (const [k, expected] of Object.entries(needle)) {
    if (obj[k] !== expected) return false;
  }
  return true;
}

async function probeHttp(
  method: 'GET' | 'POST',
  path: string,
  expected: ExpectedHttp,
  body?: Record<string, unknown>,
): Promise<TestContractRunResult> {
  const url = `${contractGatewayBaseUrl()}${path}`;
  const t0 = Date.now();
  const ran_at = new Date().toISOString();
  try {
    const resp = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(7_000),
    });
    const status_code = resp.status;
    const content_type = resp.headers.get('content-type');
    const text = await resp.text();
    const body_excerpt = text.slice(0, 500);

    if (!statusMatches(status_code, expected.status)) {
      return {
        passed: false,
        status_code,
        content_type,
        body_excerpt,
        duration_ms: Date.now() - t0,
        ran_at,
        failure_reason: `status_mismatch: got ${status_code}, expected ${JSON.stringify(expected.status)}`,
      };
    }
    if (expected.content_type_prefix && !(content_type || '').startsWith(expected.content_type_prefix)) {
      return {
        passed: false,
        status_code,
        content_type,
        body_excerpt,
        duration_ms: Date.now() - t0,
        ran_at,
        failure_reason: `content_type_mismatch: got "${content_type}", expected prefix "${expected.content_type_prefix}"`,
      };
    }
    if (expected.json_must_contain) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          passed: false,
          status_code,
          content_type,
          body_excerpt,
          duration_ms: Date.now() - t0,
          ran_at,
          failure_reason: 'json_parse_failed',
        };
      }
      if (!jsonContains(parsed, expected.json_must_contain)) {
        return {
          passed: false,
          status_code,
          content_type,
          body_excerpt,
          duration_ms: Date.now() - t0,
          ran_at,
          failure_reason: `json_must_contain_mismatch: did not find ${JSON.stringify(expected.json_must_contain)}`,
        };
      }
    }
    return {
      passed: true,
      status_code,
      content_type,
      body_excerpt,
      duration_ms: Date.now() - t0,
      ran_at,
    };
  } catch (err) {
    return {
      passed: false,
      status_code: null,
      content_type: null,
      body_excerpt: '',
      duration_ms: Date.now() - t0,
      ran_at,
      failure_reason: `fetch_failed: ${(err as Error).message}`,
    };
  }
}

// =============================================================================
// Allowlist
// =============================================================================

export const COMMAND_ALLOWLIST: Record<string, AllowlistedCommand> = {
  'gateway.alive': {
    command_key: 'gateway.alive',
    contract_type: 'live_probe',
    dispatch: 'sync_http',
    resolve: (expected) => probeHttp('GET', '/alive', isExpectedHttp(expected) ? expected : {}),
  },
  'canary_target.disarmed_health': {
    command_key: 'canary_target.disarmed_health',
    contract_type: 'live_probe',
    dispatch: 'sync_http',
    resolve: (expected) =>
      probeHttp('GET', '/api/v1/canary-target/health', isExpectedHttp(expected) ? expected : {}),
  },
  'canary_target.status': {
    command_key: 'canary_target.status',
    contract_type: 'live_probe',
    dispatch: 'sync_http',
    resolve: (expected) =>
      probeHttp('GET', '/api/v1/canary-target/status', isExpectedHttp(expected) ? expected : {}),
  },
  'self_healing.active_route_mounted': {
    command_key: 'self_healing.active_route_mounted',
    contract_type: 'live_probe',
    dispatch: 'sync_http',
    resolve: (expected) =>
      probeHttp('GET', '/api/v1/self-healing/active', isExpectedHttp(expected) ? expected : {}),
  },
  'oasis.vtid_terminalize_validates_payload': {
    command_key: 'oasis.vtid_terminalize_validates_payload',
    contract_type: 'live_probe',
    dispatch: 'sync_http',
    // Probes with an intentionally-malformed VTID. The gate MUST reject
    // with 400 (zod validation) or 404 (VTID not found). If it returns
    // 200, the gate is broken — exact failure mode that hit us before PR-J.
    resolve: (expected) =>
      probeHttp('POST', '/api/v1/oasis/vtid/terminalize', isExpectedHttp(expected) ? expected : {}, {
        vtid: 'VTID-CONTRACT-PROBE-INVALID',
        outcome: 'success',
        actor: 'test-contract-probe',
      }),
  },
  'worker_orchestrator.await_autopilot_requires_auth': {
    command_key: 'worker_orchestrator.await_autopilot_requires_auth',
    contract_type: 'live_probe',
    dispatch: 'sync_http',
    // Probes with empty body. Auth gate must reject: 400 (missing vtid /
    // autopilot_execution_id) or 401 (missing worker_id). A 200 here
    // would mean the auth gate is gone — security regression.
    resolve: (expected) =>
      probeHttp(
        'POST',
        '/api/v1/worker/orchestrator/await-autopilot-execution',
        isExpectedHttp(expected) ? expected : {},
        {},
      ),
  },
};

/**
 * Resolve a command_key against the allowlist. Returns null if the key
 * is not in the allowlist — callers must treat that as a hard reject
 * (400), not as "run it anyway".
 */
export function resolveCommand(command_key: string): AllowlistedCommand | null {
  return COMMAND_ALLOWLIST[command_key] ?? null;
}

/**
 * Exported for tests + the missing-test scanner (Phase 2) to discover
 * which command_keys are available.
 */
export function listAllowlistedKeys(): string[] {
  return Object.keys(COMMAND_ALLOWLIST);
}
