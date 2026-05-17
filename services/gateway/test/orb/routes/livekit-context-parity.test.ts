/**
 * VTID-03036 — LiveKit context parity static-wire-up test.
 *
 * Locks the source-text wire-up that makes the LiveKit
 * /api/v1/orb/context-bootstrap call Vertex's shared
 * `buildBootstrapContextPack` and inline its `contextInstruction`
 * (memoryContext.formatted_context + last-3 user turns + USER CONTEXT
 * PROFILE) into the bootstrap response.
 *
 * The Live path was previously identity-only, which is why the agent
 * could not answer "how long have I been a member?" or "what did I ask
 * last?" — Vertex injects those facts through the shared bootstrap pack
 * but the LiveKit route did not consume it.
 *
 * The wire-up is verified at source level (rather than via a full HTTP
 * integration test) for the same reason the surrounding suite locks
 * other route invariants this way: integration setup for `optionalAuth`
 * + Supabase + the L2.2b.4 dynamic-import spine is heavy, while the
 * wire-up itself is the load-bearing contract.
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVEKIT_PATH = path.resolve(
  __dirname,
  '../../../src/routes/orb-livekit.ts',
);

let source: string;

beforeAll(() => {
  source = fs.readFileSync(ORB_LIVEKIT_PATH, 'utf8');
});

describe('VTID-03036 LiveKit context parity wire-up', () => {
  it('imports buildBootstrapContextPack from ./orb-live', () => {
    // The import lives alongside buildClientContext +
    // formatClientContextForInstruction so all three Vertex helpers
    // are loaded from a single statement. If a future refactor moves
    // it, the corresponding usage assertion below will fail too.
    expect(source).toMatch(/import\s*{[^}]*\bbuildBootstrapContextPack\b[^}]*}\s*from\s*['"]\.\/orb-live['"]/);
  });

  it('invokes buildBootstrapContextPack inside the parallel batch', () => {
    // The pack call sits inside the existing Promise.all alongside the
    // 6 user-scoped queries. Running it in parallel is required so the
    // history-aware fetch does not regress bootstrap latency.
    expect(source).toMatch(/await\s+buildBootstrapContextPack\(\s*req\.identity\s*,\s*sessionId\s*\)/);
  });

  it('passes a LiveKit-scoped synthetic sessionId to the pack', () => {
    // The sessionId is only used for log correlation by the pack itself
    // but the literal prefix lets ops greps tell apart Live and
    // Live-via-LiveKit bootstrap log lines.
    expect(source).toMatch(/livekit-bootstrap-\$\{agentId\}-/);
  });

  it('pushes the resolved contextInstruction into ctxParts when non-empty', () => {
    // The push is guarded so anonymous / missing-identity / fetch-failed
    // results never inject an empty string into the prompt.
    expect(source).toMatch(/historyContextPack\.contextInstruction[\s\S]{0,200}ctxParts\.push\(historyContextPack\.contextInstruction\)/);
  });

  it('skips the push when contextInstruction is empty or missing', () => {
    // The guard MUST check non-empty content; an empty string would
    // still pass `typeof === 'string'` and pollute the prompt with
    // bare newlines.
    expect(source).toMatch(/historyContextPack\.contextInstruction\.trim\(\)\.length\s*>\s*0/);
  });

  it('surfaces a structured context_pack field on the response', () => {
    // Operator/cockpit inspection — mirrors how decision_context is
    // exposed for the spine. The renderer flows through bootstrap_context;
    // this field carries timing + skipped reason for triage.
    expect(source).toMatch(/context_pack:\s*historyContextPack/);
    expect(source).toMatch(/latency_ms:\s*historyContextPack\.latencyMs/);
    expect(source).toMatch(/skipped_reason:\s*historyContextPack\.skippedReason/);
  });

  it('handles failure best-effort with a [VTID-LIVEKIT-FOUNDATION] warn', () => {
    // The promise body must swallow throws so a pack failure never
    // blocks the bootstrap response. The Vertex production path is
    // unaffected by anything inside this best-effort closure.
    expect(source).toMatch(/buildBootstrapContextPack failed:/);
  });
});
