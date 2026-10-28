/**
 * VTID-04258 — NAV_CONTINUATION_BIND must be pinned true on both the
 * staging and prod gateway deploy workflows, not left to inherit whatever a
 * prior task definition happened to carry.
 *
 * Root cause of the recurring live report ("Vitana offers to open a page, I
 * say yes/do it, it just goes to listening mode; I repeat it, it says 'okay,
 * opening it for you' and STILL does nothing — loops forever"): this is a
 * genuine Nova Sonic tool-calling compliance gap (the model verbally commits
 * to calling navigate/navigate_to_screen on a bare confirmation but does not
 * always actually emit the tool call — see live-tool-catalog.ts's own
 * "CONFIRMING A DESTINATION YOU JUST OFFERED" instruction, which alone did
 * not fix it). A deterministic, code-level backstop for exactly this shape
 * already exists — services/assistant-continuation/acceptance-gate.ts's
 * detectAcceptance()/maybeBindAcceptance(), wired into
 * upstream-message-handler.ts's handleTurnComplete at both the WS and SSE
 * call sites — but it only ever activates behind
 * `process.env.NAV_CONTINUATION_BIND === 'true'`, and NO deploy workflow
 * ever set that value: AWS-STAGE-DEPLOY-GATEWAY.yml's own checklist comment
 * (§ "Feature flags") listed it as something that "should" be set, while its
 * actual jq strip/re-add block never touched it, and
 * docs/AWS-PRODUCTION-HANDOVER.md records it only as a bare env var NAME on
 * a live task def with no confirmed value. Without the flag, every
 * navigation confirmation depended entirely on Nova re-calling the tool —
 * the exact compliance gap that produces the reported loop.
 *
 * The gate is deliberately safe to pin everywhere at once, unlike most
 * flags in these workflows that stage on staging-only first:
 *   - Fails open by construction — maybeBindAcceptance() catches every
 *     error and returns null, which falls through to the unchanged LLM
 *     turn (see acceptance-gate.ts's own doc comment).
 *   - One-shot consumed (readPendingCta + clearPendingCta before use), so
 *     it cannot double-fire on a repeated "yes".
 *   - Only ever acts when BOTH a live pending_cta exists in
 *     orb_session_state AND the utterance parses as a short, clean
 *     affirmation with no negation/redirect word — it never fabricates an
 *     action from nothing.
 *
 * Pinned the same way VTID-03779 pinned FEATURE_ORB_NOVA_PREWARM_ENV:
 * present in both the strip list and the re-add list with the exact string
 * value the flag's own `=== 'true'` check requires, so a future edit that
 * drops one half cannot silently regress the mechanism back to a no-op.
 */

import * as fs from 'fs';
import * as path from 'path';

const STAGE_WORKFLOW = path.resolve(
  __dirname,
  '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
);
const PROD_WORKFLOW = path.resolve(
  __dirname,
  '../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml',
);

const stageYml = fs.readFileSync(STAGE_WORKFLOW, 'utf8');
const prodYml = fs.readFileSync(PROD_WORKFLOW, 'utf8');

describe('VTID-04258: NAV_CONTINUATION_BIND is pinned true on staging and prod', () => {
  it('staging: upserts the flag as exact string "true"', () => {
    expect(stageYml).toMatch(/\{name:"NAV_CONTINUATION_BIND", value:"true"\}/);
  });

  it('staging: strips the inherited value first, so a stale one cannot survive', () => {
    // Without this, the re-add would append a DUPLICATE key alongside the
    // inherited one, and which wins is not something to leave to chance —
    // the same defect class VTID-03779's sibling test guards.
    const stripBlock = stageYml.slice(
      stageYml.indexOf('.containerDefinitions[0].environment |='),
      stageYml.indexOf('.containerDefinitions[0].secrets |='),
    );
    const strip = stripBlock.slice(0, stripBlock.indexOf('| not) ]'));
    expect(strip).toContain('"NAV_CONTINUATION_BIND"');
  });

  it('prod: upserts the flag as exact string "true", declared not dispatched', () => {
    // Declaring it here does not itself change production — per IF-THEN 26,
    // this block only takes effect the next time an owner dispatches this
    // workflow (PUBLISH or a deliberate manual run). See VTID-04230's own
    // sibling block immediately above this one for the same posture.
    expect(prodYml).toMatch(/\{name:"NAV_CONTINUATION_BIND", value:"true"\}/);
  });

  it('prod: strips the inherited value before re-adding it, in that order', () => {
    const markerIdx = prodYml.indexOf('# VTID-04258');
    expect(markerIdx).toBeGreaterThan(-1);
    const block = prodYml.slice(markerIdx, markerIdx + 1400);
    const stripIdx = block.indexOf('select(.name | IN("NAV_CONTINUATION_BIND") | not)');
    const addIdx = block.indexOf('{name:"NAV_CONTINUATION_BIND", value:"true"}');
    expect(stripIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(stripIdx);
  });

  it('the pinned jq block on prod has balanced parens (no stray paren the shell would choke on)', () => {
    const markerIdx = prodYml.indexOf('# VTID-04258');
    const jqLineIdx = prodYml.indexOf("jq '", markerIdx);
    const jqEndIdx = prodYml.indexOf("')", jqLineIdx);
    const jqBody = prodYml.slice(jqLineIdx + 4, jqEndIdx);
    const opens = (jqBody.match(/\(/g) ?? []).length;
    const closes = (jqBody.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});
