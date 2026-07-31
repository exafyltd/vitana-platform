/**
 * L-02 — Bedrock transport preparation overlaps context assembly.
 *
 * The session path now kicks `prewarmNovaSonicBedrock` concurrently with
 * `buildOrbVertexSetupEnvelope()` instead of leaving all credential/TLS work
 * behind that await. That makes concurrent entry into the shared-client
 * factory the NORMAL case, so the factory must collapse concurrent callers
 * onto a single build rather than racing and building twice.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../../src');

describe('L-02: Bedrock client factory memoization', () => {
  it('memoizes the in-flight promise, not just the resolved value', () => {
    const src = readFileSync(
      join(SRC, 'orb/live/upstream/nova-sonic-live-client.ts'),
      'utf8',
    );
    // The racy shape assigned the awaited result straight onto the shared
    // slot, so two concurrent callers both saw null and both built.
    expect(src).not.toMatch(/sharedBedrockClient = await buildBedrockClient/);
    expect(src).toContain('let sharedBedrockClientPromise');
    expect(src).toContain('if (sharedBedrockClient) return sharedBedrockClient;');
    expect(src).toContain('if (!sharedBedrockClientPromise)');
  });

  it('clears the memo on build failure so the next attempt can retry', () => {
    const src = readFileSync(
      join(SRC, 'orb/live/upstream/nova-sonic-live-client.ts'),
      'utf8',
    );
    // A cached rejected promise would wedge every later session.
    expect(src).toMatch(/\.catch\(\(err\) => \{\s*sharedBedrockClientPromise = null;\s*throw err;/);
  });

  it('test seam clears the in-flight memo alongside the value', () => {
    const src = readFileSync(
      join(SRC, 'orb/live/upstream/nova-sonic-live-client.ts'),
      'utf8',
    );
    const seam = src.slice(src.indexOf('__setSharedBedrockClientForTests'));
    expect(seam).toContain('sharedBedrockClientPromise = null;');
  });

  it('starts transport prep before awaiting the setup envelope, and does not await it', () => {
    const src = readFileSync(join(SRC, 'routes/orb-live.ts'), 'utf8');
    // Anchor on the connect branch specifically. `provider === 'nova_sonic'`
    // is NOT unique — its first occurrence is the rotation-exhausted override
    // branch, which has no envelope build at all.
    const anchor = 'const novaCfg = getNovaSonicConfig(process.env);';
    expect(src.split(anchor).length - 1).toBe(1); // stays unique
    const novaBranch = src.indexOf(anchor);
    expect(novaBranch).toBeGreaterThan(-1);
    const window = src.slice(novaBranch, novaBranch + 2500);

    const prewarmAt = window.indexOf('prewarmNovaSonicBedrock(novaCfg)');
    const envelopeAt = window.indexOf('await buildOrbVertexSetupEnvelope()');
    expect(prewarmAt).toBeGreaterThan(-1);
    expect(envelopeAt).toBeGreaterThan(-1);
    // The whole point: prep is kicked BEFORE the context await.
    expect(prewarmAt).toBeLessThan(envelopeAt);
    // Fire-and-forget — awaiting it could only add latency on a warm process.
    expect(window).toContain('void prewarmNovaSonicBedrock(novaCfg)');
    expect(window).not.toContain('await prewarmNovaSonicBedrock(novaCfg)');
    // An unawaited promise must not be able to raise an unhandled rejection.
    expect(window).toMatch(/void prewarmNovaSonicBedrock\(novaCfg\)\.catch\(/);
  });
});
