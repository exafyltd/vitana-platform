/**
 * VTID-04100 — the greeting audio bridge is pinned ON for production.
 *
 * This reverses a recorded product decision (2026-07-28: disabled because the
 * bridge phrase is synthesized by a different engine from the live upstream,
 * so the user hears one voice say the filler and another continue). The
 * platform owner reviewed and accepted that seam on 2026-09-19.
 *
 * It is pinned in the deploy workflow rather than hand-set on the task
 * definition, per CLAUDE.md's standing rule, and asserted here because the
 * whole failure class VTID-04098 found was a flag whose live value did not
 * match what anyone believed it was.
 */

import * as fs from 'fs';
import * as path from 'path';

const prodWorkflow = fs.readFileSync(
  path.resolve(__dirname, '../../../../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'),
  'utf8',
);
const stageWorkflow = fs.readFileSync(
  path.resolve(__dirname, '../../../../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'),
  'utf8',
);

describe('VTID-04100: production pins FEATURE_ORB_GREETING_TTS_BRIDGE_ENV', () => {
  it('upserts the flag as "staging+prod" so the bridge is live for real users', () => {
    expect(prodWorkflow).toMatch(/\{name:"FEATURE_ORB_GREETING_TTS_BRIDGE_ENV", value:"staging\+prod"\}/);
  });

  it('strips the inherited value first, so a stale "off" on the task def cannot survive', () => {
    // The live prod task def did not carry this var at all, and an absent var
    // resolves to off — the strip-then-add is what makes the pin authoritative
    // rather than dependent on what happens to be there.
    const strip = prodWorkflow.slice(
      prodWorkflow.indexOf('select(.name | IN("FEATURE_ORB_FAST_START_ENV"'),
      prodWorkflow.indexOf('{name:"FEATURE_ORB_FAST_START_ENV", value:"staging+prod"}'),
    );
    expect(strip).toContain('"FEATURE_ORB_GREETING_TTS_BRIDGE_ENV"');
  });

  it('records WHY a recorded product decision was reversed, not just that it was', () => {
    const i = prodWorkflow.indexOf('FEATURE_ORB_GREETING_TTS_BRIDGE_ENV is now pinned ON');
    expect(i).toBeGreaterThan(-1);
    const block = prodWorkflow.slice(i, i + 1800);
    expect(block).toMatch(/2026-07-28/);
    expect(block).toMatch(/different engine from the live upstream/);
    expect(block).toMatch(/accepted the seam/);
    // and how to undo it
    expect(block).toMatch(/Rollback is this\s*#\s*value back to "off"/);
  });

  it('is only safe because VTID-04100 cached it and bounded its await — say so', () => {
    const i = prodWorkflow.indexOf('FEATURE_ORB_GREETING_TTS_BRIDGE_ENV is now pinned ON');
    const block = prodWorkflow.slice(i, i + 1800);
    expect(block).toMatch(/cache/i);
    expect(block).toMatch(/VTID-03802/);
  });

  it('staging keeps the flag on too — prod must never be ahead of staging on this', () => {
    expect(stageWorkflow).toMatch(/\{name:"FEATURE_ORB_GREETING_TTS_BRIDGE_ENV", value:"staging-only"\}/);
  });
});
