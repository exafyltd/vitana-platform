/**
 * VTID-04128 — FEATURE_ORB_GREETING_TTS_BRIDGE_ENV is no longer
 * unconditionally re-pinned on every production deploy.
 *
 * This reverses VTID-04100 (2026-09-19), which this test file originally
 * asserted: a strip-then-add block that forced the flag to "staging+prod" on
 * EVERY single dispatch, regardless of deploy_mode or which inputs were
 * passed. That shape caused a real incident — VTID-04120 fixed the resulting
 * double-voice pre-login greeting (a filler phrase from one TTS engine,
 * followed by the real upstream voice with different content) via the
 * `env_overrides` escape hatch, which applies to a single dispatch only. The
 * very next, unrelated prod deploy (VTID-04126) re-ran this unconditional
 * block and silently reintroduced the exact bug that had just been fixed,
 * with no code change and no one asking for it. The platform owner rejected
 * the seam a second time (VTID-04127) and asked why a fix that should be
 * permanent kept reverting.
 *
 * The fix: unpin the flag entirely. A deploy that does not explicitly ask to
 * change it now leaves whatever value is currently on the live task
 * definition alone — the same behavior every other optional flag in this
 * workflow already has (the `if [ -n "$…INPUT" ]` pattern). "Off" now stays
 * off across deploys until someone deliberately re-enables it.
 */

import * as fs from 'fs';
import * as path from 'path';

const prodWorkflow = fs.readFileSync(
  path.resolve(__dirname, '../../../../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'),
  'utf8',
);

describe('VTID-04128: production no longer force-pins FEATURE_ORB_GREETING_TTS_BRIDGE_ENV', () => {
  it('does NOT unconditionally upsert the flag to "staging+prod" any more', () => {
    expect(prodWorkflow).not.toMatch(/\{name:"FEATURE_ORB_GREETING_TTS_BRIDGE_ENV", value:"staging\+prod"\}/);
  });

  it('does NOT strip the flag out of the current task def either — a deploy must leave it alone', () => {
    const strip = prodWorkflow.slice(
      prodWorkflow.indexOf('select(.name | IN("FEATURE_ORB_FAST_START_ENV"'),
      prodWorkflow.indexOf('{name:"FEATURE_ORB_FAST_START_ENV", value:"staging+prod"}'),
    );
    expect(strip).not.toContain('FEATURE_ORB_GREETING_TTS_BRIDGE_ENV');
  });

  it('records WHY the always-pin was reversed, not just that it was', () => {
    const i = prodWorkflow.indexOf('FEATURE_ORB_GREETING_TTS_BRIDGE_ENV is REMOVED from');
    expect(i).toBeGreaterThan(-1);
    const block = prodWorkflow.slice(i, i + 1800);
    expect(block).toMatch(/VTID-04100/);
    expect(block).toMatch(/double-voice pre-login greeting/);
    expect(block).toMatch(/VTID-04126/);
    expect(block).toMatch(/VTID-04127/);
  });

  it('the other four VTID-04098/04100 flags remain pinned — this reversal is scoped to one flag only', () => {
    expect(prodWorkflow).toMatch(/\{name:"FEATURE_ORB_FAST_START_ENV", value:"staging\+prod"\}/);
    expect(prodWorkflow).toMatch(/\{name:"FEATURE_ORB_BRAIN_CACHE_ENV", value:"staging\+prod"\}/);
    expect(prodWorkflow).toMatch(/\{name:"FEATURE_LATENCY_TELEMETRY_ENV", value:"staging\+prod"\}/);
    expect(prodWorkflow).toMatch(/\{name:"FEATURE_ORB_SAFE_FAST_GREETING_ENV", value:"staging\+prod"\}/);
  });
});
