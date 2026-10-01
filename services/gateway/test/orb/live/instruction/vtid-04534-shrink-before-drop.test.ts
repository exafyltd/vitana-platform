/**
 * VTID-04534 — the instruction budget shrinks member context and history
 * before it drops either, and the fixed prompt leaves room for both.
 *
 * Owner report 2026-09-25 (staging): after the ORB reopened, Vitana did not
 * know what had just been said. The static scaffold alone (~31.5 K) exceeded
 * the 30 KB budget, so the guard dropped the member context (106/133 sessions
 * over 7 days) and the conversation history (8/9 that day) whole.
 */
import {
  enforceInstructionBudget,
  decomposeInstructionSections,
  shrinkHistoryToBytes,
  shrinkBootstrapToBytes,
  byteLength,
  instructionBudgetDiagPayload,
  INSTRUCTION_MARKERS as M,
  INSTRUCTION_TOTAL_BYTE_BUDGET,
  BOOTSTRAP_CONTEXT_START_MARKER,
  SECTION_TRIM_FLOORS,
  HISTORY_EARLIER_TURNS_OMITTED,
  SECTION_TRIM_SENTINEL,
} from '../../../../src/orb/live/instruction/instruction-budget';
import { buildLiveSystemInstruction } from '../../../../src/orb/live/instruction/live-system-instruction';

function history(turns: number): string {
  const lines = Array.from({ length: turns }, (_, i) => (i % 2 ? `Vitana: answer number ${i} ` : `User: question number ${i} `) + 'x'.repeat(120));
  return `\n\n${M.HISTORY_OPEN}\nThe following is the recent conversation from this session.\n${lines.join('\n')}\n${M.HISTORY_CLOSE}`;
}

describe('VTID-04534 — shrinkHistoryToBytes keeps the most recent turns', () => {
  const block = history(40);

  test('keeps the tags, the preamble and the newest turns; marks the cut', () => {
    const out = shrinkHistoryToBytes(block, 1_500)!;
    expect(byteLength(out)).toBeLessThanOrEqual(1_500);
    expect(out).toContain(M.HISTORY_OPEN);
    expect(out).toContain(M.HISTORY_CLOSE);
    expect(out).toContain('The following is the recent conversation');
    expect(out).toContain('answer number 39');
    expect(out).not.toContain('question number 0 ');
    expect(out).toContain(HISTORY_EARLIER_TURNS_OMITTED);
  });

  test('returns null when not a single turn fits, and on a malformed block', () => {
    expect(shrinkHistoryToBytes(block, 50)).toBeNull();
    expect(shrinkHistoryToBytes('no tags here', 5_000)).toBeNull();
  });
});

describe('VTID-04534 — shrinkBootstrapToBytes uses the priority packer', () => {
  test('fits the target and keeps pinned blocks over lower-priority text', () => {
    const boot = [
      '=== USER CONTEXT PROFILE ===', 'y'.repeat(6_000),
      '<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>', 'Opening directive for this session.',
      '=== RECENT ACTIVITY ===', 'z'.repeat(6_000),
    ].join('\n');
    const out = shrinkBootstrapToBytes(boot, 4_000);
    expect(out).not.toBeNull();
    expect(byteLength(out!)).toBeLessThanOrEqual(4_000);
    expect(out).toContain('<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>');
  });
});

describe('VTID-04534 — enforceInstructionBudget shrinks before it drops', () => {
  const scaffold = '=== AUTHORITATIVE USER ROLE ===\n' + 's'.repeat(20_000) + `\n\n${BOOTSTRAP_CONTEXT_START_MARKER}`;
  const tail = `\n\n${M.NAVIGATOR_PREFIX} NAVIGATION GUIDE MODE ===\n` + 't'.repeat(2_000);
  const boot = '\n=== USER CONTEXT PROFILE ===\n' + 'p'.repeat(5_000) + '\n=== RECENT ACTIVITY ===\n' + 'r'.repeat(5_000);

  test('the reported shape: over budget with context + history → both kept, shortened, under budget', () => {
    const text = scaffold + boot + history(40) + tail;
    const r = enforceInstructionBudget(decomposeInstructionSections(text));
    expect(r.totalBytesAfter).toBeLessThanOrEqual(INSTRUCTION_TOTAL_BYTE_BUDGET);
    expect(r.trimmedSections).toEqual([]);
    expect(r.shortenedSections).toContain('bootstrap');
    expect(r.text).toContain('answer number 39');
    expect(r.text).not.toContain(SECTION_TRIM_SENTINEL('history'));
    expect(r.text).not.toContain(SECTION_TRIM_SENTINEL('bootstrap'));
  });

  test('history is shrunk only after the member context reached its floor', () => {
    const tight = 20_000 + 2_200 + SECTION_TRIM_FLOORS.bootstrap + 1_500;
    const text = scaffold + boot + history(40) + tail;
    const r = enforceInstructionBudget(decomposeInstructionSections(text), tight);
    expect(r.shortenedSections).toEqual(['bootstrap', 'history']);
    expect(r.trimmedSections).toEqual([]);
    expect(r.totalBytesAfter).toBeLessThanOrEqual(tight);
    expect(r.text).toContain('answer number 39');
  });

  test('when nothing fits, sections are still dropped in the old order and the diag reports both lists', () => {
    const text = scaffold + boot + history(40) + tail;
    const r = enforceInstructionBudget(decomposeInstructionSections(text), 22_500);
    expect(r.trimmedSections).toEqual(['bootstrap', 'history']);
    expect(r.shortenedSections).toEqual([]);
    const d = instructionBudgetDiagPayload(r, 22_500);
    expect(d).toMatchObject({ trimmed: true, trimmed_sections: ['bootstrap', 'history'], shortened_sections: [] });
  });
});

describe('VTID-04534 — the fixed prompt leaves room for context and history', () => {
  test('the rewritten RULE 0 + GUIDED JOURNEY and TOOLS regions stay small', () => {
    const s = buildLiveSystemInstruction('de', 'warm', undefined, 'community');
    const seg = (a: string, z: string) => byteLength(s.slice(s.indexOf(a), s.indexOf(z, s.indexOf(a) + 1)));
    // Before VTID-04534: 11,553 and 7,133 bytes.
    expect(seg('PROACTIVE LEADERSHIP — RULE 0', 'GREETING RULES (CRITICAL)')).toBeLessThan(5_500);
    expect(seg('TOOLS:', '\nIMPORTANT:')).toBeLessThan(4_500);
  });
});
