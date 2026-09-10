/**
 * VTID-03101 — structural lock for the wake-brief override block on Vertex.
 *
 * Background:
 *   The Vertex session-start handler runs in two passes. Pass 1
 *   (`/live/session/start`) computes the wake-brief decision and stores
 *   the override block on the session. Pass 2 (WS-open) builds the
 *   setup-message and renders the system_instruction.
 *
 *   Before this fix, pass 1 stored the override by mutating
 *   `session.contextInstruction = (session.contextInstruction || '') + block`.
 *   A background bootstrap promise (vitana-brain context build, ~200-2000ms)
 *   resolved AFTER pass 1 and ran `session.contextInstruction = finalContext`
 *   — unconditionally overwriting the override. Gemini's setup message then
 *   carried NO override block, and the model fell back to its trained-default
 *   greeting ("Hello! How can I help today?"). The Teacher's permission-asking
 *   line was never spoken on Vertex.
 *
 * Fix:
 *   The override block lives on its own session field,
 *   `session.wakeBriefOverrideBlock`. The bootstrap promise only touches
 *   `contextInstruction`. The setup-message builder concatenates BOTH
 *   fields when rendering the system_instruction. No race possible.
 *
 * This file locks both ends of the contract structurally so a future
 * refactor cannot silently re-introduce the race.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildVertexWakeBriefBlock } from '../../../../src/orb/live/session/live-session-controller';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');
const CONTROLLER_PATH = path.resolve(
  __dirname,
  '../../../../src/orb/live/session/live-session-controller.ts',
);

let orbLiveSource: string;
let controllerSource: string;

beforeAll(() => {
  orbLiveSource = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
  controllerSource = fs.readFileSync(CONTROLLER_PATH, 'utf8');
});

describe('VTID-03101: GeminiLiveSession declares wakeBriefOverrideBlock', () => {
  it('orb-live.ts declares the dedicated wakeBriefOverrideBlock field on the session interface', () => {
    expect(orbLiveSource).toMatch(/wakeBriefOverrideBlock\s*\?\s*:\s*string\s*;/);
  });
});

describe('VTID-03101: controller writes the override to the dedicated field (not contextInstruction)', () => {
  it('writes the picked block to session.wakeBriefOverrideBlock', () => {
    expect(controllerSource).toMatch(
      /session\.wakeBriefOverrideBlock\s*=\s*block\s*;/,
    );
  });

  it('does NOT mutate session.contextInstruction with the override block', () => {
    // The old (racy) pattern: `session.contextInstruction = (session.contextInstruction || '') + block`
    // must not reappear. The bootstrap promise is the only writer of
    // contextInstruction at session-start; the wake-brief block goes elsewhere.
    expect(controllerSource).not.toMatch(
      /session\.contextInstruction\s*=\s*\(\s*session\.contextInstruction\s*\|\|\s*''\s*\)\s*\+\s*block/,
    );
  });
});

describe('VTID-03101: setup-message builder reads both fields when rendering system_instruction', () => {
  it('orb-live.ts concatenates session.wakeBriefOverrideBlock into the bootstrap arg passed to buildLiveSystemInstruction', () => {
    // The setup-message builder must reference wakeBriefOverrideBlock on
    // the session — otherwise the override never reaches Gemini even when
    // the controller stored it.
    expect(orbLiveSource).toMatch(/session\.wakeBriefOverrideBlock\s*\|\|\s*''/);
  });
});

// VTID-03786 (Codex P1 finding on PR #3225) — this block is injected into
// the SAME assembled Nova system instruction as buildGuidedTopicNarrationBlock
// (concatenated in orb-live.ts, both flow through session.wakeBriefOverrideBlock
// / session.guidedTopicNarrationContent into the same setup-message string).
// It fires for nearly every fresh (non-reconnect) session with a wake-brief
// winner — not just guided-topic ones — since shouldInjectWakeBriefOverrideBlock
// returns true whenever !isReconnectStart. It independently carried BOTH
// trigger-pattern classes VTID-03785/03786 already found and removed
// elsewhere: an "OVERRIDES every other rule" authority-override assertion,
// and quoted hypothetical spoken example phrases ("Wie kann ich dir
// helfen?" / "How can I help?"). Fixing only the guided-topic-narration copy
// (VTID-03786's original scope) left this — the copy that actually fires on
// literally every fresh session — untouched, which is why a live re-test
// after that fix alone still showed nova_validation blocking guided-topic
// sessions unchanged.
describe('VTID-03786: buildVertexWakeBriefBlock does not carry known Nova-filter trigger patterns', () => {
  it('does NOT assert this block overrides every other rule', () => {
    const block = buildVertexWakeBriefBlock('Hallo, hier ist dein Update.', 'de', null);
    expect(block).not.toMatch(/OVERRIDES every other/);
  });

  it('does NOT quote hypothetical spoken example phrases', () => {
    const block = buildVertexWakeBriefBlock('Hallo, hier ist dein Update.', 'de', null);
    expect(block).not.toMatch(/"Wie kann ich dir helfen\?"/);
    expect(block).not.toMatch(/"How can I help\?"/);
    expect(block).not.toMatch(/"Was steht an\?"/);
    expect(block).not.toMatch(/"Was liegt an\?"/);
  });

  it('still instructs the model to speak the wake-brief line verbatim as its first turn', () => {
    const block = buildVertexWakeBriefBlock('Hallo, hier ist dein Update.', 'de', null);
    expect(block).toContain('Hallo, hier ist dein Update.');
    expect(block).toMatch(/first spoken turn/i);
  });
});

describe('VTID-03786: LiveKit first-turn suppression directive does not carry known Nova-filter trigger patterns', () => {
  it('orb-livekit.ts does NOT assert the directive overrides every other rule', () => {
    const livekitSource = fs.readFileSync(
      path.resolve(__dirname, '../../../../src/routes/orb-livekit.ts'),
      'utf8',
    );
    expect(livekitSource).not.toMatch(/OVERRIDES every other greeting rule/);
  });

  it('orb-livekit.ts does NOT quote a hypothetical "How can I help?" example', () => {
    const livekitSource = fs.readFileSync(
      path.resolve(__dirname, '../../../../src/routes/orb-livekit.ts'),
      'utf8',
    );
    expect(livekitSource).not.toMatch(/"How can I\nhelp\?"|"How can I help\?"/);
  });
});
