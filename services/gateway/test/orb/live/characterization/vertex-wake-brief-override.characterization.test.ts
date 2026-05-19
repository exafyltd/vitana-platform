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
