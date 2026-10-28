/**
 * VTID-03741 — the staging task def must PIN FEATURE_ORB_FAST_START_ENV and
 * FEATURE_ORB_BRAIN_CACHE_ENV, matching AWS-PROD-DEPLOY-GATEWAY.yml, instead
 * of leaving them to whatever the task definition happened to inherit.
 *
 * BOOTSTRAP-ORB-FASTSTART-DRIFT / VTID-03504 already pin both of these on
 * PROD with measured evidence: FEATURE_ORB_FAST_START_ENV missing measured a
 * 9.5s cold authenticated start (past the widget 8s fetch-abort timeout —
 * the first connect after login hung with no retry); FEATURE_ORB_BRAIN_CACHE_ENV
 * missing measured a brain-build p50 of 2.0s degrading to 17.4s p50 / 119.7s
 * max under stacked reconnects. Neither var was ever set anywhere in the
 * STAGING workflow, which is the exact "config that exists only in live AWS
 * state, invisible to review" shape VTID-03513 already cost four days for
 * elsewhere — and staging is specifically the stack meant to catch a
 * regression here before it reaches prod.
 *
 * This pins both flags to the same "staging+prod" value prod runs (required
 * — `isFeatureLive` maps "staging-only" to `isStaging`, and prod's own
 * comment already flags that a naive "staging-only" copy would leave the
 * flag dead in prod; using the identical value on both keeps them from being
 * two different unverified guesses).
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW = path.resolve(
  __dirname,
  '../../../../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
);

const yml = fs.readFileSync(WORKFLOW, 'utf8');

describe('VTID-03741: staging pins FEATURE_ORB_FAST_START_ENV and FEATURE_ORB_BRAIN_CACHE_ENV', () => {
  it('upserts FEATURE_ORB_FAST_START_ENV as "staging+prod", matching prod', () => {
    expect(yml).toMatch(
      /\{name:"FEATURE_ORB_FAST_START_ENV", value:"staging\+prod"\}/,
    );
  });

  it('upserts FEATURE_ORB_BRAIN_CACHE_ENV as "staging+prod", matching prod', () => {
    expect(yml).toMatch(
      /\{name:"FEATURE_ORB_BRAIN_CACHE_ENV", value:"staging\+prod"\}/,
    );
  });

  it('strips both inherited values first, so a stale one cannot survive', () => {
    const stripBlock = yml.slice(
      yml.indexOf('.containerDefinitions[0].environment |='),
      yml.indexOf('.containerDefinitions[0].secrets |='),
    );
    const strip = stripBlock.slice(0, stripBlock.indexOf('| not) ]'));
    expect(strip).toContain('"FEATURE_ORB_FAST_START_ENV"');
    expect(strip).toContain('"FEATURE_ORB_BRAIN_CACHE_ENV"');
  });

  it('matches the exact value AWS-PROD-DEPLOY-GATEWAY.yml pins, so staging and prod cannot silently diverge', () => {
    const prodWorkflow = path.resolve(
      __dirname,
      '../../../../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml',
    );
    const prodYml = fs.readFileSync(prodWorkflow, 'utf8');
    for (const name of ['FEATURE_ORB_FAST_START_ENV', 'FEATURE_ORB_BRAIN_CACHE_ENV']) {
      const stagingMatch = yml.match(new RegExp(`\\{name:"${name}", value:"([^"]+)"\\}`));
      const prodMatch = prodYml.match(new RegExp(`\\{name:"${name}", value:"([^"]+)"\\}`));
      expect(stagingMatch).not.toBeNull();
      expect(prodMatch).not.toBeNull();
      expect(stagingMatch![1]).toBe(prodMatch![1]);
    }
  });
});
