/**
 * VTID-03720 — the staging task def must PIN the cascade flag, not inherit it.
 *
 * Reported live: Polish and Portuguese still answered in English on staging,
 * for hours, after every code fix in the chain had merged. The code was never
 * the blocker — `evaluateCascadeEligibility` resolves pl -> Ola/pl-PL and
 * pt -> Camila/pt-BR correctly. `ORB_CASCADED_VOICE_ENABLED` simply was not
 * set by this workflow: it appeared ONLY inside a comment claiming it was
 * "already true here", which described observed live AWS state rather than
 * anything the repo guaranteed. Absent from both the strip list and the
 * re-add list, it was merely preserved from the previous task definition.
 *
 * `isCascadedVoiceEnabled()` requires the exact string 'true'. Anything else —
 * unset, empty, inherited-stale — makes `tryCascadeRescue()` return null, so
 * control falls to `nova_forced_vertex_unavailable` and Nova is forced to
 * carry a language it cannot speak. It then answers in ENGLISH, in a
 * language-flavoured voice (pt -> carolina, pl -> tina), which is exactly
 * what was reported.
 *
 * This is the VTID-03513 failure shape: config that exists only in live AWS
 * state, invisible to review, and therefore unverifiable and silently
 * reversible by the next deploy.
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW = path.resolve(
  __dirname,
  '../../../../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
);

const yml = fs.readFileSync(WORKFLOW, 'utf8');

describe('VTID-03720: staging pins ORB_CASCADED_VOICE_ENABLED', () => {
  it('upserts the flag as the exact string "true"', () => {
    // Exact string, because isCascadedVoiceEnabled() compares === 'true'.
    expect(yml).toMatch(
      /\{name:"ORB_CASCADED_VOICE_ENABLED", value:"true"\}/,
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
    expect(strip).toContain('"ORB_CASCADED_VOICE_ENABLED"');
  });

  it('keeps the flag it is useless without', () => {
    // VERTEX_LIVE_UNAVAILABLE gates the branch ABOVE the cascade: with it
    // unset the selector returns {provider:'vertex'} and returns before
    // tryCascadeRescue is ever consulted, so the cascade flag does nothing.
    // These two must ship together or neither has any effect.
    expect(yml).toMatch(/\{name:"VERTEX_LIVE_UNAVAILABLE", value:"true"\}/);
  });

  it('keeps Polly strict, so a TTS gap fails loudly instead of reaching for dead Google', () => {
    expect(yml).toMatch(/\{name:"TTS_POLLY_STRICT", value:"true"\}/);
    expect(yml).toMatch(/\{name:"TTS_PROVIDER", value:"polly"\}/);
  });
});
