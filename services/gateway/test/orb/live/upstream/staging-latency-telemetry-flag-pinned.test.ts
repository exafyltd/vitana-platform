/**
 * VTID-03741 — the staging task def must PIN FEATURE_LATENCY_TELEMETRY_ENV,
 * not leave it to inherit whatever a prior task definition happened to carry.
 *
 * LatencyTracker (services/gateway/src/orb/live/latency-tracker.ts) already
 * marks the click-to-first-audio breakdown this VTID needs a real baseline
 * for (upstream_connected, context_awaited, setup_sent, greeting_sent,
 * audio_out_first_chunk) and emits it as a voice.latency.measured OASIS
 * event — but it self-gates on isFeatureLive('LATENCY_TELEMETRY'), which
 * resolves the code default (off) whenever FEATURE_LATENCY_TELEMETRY_ENV is
 * unset. It was unset on both AWS gateway task defs (only wired here now),
 * the same shape as the FEATURE_ORB_SAFE_FAST_GREETING gap VTID-03646 found
 * — config that exists only in live AWS state is invisible to review and
 * silently reversible by the next deploy (the VTID-03513 failure shape).
 *
 * This pins it the same way VTID-03720 pinned ORB_CASCADED_VOICE_ENABLED:
 * present in both the strip list and the re-add list with the exact string
 * value isFeatureLive requires, so a future edit that drops one half cannot
 * silently regress the tracker back to a no-op.
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW = path.resolve(
  __dirname,
  '../../../../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
);

const yml = fs.readFileSync(WORKFLOW, 'utf8');

describe('VTID-03741: staging pins FEATURE_LATENCY_TELEMETRY_ENV', () => {
  it('upserts the flag as "staging-only"', () => {
    // Exact value readSetting() in feature-flags.ts requires; isFeatureLive
    // resolves 'staging-only' to true on staging (isStaging) and false on
    // prod, so this deliberately does not touch AWS-PROD-DEPLOY-GATEWAY.yml.
    expect(yml).toMatch(
      /\{name:"FEATURE_LATENCY_TELEMETRY_ENV", value:"staging-only"\}/,
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
    expect(strip).toContain('"FEATURE_LATENCY_TELEMETRY_ENV"');
  });
});
