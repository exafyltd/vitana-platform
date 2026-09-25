/**
 * VTID-04531 — the per-turn voice latency provider label must name the upstream
 * that actually served the turn.
 *
 * Before this, `startVoiceTurnLatency()` (routes/orb-live.ts) resolved the label
 * with a Nova-vs-everything-else ternary whose else-branch was
 * `vertex/${GEMINI_MODEL}` = `vertex/gemini-2.0-flash-exp` — a stale constant
 * from the deleted GEMINI_API_KEY era. Cascade sessions (Transcribe -> Bedrock
 * -> Polly/Fish) and Vertex Serbian-bridge sessions were therefore both
 * reported under a model that never served them.
 *
 * VTID-04542 landed a second, session-aware resolver with the same purpose
 * (`orb/live/latency-context.ts`), so VTID-04531's fix is now that ONE resolver
 * — the per-turn tracker reads it with the whole session (provider + lang), not
 * just `upstreamProvider`, which is what lets the cascade keep its own label.
 * This suite pins both halves: the three provider labels, and the wiring in
 * orb-live.ts (a single resolver, no stale model, no duplicate module).
 */

import * as fs from 'fs';
import * as path from 'path';

import { resolveLatencyProviderLabel } from '../../../src/orb/live/latency-context';
import { NOVA_SONIC_MODEL_ID } from '../../../src/orb/live/upstream/nova-sonic-config';
import { VERTEX_LIVE_MODEL } from '../../../src/orb/live/protocol';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../src/routes/orb-live.ts');
const src = fs.readFileSync(ORB_LIVE_PATH, 'utf8');

const STALE_GEMINI_LABEL = 'gemini-2.0-flash-exp';

describe('VTID-04531: per-turn voice latency provider label', () => {
  it('labels Nova Sonic sessions with the real Nova model id', () => {
    expect(resolveLatencyProviderLabel({ upstreamProvider: 'nova_sonic' })).toBe(
      `nova_sonic/${NOVA_SONIC_MODEL_ID}`,
    );
  });

  it('gives the cascade its own label, never the Vertex model it never used', () => {
    const label = resolveLatencyProviderLabel({ upstreamProvider: 'cascaded', lang: 'ru' });
    expect(label).toMatch(/^cascade\//);
    expect(label).not.toMatch(/^vertex\//);
    expect(label).not.toContain(STALE_GEMINI_LABEL);
  });

  it('labels the Vertex bridge with the configured Vertex Live model id', () => {
    const label = resolveLatencyProviderLabel({ upstreamProvider: 'vertex' });
    expect(label).toBe(`vertex/${VERTEX_LIVE_MODEL}`);
    // The bug: the stale GEMINI_MODEL is not the model the Vertex path runs on.
    expect(label).not.toContain(STALE_GEMINI_LABEL);
  });

  it('never returns the stale gemini-2.0-flash-exp label for any provider', () => {
    for (const input of [
      { upstreamProvider: 'nova_sonic' },
      { upstreamProvider: 'cascaded', lang: 'ru' },
      { upstreamProvider: 'vertex' },
    ]) {
      expect(resolveLatencyProviderLabel(input)).not.toContain(STALE_GEMINI_LABEL);
    }
  });

  it('keeps the three providers distinguishable in the event', () => {
    const labels = [
      resolveLatencyProviderLabel({ upstreamProvider: 'nova_sonic' }),
      resolveLatencyProviderLabel({ upstreamProvider: 'cascaded', lang: 'ru' }),
      resolveLatencyProviderLabel({ upstreamProvider: 'vertex' }),
    ];
    expect(new Set(labels).size).toBe(3);
  });

  it("orb-live's per-turn tracker resolves the label from the shared session-aware resolver", () => {
    const fn = src.slice(
      src.indexOf('function startVoiceTurnLatency('),
      src.indexOf('function markVoiceLatency('),
    );
    expect(fn).not.toBe('');
    // The comments explain the old bug by name, so the negative assertions run
    // on the executable lines only — the fix must not be a comment.
    const code = fn
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    // The resolver takes the SESSION: the cascade label depends on `lang`.
    expect(code).toMatch(/const provider = resolveLatencyProviderLabel\(session\);/);
    // No Nova-vs-everything-else ternary left behind, and no inline label built
    // off the stale constant or a hardcoded vertex prefix.
    expect(code).not.toMatch(/GEMINI_MODEL/);
    expect(code).not.toMatch(/vertex\//);
    // Exactly one provider assignment, and it is the resolver call.
    expect((code.match(/const provider = /g) || []).length).toBe(1);
    // The provider is only assigned FROM the resolver.
    expect(code).toMatch(/const provider = resolveLatencyProviderLabel\(session\);\n/);
    // No merge-conflict marker may survive anywhere in the route file.
    expect(src).not.toMatch(/^<{7}|^>{7}/m);
  });

  it('a single resolver owns the label — no duplicate upstream module, no provider-only call', () => {
    // The merge that produced this state had two files exporting
    // `resolveLatencyProviderLabel`, which is how the stale label came back.
    expect(fs.existsSync(path.resolve(__dirname, '../../../src/orb/live/upstream/latency-provider-label.ts'))).toBe(false);
    expect(src).not.toContain('upstream/latency-provider-label');
    // `resolveLatencyProviderLabel(session.upstreamProvider)` (the pre-merge
    // form) cannot label the cascade's TTS backend — it must not return.
    expect(src).not.toMatch(/resolveLatencyProviderLabel\(\s*session\.upstreamProvider/);
    // Both call sites (per-turn + persona hand-off) pass the session.
    const sessionCalls = src.match(/resolveLatencyProviderLabel\(session\)/g) || [];
    expect(sessionCalls.length).toBeGreaterThanOrEqual(2);
  });
});
