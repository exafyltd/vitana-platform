/**
 * VTID-04172: detectSimulatedToolCallReply — pure detection of a real,
 * observed Operator Console failure: the model narrates a tool call as
 * fenced JSON instead of actually invoking it.
 */

import { detectSimulatedToolCallReply } from '../src/services/operator-simulated-tool-call-detector';

// The exact shape observed live 2026-09-20: a fenced ```json block with
// title/request keys matching autopilot_run_task's real arguments, and no
// real autopilot_run_task tool call in the turn's toolResults.
const REAL_OBSERVED_REPLY = `I'll queue this as a governed Dev Autopilot execution — the agent allocates its own VTID.

**Tool: autopilot_run_task**

\`\`\`json
{
  "title": "Command Hub: regression test asserting the /command-hub/ static route never serves *.backup*, *.backup, or debug.html",
  "request": "Add a regression test to services/gateway/test/command-hub/ ..."
}
\`\`\`

I'm not going to pretend the call result — let me run it.

Hmm, but I don't actually have a real tool execution here; I'm the assistant presenting results.`;

describe('detectSimulatedToolCallReply (VTID-04172)', () => {
  it('detects the real observed failure: a fenced JSON block shaped like autopilot_run_task with no real call', () => {
    const result = detectSimulatedToolCallReply(REAL_OBSERVED_REPLY, ['dev_read_file']);
    expect(result.detected).toBe(true);
    expect(result.toolName).toBe('autopilot_run_task');
    expect(result.reason).toContain('autopilot_run_task');
  });

  it('does NOT flag the same JSON shape when autopilot_run_task actually ran this turn', () => {
    const result = detectSimulatedToolCallReply(REAL_OBSERVED_REPLY, ['dev_read_file', 'autopilot_run_task']);
    expect(result.detected).toBe(false);
  });

  it('detects autopilot_execute_task narration the same way', () => {
    const reply = [
      'Here is what I would run:',
      '```json',
      JSON.stringify({ vtid: 'VTID-99999', files_referenced: ['services/gateway/src/x.ts'] }),
      '```',
    ].join('\n');
    const result = detectSimulatedToolCallReply(reply, []);
    expect(result.detected).toBe(true);
    expect(result.toolName).toBe('autopilot_execute_task');
  });

  it('does not flag ordinary replies with no fenced JSON at all', () => {
    expect(detectSimulatedToolCallReply('Sure, here is the status of VTID-04132: in_progress.', []).detected).toBe(false);
  });

  it('does not flag a fenced JSON block unrelated to any tool-call shape', () => {
    const reply = '```json\n{"foo": "bar", "count": 3}\n```';
    expect(detectSimulatedToolCallReply(reply, []).detected).toBe(false);
  });

  it('does not flag malformed/unparseable JSON in a fence', () => {
    const reply = '```json\n{ this is not valid json, title: "x", request: "y" }\n```';
    expect(detectSimulatedToolCallReply(reply, []).detected).toBe(false);
  });

  it('does not flag an array in a fence (not an object)', () => {
    const reply = '```json\n["title", "request"]\n```';
    expect(detectSimulatedToolCallReply(reply, []).detected).toBe(false);
  });

  it('handles empty reply text', () => {
    expect(detectSimulatedToolCallReply('', []).detected).toBe(false);
  });

  it('requires ALL shape keys present — a partial match (title only) is not flagged', () => {
    const reply = '```json\n{"title": "Something"}\n```';
    expect(detectSimulatedToolCallReply(reply, []).detected).toBe(false);
  });
});
