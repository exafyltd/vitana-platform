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

  it('is deliberately NOT pinned on the prod deploy workflow yet', () => {
    // The 'ws' transport being turned on for real production traffic is a
    // separate, later decision -- this VTID only unblocks it on staging,
    // where VTID-03779's own prewarm/reuse mechanism is also staging-only.
    const prodWorkflow = path.resolve(
      __dirname,
      '../../../../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml',
    );
    const prodYml = fs.readFileSync(prodWorkflow, 'utf8');
    // VTID-04098: assert the absence of the PIN, not of the string.
    // The prod workflow now explains in a comment why this flag is
    // deliberately left unpinned (FEATURE_ORB_WS_TRANSPORT_ENV only takes
    // effect on the WebSocket session path, and prod resolves SSE), so a
    // bare substring check would fail on the documentation of the very
    // invariant it is protecting. What must never appear is the jq upsert.
    expect(prodYml).not.toMatch(/\{name:"FEATURE_ORB_WS_TRANSPORT_ENV"/);
    expect(prodYml).not.toMatch(/name:\s*"FEATURE_ORB_WS_TRANSPORT_ENV",\s*value:/);
  });
});
