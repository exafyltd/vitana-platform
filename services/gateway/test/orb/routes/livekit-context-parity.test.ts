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

  // VTID-03084 (Lane 2) — LiveKit lang resolution priority.
  it('VTID-03084: reads ?lang query param first (most explicit)', () => {
    // The route must look at req.query.lang BEFORE the Accept-Language
    // header so a Test Bench / mobile UI dropdown choice always wins
    // over the browser's default language.
    expect(source).toMatch(/req\.query\.lang/);
    expect(source).toMatch(/queryLang\b/);
  });

  it('VTID-03084: still falls back to Accept-Language header', () => {
    expect(source).toMatch(/req\.headers\[['"]accept-language['"]\]/);
    expect(source).toMatch(/headerLang\b/);
  });

  it('VTID-03084: consults stored preferred_language fact when no explicit query param', () => {
    expect(source).toMatch(/preferred_language/);
    expect(source).toMatch(/getCurrentFacts/);
  });
});

describe('VTID-03127 Phase D.4.a voice.cascade.default fallback', () => {
  it('reads voice.cascade.default from PolicyResolver when agent_voice_configs returns null', () => {
    // The fallback block must call the resolver with the canonical
    // policy key.
    expect(source).toMatch(/POLICY_KEYS\.VOICE_CASCADE_DEFAULT/);
    expect(source).toMatch(/getPolicyResolver\(\)\.getValue/);
  });

  it('is gated on voiceConfig being null after the agent_voice_configs lookup', () => {
    // Per-agent override (when agent_voice_configs has a row) MUST win
    // over the default — the fallback only fires when voiceConfig is
    // still null after the table lookup.
    expect(source).toMatch(/if\s*\(\s*!voiceConfig\s*\)\s*\{/);
  });

  it('tags the fallback with a `_source` marker so the agent / cockpit can tell it apart from a per-agent row', () => {
    // Useful for telemetry: a session that hit the default vs. one that
    // hit a per-agent override leaves a distinguishable trail.
    expect(source).toMatch(/_source:\s*['"]voice\.cascade\.default['"]/);
  });

  it('best-effort: resolver fetch failure does not block the bootstrap', () => {
    // A try/catch wraps the fallback fetch so a resolver bug cannot
    // crash a voice session. The Python agent still has its own
    // literal fallback today; D.4.b removes that.
    expect(source).toMatch(/VTID-03127[\s\S]{0,300}resolver fetch failed/);
  });
});

describe('VTID-03122 Phase E LiveKit context parity — lastSessionInfo + journey trail', () => {
  it('extracts current_route from the query string', () => {
    expect(source).toMatch(/req\.query\.current_route/);
    expect(source).toMatch(/const\s+currentRoute\s*=/);
  });

  it('extracts recent_routes as array or comma-separated string', () => {
    expect(source).toMatch(/req\.query\.recent_routes/);
    expect(source).toMatch(/Array\.isArray\(raw\)/);
    expect(source).toMatch(/split\(['"`],['"`]\)/);
  });

  it('caps recent_routes at 10 entries to bound prompt size', () => {
    expect(source).toMatch(/\.slice\(0,\s*10\)/);
  });

  it('hoists fetchLastSessionInfo so both buildLiveSystemInstruction call sites share one fetch', () => {
    expect(source).toMatch(
      /let\s+lastSessionInfo:\s*\{\s*time:\s*string;\s*wasFailure:\s*boolean\s*\}\s*\|\s*null\s*=\s*null/,
    );
    expect(source).toMatch(/lastSessionInfo\s*=\s*await\s+fetchLastSessionInfo\(userId\)/);
  });

  it('threads lastSessionInfo / currentRoute / recentRoutes into both buildLiveSystemInstruction call sites', () => {
    // Both calls must reference the variables; the original `null` literals
    // for these positional args were the parity leak.
    const callRegex = /buildLiveSystemInstruction\([\s\S]*?\);/g;
    const calls = source.match(callRegex) ?? [];
    const vitanaCalls = calls.filter((c) => c.includes('vitanaContextInstruction') || c.includes('augmentedContext'));
    expect(vitanaCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of vitanaCalls) {
      expect(call).toMatch(/\blastSessionInfo\b/);
      expect(call).toMatch(/\bcurrentRoute\b/);
      expect(call).toMatch(/\brecentRoutes\b/);
    }
  });

  it('does not re-fetch lastSessionInfo inside the wake-brief block (single fetch only)', () => {
    // One single occurrence of `await fetchLastSessionInfo` is the hoist.
    // A duplicate inside the wake-brief block would mean the route fetches
    // twice per request.
    const matches = source.match(/await\s+fetchLastSessionInfo\(/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('echoes lastSessionInfo / currentRoute / recentRoutes back in the bootstrap response payload', () => {
    expect(source).toMatch(/last_session_info:\s*lastSessionInfo/);
    expect(source).toMatch(/current_route:\s*currentRoute/);
    expect(source).toMatch(/recent_routes:\s*recentRoutes\s*\?\?\s*\[\]/);
  });

  it('degrades silently when fetchLastSessionInfo throws (best-effort, no rethrow)', () => {
    // Must wrap the hoisted fetch in try/catch so a temporal-bucket lookup
    // failure cannot block the bootstrap response. The Vertex orb-live.ts
    // path is unaffected.
    expect(source).toMatch(/fetchLastSessionInfo failed[\s\S]{0,200}falls back to UNKNOWN/);
  });
});
