/**
 * VTID-03791 — the staging task def must PIN FEATURE_ORB_WS_TRANSPORT_ENV to
 * "staging-only", not leave it unset.
 *
 * VTID-03471's own `GET /live/transport` route (orb-live.ts) tells every
 * browser session which transport to use — 'ws' when this flag is live,
 * 'sse' otherwise (isFeatureLive default is "off"). Live verification of
 * VTID-03779's Nova session pre-warm feature found the prewarm handshake
 * completing correctly (prewarm sent -> prewarm_ready ack) but the reuse
 * branch never engaging on a default tap: this flag was unset, every real
 * session was told to use SSE, and SSE sessions never call
 * _sessionStartWs() at all — the warmed Nova connection just sat unclaimed
 * until its 90s TTL expired. Pinning this flag does not change any code —
 * it only makes WS (the transport VTID-03779's reuse mechanism actually
 * requires) the one real staging taps get, instead of leaving the feature
 * dormant behind an unrelated, pre-existing config gap.
 *
 * Pinned the same way VTID-03779 pinned FEATURE_ORB_NOVA_PREWARM_ENV:
 * present in both the strip list and the re-add list with the exact string
 * value isFeatureLive requires, so a future edit that drops one half cannot
 * silently regress real sessions back to SSE.
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW = path.resolve(
  __dirname,
  '../../../../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
);

const yml = fs.readFileSync(WORKFLOW, 'utf8');

describe('VTID-03791: staging pins FEATURE_ORB_WS_TRANSPORT_ENV', () => {
  it('upserts the flag as "staging-only"', () => {
    expect(yml).toMatch(
      /\{name:"FEATURE_ORB_WS_TRANSPORT_ENV", value:"staging-only"\}/,
    );
  });

  it('strips the inherited value first, so a stale one cannot survive', () => {
    // Without this, the re-add would append a DUPLICATE key alongside the
    // inherited one, and which wins is not something to leave to chance.
    const stripBlock = yml.slice(
      yml.indexOf('.containerDefinitions[0].environment |='),
      yml.indexOf('.containerDefinitions[0].secrets |='),
    );
    const strip = stripBlock.slice(0, stripBlock.indexOf('| not) ]'));
    expect(strip).toContain('"FEATURE_ORB_WS_TRANSPORT_ENV"');
  });

  // VTID-04866 (owner decision 2026-10-03) — the "later decision" this test
  // used to defer is made: prod pins the transport to 'ws'. On SSE a voice
  // session is one stream plus ~15 POSTs/s that the ALB routes one by one,
  // so during a deploy's two-task overlap a member's requests split across
  // tasks and the session dies. A WebSocket stays on one task.
  describe('VTID-04866: prod pins FEATURE_ORB_WS_TRANSPORT_ENV', () => {
    const prodYml = fs.readFileSync(
      path.resolve(__dirname, '../../../../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'),
      'utf8',
    );

    it('upserts the flag as "staging+prod" (the value that is live on prod)', () => {
      expect(prodYml).toMatch(/\{name:"FEATURE_ORB_WS_TRANSPORT_ENV", value:"staging\+prod"\}/);
      // "staging-only" would read as on and resolve to SSE on prod.
      expect(prodYml).not.toMatch(/\{name:"FEATURE_ORB_WS_TRANSPORT_ENV", value:"staging-only"\}/);
    });

    it('strips the inherited value in the same jq block, so no duplicate key survives', () => {
      const add = prodYml.indexOf('{name:"FEATURE_ORB_WS_TRANSPORT_ENV", value:"staging+prod"}');
      const block = prodYml.slice(prodYml.lastIndexOf('.containerDefinitions[0].environment |=', add), add);
      const strip = block.slice(0, block.indexOf('| not) ]'));
      expect(strip).toContain('"FEATURE_ORB_WS_TRANSPORT_ENV"');
    });

    it('is pinned before env_overrides is applied, so a one-dispatch "off" still wins', () => {
      const add = prodYml.indexOf('{name:"FEATURE_ORB_WS_TRANSPORT_ENV", value:"staging+prod"}');
      const overrides = prodYml.indexOf('Applying env_overrides');
      expect(add).toBeGreaterThan(0);
      expect(overrides).toBeGreaterThan(add);
    });
  });
});
