/**
 * VTID-03104 — structural lock for the Teacher-opener v2 trigger.
 *
 * Background
 * ----------
 * VTID-03102 (PR #2262, reverted by #2265) replaced the legacy menu user-turn
 * with a long meta-instruction trigger:
 *
 *   "Begin your first turn now. The SPOKEN FIRST UTTERANCE block in your
 *    system instruction contains the exact line you must speak. Use that
 *    line verbatim — copy it letter-for-letter — then stop and wait for
 *    the user. Do NOT pick a phrase from any other section."
 *
 * Gemini Live either (a) interpreted the text-mode-sounding phrasing as a
 * text-only response cue, or (b) took long enough to start synthesis that
 * the AudioContext suspended. Either way: UI flipped to "Vitana speaking"
 * (chunks arrived) but no TTS audio was heard. Reverted ~25 min after
 * deploy.
 *
 * VTID-03104 takes a different shape: mirror the EXACT format the
 * temporal.wasFailure bucket already uses successfully in production
 * (`Say exactly: "Sorry about that. How can I help?" ONE short phrase
 * only. Do NOT say "Hello" or the user's name.`). The wake-brief line is
 * embedded in the user-turn directly so Gemini does not need to scan the
 * system_instruction for the SPOKEN FIRST UTTERANCE block.
 *
 * Hazards this file locks against:
 *   - Re-introducing the v1 long meta-instruction phrasing
 *   - Triggers that exceed the wasFailure pattern's working length
 *   - Trigger lines that include "verbatim", "letter-for-letter", or
 *     "stop and wait for the user" (the candidate audio-killers from v1)
 *   - Removing the line embedding so the model has to look it up again
 *   - Losing the three [VTID-WAKE-OPENER] diagnostic logs
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');

let orbLiveSource: string;

beforeAll(() => {
  orbLiveSource = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
});

function extractSendGreetingFn(): string {
  const startIdx = orbLiveSource.indexOf('function sendGreetingPromptToLiveAPI(');
  if (startIdx === -1) {
    throw new Error('sendGreetingPromptToLiveAPI not found in orb-live.ts');
  }
  const afterStart = orbLiveSource.slice(startIdx + 1);
  const nextFnRel = afterStart.search(/\nfunction\s+\w/);
  return nextFnRel === -1
    ? orbLiveSource.slice(startIdx)
    : orbLiveSource.slice(startIdx, startIdx + 1 + nextFnRel);
}

describe('VTID-03104: Teacher-opener v2 in sendGreetingPromptToLiveAPI', () => {
  let fn: string;

  beforeAll(() => {
    fn = extractSendGreetingFn();
  });

  it('reads session.wakeBriefDecision.selectedContinuation.userFacingLine (now via the Opening Contract)', () => {
    expect(fn).toMatch(/session as any\)\.wakeBriefDecision/);
    // VTID-03273 Pillar A: the wake-brief line is fed into the single
    // decideOpening authority, and the spoken override line is read back from
    // its decision (`_openDecision.line`) — not the raw wake line directly.
    expect(fn).toMatch(/selectedContinuation\?\.userFacingLine/);
    expect(fn).toMatch(/_openDecision\.line/);
  });

  it('only fires the override branch when the line is non-empty AND session is NOT anonymous', () => {
    // Anonymous sessions have their own intro speech (anonPrompts above);
    // wake-brief should never short-circuit that.
    expect(fn).toMatch(
      /wakeOverrideLine[\s\S]{0,200}length\s*>\s*0[\s\S]{0,200}!session\.isAnonymous/,
    );
  });

  it('embeds the line directly in the user-turn via `Say exactly: "..."` (the proven wasFailure pattern)', () => {
    // English form — line is interpolated as ${safe} inside double quotes.
    expect(fn).toMatch(/Say exactly: "\$\{safe\}"/);
    // German form — same idea, localized.
    expect(fn).toMatch(/Sage genau Folgendes: "\$\{safe\}"/);
    // Escape pass so embedded quotes in the line can't terminate the wrapper.
    expect(fn).toMatch(/wakeOverrideLine\.replace\(\/"\/g, '\\\\"'\)/);
  });

  it('does NOT re-introduce any v1 (VTID-03102) phrasing that broke audio', () => {
    // The exact phrases from the reverted trigger.
    expect(fn).not.toMatch(/Use that line verbatim/);
    expect(fn).not.toMatch(/copy it letter-for-letter/);
    expect(fn).not.toMatch(/stop and wait for the user/);
    expect(fn).not.toMatch(/Begin your first turn now/);
    // The v1 prompt referenced the SPOKEN FIRST UTTERANCE block in the
    // user-turn so the model would scan the system_instruction for it.
    // v2 inlines the line, so the user-turn must not reference the block.
    const overrideBranchMatch = fn.match(
      /if\s*\(wakeOverrideLine[\s\S]+?return true;\s*\n\s\s\}/,
    );
    expect(overrideBranchMatch).not.toBeNull();
    const overrideBranch = overrideBranchMatch![0];
    expect(overrideBranch).not.toMatch(/SPOKEN FIRST UTTERANCE/);
  });

  it('keeps the override trigger compact — no per-lang trigger exceeds the wasFailure-template length budget', () => {
    // wasFailure prompt is ~155 chars + line. v2 lang prompts wrap an
    // 80-150 char line in <200 chars of localized instruction text.
    // We cap the localized template text at 300 chars per lang to keep
    // the total trigger near the working-pattern length.
    const triggerObjMatch = fn.match(/wakeTriggerByLang:[\s\S]*?Record<string,\s*string>\s*=\s*\{([\s\S]*?)\n\s\s\s\s\};/);
    expect(triggerObjMatch).not.toBeNull();
    const triggerBody = triggerObjMatch![1];
    // Each lang entry: `lang: \`...\`,`  We measure the template string only.
    const langTemplates = triggerBody.match(/`[^`]*`/g) || [];
    expect(langTemplates.length).toBeGreaterThanOrEqual(8);
    for (const tpl of langTemplates) {
      expect(tpl.length).toBeLessThan(300);
    }
  });

  it('does NOT fall through to the legacy menu when an override line is present (line is in user-turn AND triggers return true)', () => {
    const overrideBranchMatch = fn.match(
      /if\s*\(wakeOverrideLine[\s\S]+?return true;\s*\n\s\s\}/,
    );
    expect(overrideBranchMatch).not.toBeNull();
    const overrideBranch = overrideBranchMatch![0];
    // The override branch must end with `return true;` so the legacy
    // bucket dispatch below it cannot execute and send a competing menu.
    expect(overrideBranch).toMatch(/return true;\s*\n\s\s\}\s*$/);
    // ws.send must fire inside the branch — otherwise the watchdog
    // arms but Gemini never receives the trigger.
    expect(overrideBranch).toMatch(/ws\.send\(JSON\.stringify\(wakeMessage\)\)/);
    // greetingSent must be set so stall-recovery does not re-send the
    // legacy menu later.
    expect(overrideBranch).toMatch(/session\.greetingSent\s*=\s*true/);
    // Watchdog must still arm — we ARE waiting on the model.
    expect(overrideBranch).toMatch(/startResponseWatchdog\(/);
  });

  it('legacy menu path remains intact for sessions without a wake-brief override', () => {
    expect(fn).toMatch(/pick ONE of: "Let me show you where we are\."/);
    expect(fn).toMatch(/ws\.send\(JSON\.stringify\(message\)\)/);
  });

  it('emits the three [VTID-WAKE-OPENER] diagnostic logs in the override branch', () => {
    const logLines = fn.match(/\[VTID-WAKE-OPENER\]/g) || [];
    expect(logLines.length).toBeGreaterThanOrEqual(3);
    expect(fn).toMatch(/path=vertex override_active=true/);
    expect(fn).toMatch(/selected_line=/);
    expect(fn).toMatch(/prompt_sent=/);
  });

  it('emits a greeting_sent diag event with wake_opener=override_v2 + decision_id', () => {
    expect(fn).toMatch(/wake_opener:\s*'override_v2'/);
    expect(fn).toMatch(/decision_id:\s*wakeBriefDecision\?\.decisionId/);
  });
});
