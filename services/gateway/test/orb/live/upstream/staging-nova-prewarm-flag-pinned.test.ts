/**
 * VTID-03779 — the staging task def must PIN FEATURE_ORB_NOVA_PREWARM_ENV,
 * not leave it to inherit whatever a prior task definition happened to
 * carry. Without this var set, isFeatureLive('ORB_NOVA_PREWARM') resolves
 * the code default (off) and handleWsPrewarmMessage returns immediately —
 * the whole session pre-establishment mechanism silently never runs, the
 * same "config that exists only in live AWS state" shape VTID-03513 and
 * VTID-03646/VTID-03741 already cost real debugging time for elsewhere in
 * this file.
 *
 * Pinned the same way VTID-03741 pinned FEATURE_LATENCY_TELEMETRY_ENV:
 * present in both the strip list and the re-add list with the exact string
 * value isFeatureLive requires, so a future edit that drops one half cannot
 * silently regress the mechanism back to a no-op. STAGING ONLY, deliberately
 * not added to AWS-PROD-DEPLOY-GATEWAY.yml yet — this needs a real staging
 * measurement against the <3s cold-start / ~1.5s warm-start targets before
 * prod is a question.
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW = path.resolve(
  __dirname,
  '../../../../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
);

const yml = fs.readFileSync(WORKFLOW, 'utf8');

describe('VTID-03779: staging pins FEATURE_ORB_NOVA_PREWARM_ENV', () => {
  it('upserts the flag as "staging-only"', () => {
    expect(yml).toMatch(
      /\{name:"FEATURE_ORB_NOVA_PREWARM_ENV", value:"staging-only"\}/,
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
    expect(strip).toContain('"FEATURE_ORB_NOVA_PREWARM_ENV"');
  });

  it('is deliberately NOT pinned on the prod deploy workflow yet', () => {
    const prodWorkflow = path.resolve(
      __dirname,
      '../../../../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml',
    );
    const prodYml = fs.readFileSync(prodWorkflow, 'utf8');
    expect(prodYml).not.toContain('FEATURE_ORB_NOVA_PREWARM_ENV');
  });
});
