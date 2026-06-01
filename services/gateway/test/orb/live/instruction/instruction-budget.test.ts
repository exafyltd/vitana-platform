/**
 * BOOTSTRAP-ORB-R0-INSTRUCTION-CAP — unit tests for the aggregate instruction
 * byte-budget guard. The guard is the R0 fix: it prevents the assembled Vertex
 * Live `system_instruction` from exceeding the ~32 KB setup budget that, when
 * breached, causes Vertex to close the handshake (WS 1009/1007) → silent ORB.
 *
 * Pure helper → exhaustive, network-free coverage:
 *   - under budget = no-op (text + bytes unchanged, nothing trimmed)
 *   - over budget = trims bootstrap FIRST, then history, then specialist
 *   - scaffold + override are NEVER trimmed (preserved as long as possible)
 *   - trim order is honored and stops as soon as it fits
 *   - byte accounting is UTF-8 (multi-byte chars counted by bytes, not length)
 *   - inputs are not mutated
 */

import {
  enforceInstructionBudget,
  decomposeInstructionSections,
  byteLength,
  INSTRUCTION_TOTAL_BYTE_BUDGET,
  BOOTSTRAP_CONTEXT_START_MARKER,
  INSTRUCTION_MARKERS,
  SECTION_TRIM_SENTINEL,
  type InstructionSection,
  type InstructionSectionKind,
} from '../../../../src/orb/live/instruction/instruction-budget';

const rep = (s: string, n: number): string => s.repeat(n);

/** Concatenate decomposed sections back to a single string. */
const reassemble = (sections: InstructionSection[]): string =>
  sections.map((s) => s.text).join('');

/** Sum of bytes for sections of a given kind. */
const bytesOfKind = (sections: InstructionSection[], kind: InstructionSectionKind): number =>
  sections.filter((s) => s.kind === kind).reduce((n, s) => n + byteLength(s.text), 0);

describe('byteLength', () => {
  it('counts ASCII as 1 byte per char', () => {
    expect(byteLength('hello')).toBe(5);
  });

  it('counts multi-byte UTF-8 characters by BYTES, not string length', () => {
    // 'ä' is 2 bytes in UTF-8; '世' is 3 bytes. JS .length would under-count.
    expect(byteLength('ä')).toBe(2);
    expect(byteLength('世界')).toBe(6);
    expect('ä'.length).toBe(1); // sanity: why length is the wrong measure
  });

  it('treats null/undefined/empty as zero bytes', () => {
    expect(byteLength('')).toBe(0);
    // @ts-expect-error exercising the defensive null path
    expect(byteLength(undefined)).toBe(0);
    // @ts-expect-error exercising the defensive null path
    expect(byteLength(null)).toBe(0);
  });
});

describe('enforceInstructionBudget — under budget (no-op)', () => {
  it('returns the assembled text unchanged when within budget', () => {
    const sections: InstructionSection[] = [
      { kind: 'scaffold', text: 'SCAFFOLD ' },
      { kind: 'bootstrap', text: 'BOOTSTRAP ' },
      { kind: 'history', text: 'HISTORY ' },
      { kind: 'override', text: 'OVERRIDE' },
    ];
    const r = enforceInstructionBudget(sections, 10_000);
    expect(r.text).toBe('SCAFFOLD BOOTSTRAP HISTORY OVERRIDE');
    expect(r.trimmedSections).toEqual([]);
    expect(r.totalBytesBefore).toBe(byteLength(r.text));
    expect(r.totalBytesAfter).toBe(r.totalBytesBefore);
  });

  it('reports per-section byte sizes even on the happy path', () => {
    const sections: InstructionSection[] = [
      { kind: 'scaffold', text: 'abc' },
      { kind: 'bootstrap', text: 'défg' }, // é = 2 bytes → 5 bytes
    ];
    const r = enforceInstructionBudget(sections, 10_000);
    expect(r.sectionBytes.scaffold).toBe(3);
    expect(r.sectionBytes.bootstrap).toBe(5);
  });

  it('is a no-op exactly at the budget boundary', () => {
    const text = rep('x', 100);
    const r = enforceInstructionBudget([{ kind: 'bootstrap', text }], 100);
    expect(r.trimmedSections).toEqual([]);
    expect(r.text).toBe(text);
  });
});

describe('enforceInstructionBudget — over budget (priority trimming)', () => {
  it('trims BOOTSTRAP first when dropping it alone brings the total under budget', () => {
    const sections: InstructionSection[] = [
      { kind: 'scaffold', text: rep('S', 100) },
      { kind: 'bootstrap', text: rep('B', 5000) },
      { kind: 'history', text: rep('H', 100) },
      { kind: 'specialist', text: rep('T', 100) },
      { kind: 'override', text: rep('O', 100) },
    ];
    const r = enforceInstructionBudget(sections, 1000);
    expect(r.trimmedSections).toEqual(['bootstrap']);
    // bootstrap replaced by sentinel; everything else intact
    expect(r.text).toContain(SECTION_TRIM_SENTINEL('bootstrap'));
    expect(r.text).toContain(rep('S', 100));
    expect(r.text).toContain(rep('H', 100));
    expect(r.text).toContain(rep('T', 100));
    expect(r.text).toContain(rep('O', 100));
    expect(r.text).not.toContain(rep('B', 5000));
    expect(r.totalBytesAfter).toBeLessThanOrEqual(1000);
  });

  it('preserves scaffold + override; trims bootstrap then history in order', () => {
    const sections: InstructionSection[] = [
      { kind: 'scaffold', text: rep('S', 200) },
      { kind: 'bootstrap', text: rep('B', 4000) },
      { kind: 'history', text: rep('H', 4000) },
      { kind: 'override', text: rep('O', 200) },
    ];
    const r = enforceInstructionBudget(sections, 1000);
    // Dropping bootstrap alone (still ~4000 history) is not enough → history too.
    expect(r.trimmedSections).toEqual(['bootstrap', 'history']);
    // scaffold + override survive verbatim — turn-1 authority intact.
    expect(r.text).toContain(rep('S', 200));
    expect(r.text).toContain(rep('O', 200));
    expect(r.text).not.toContain(rep('B', 4000));
    expect(r.text).not.toContain(rep('H', 4000));
    expect(r.totalBytesAfter).toBeLessThanOrEqual(1000);
  });

  it('escalates to specialist only after bootstrap AND history are insufficient', () => {
    const sections: InstructionSection[] = [
      { kind: 'scaffold', text: rep('S', 100) },
      { kind: 'bootstrap', text: rep('B', 3000) },
      { kind: 'history', text: rep('H', 3000) },
      { kind: 'specialist', text: rep('T', 3000) },
      { kind: 'override', text: rep('O', 100) },
    ];
    const r = enforceInstructionBudget(sections, 500);
    expect(r.trimmedSections).toEqual(['bootstrap', 'history', 'specialist']);
    expect(r.text).toContain(rep('S', 100));
    expect(r.text).toContain(rep('O', 100));
    expect(r.totalBytesAfter).toBeLessThanOrEqual(500);
  });

  it('stops trimming as soon as the total fits (does not over-trim)', () => {
    const sections: InstructionSection[] = [
      { kind: 'scaffold', text: rep('S', 100) },
      { kind: 'bootstrap', text: rep('B', 5000) },
      { kind: 'history', text: rep('H', 100) },
      { kind: 'specialist', text: rep('T', 100) },
      { kind: 'override', text: rep('O', 100) },
    ];
    const r = enforceInstructionBudget(sections, 1000);
    // bootstrap alone is enough → history + specialist are untouched.
    expect(r.trimmedSections).toEqual(['bootstrap']);
    expect(r.text).toContain(rep('H', 100));
    expect(r.text).toContain(rep('T', 100));
  });

  it('NEVER trims scaffold/override even when preserved-only exceeds budget (fails loudly)', () => {
    const sections: InstructionSection[] = [
      { kind: 'scaffold', text: rep('S', 5000) },
      { kind: 'override', text: rep('O', 5000) },
    ];
    const r = enforceInstructionBudget(sections, 1000);
    // Nothing trimmable → no trims, scaffold+override intact, over budget.
    expect(r.trimmedSections).toEqual([]);
    expect(r.text).toBe(rep('S', 5000) + rep('O', 5000));
    expect(r.totalBytesAfter).toBeGreaterThan(1000); // observable failure for the caller to log
  });
});

describe('enforceInstructionBudget — byte accounting + immutability', () => {
  it('measures budget in UTF-8 bytes, not JS string length', () => {
    // 600 'ä' chars = 1200 bytes but length 600. With a 1000-BYTE budget this
    // must trim even though .length (600) is under 1000.
    const sections: InstructionSection[] = [
      { kind: 'scaffold', text: 'X' },
      { kind: 'bootstrap', text: rep('ä', 600) },
    ];
    const r = enforceInstructionBudget(sections, 1000);
    expect(r.totalBytesBefore).toBe(1 + 1200);
    expect(r.trimmedSections).toEqual(['bootstrap']);
    expect(r.sectionBytes.bootstrap).toBe(1200);
  });

  it('does not mutate the input sections array or its strings', () => {
    const sections: InstructionSection[] = [
      { kind: 'scaffold', text: 'S' },
      { kind: 'bootstrap', text: rep('B', 5000) },
    ];
    const snapshot = JSON.stringify(sections);
    enforceInstructionBudget(sections, 100);
    expect(JSON.stringify(sections)).toBe(snapshot);
  });

  it('uses the 30 KB default budget when none is supplied', () => {
    expect(INSTRUCTION_TOTAL_BYTE_BUDGET).toBe(30_720);
    const under = enforceInstructionBudget([
      { kind: 'bootstrap', text: rep('B', 20_000) },
    ]);
    expect(under.trimmedSections).toEqual([]);
    const over = enforceInstructionBudget([
      { kind: 'bootstrap', text: rep('B', 40_000) },
    ]);
    expect(over.trimmedSections).toEqual(['bootstrap']);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// decomposeInstructionSections — the R0 send-site fix.
//
// Builds realistic assembled-instruction fixtures from the SAME stable markers
// the builders emit, then asserts the decomposition makes bootstrap + specialist
// individually trimmable while scaffold + override stay preserved.
// ──────────────────────────────────────────────────────────────────────────

const M = INSTRUCTION_MARKERS;

/** A static scaffold head: role headers, persona, tools, greeting rules. */
const scaffoldHead = (n = 200): string =>
  `=== AUTHORITATIVE USER ROLE ===\nROLE: community\n===\n\nYou are Vitana.\n\nTOOLS:\n${rep('t', n)}\n\nIMPORTANT:\n- real-time voice.`;

/** The navigator + temporal + proactive tail (preserved scaffold). */
const scaffoldTail = (n = 200): string =>
  `\n\n${M.NAVIGATOR_PREFIX} NAVIGATION GUIDE MODE ===\n${rep('n', n)}\n\n## TEMPORAL AND JOURNEY CONTEXT\n${rep('j', n)}\n\n## PROACTIVE OPENER OVERRIDE\n${rep('p', n)}`;

const historyBlock = (n = 100): string =>
  `\n\n${M.HISTORY_OPEN}\nrecent turns:\n${rep('h', n)}\n${M.HISTORY_CLOSE}`;

const specialistBlock = (n = 100): string =>
  `\n\n${M.SPECIALIST_CONTEXT}\nName: Test\n${rep('s', n)}`;

const overrideBlock = (n = 60): string =>
  `\n\n${M.WAKE_BRIEF_OVERRIDE}\n## SPOKEN FIRST UTTERANCE\n${rep('o', n)}`;

const teacherBlock = (n = 80): string =>
  `\n\n${M.TEACHER_MODE_OPEN}\nteach...\n${rep('T', n)}\n${M.TEACHER_MODE_CLOSE}`;

/** Brain bootstrap proper — appended right after the bootstrap-start marker. */
const brainBootstrap = (n = 100): string =>
  `\n\n## USER CONTEXT PROFILE\n[ACTIVITY_14D] ...\n${rep('b', n)}`;

describe('decomposeInstructionSections — structure', () => {
  it('marks the bootstrap region trimmable instead of lumping it into scaffold (R0 fix)', () => {
    // Full authenticated assembly: head · MARKER · brain · specialist ·
    // override · teacher · history · tail. NO conversation history needed to
    // make the bootstrap trimmable.
    const text =
      scaffoldHead() +
      `\n\n${BOOTSTRAP_CONTEXT_START_MARKER}` +
      brainBootstrap() +
      specialistBlock() +
      overrideBlock() +
      teacherBlock() +
      historyBlock() +
      scaffoldTail();

    const sections = decomposeInstructionSections(text);

    // Byte-for-byte round-trip: decomposition must lose nothing.
    expect(reassemble(sections)).toBe(text);

    // Bootstrap is now its OWN trimmable kind (the R0 bug had it inside scaffold).
    expect(bytesOfKind(sections, 'bootstrap')).toBeGreaterThan(0);
    // Specialist (USER CONTEXT + teacher) is trimmable.
    expect(bytesOfKind(sections, 'specialist')).toBeGreaterThan(0);
    // History is trimmable.
    expect(bytesOfKind(sections, 'history')).toBeGreaterThan(0);
    // Override (wake-brief) is preserved.
    expect(bytesOfKind(sections, 'override')).toBeGreaterThan(0);
    // Scaffold head + tail are preserved.
    expect(bytesOfKind(sections, 'scaffold')).toBeGreaterThan(0);
  });

  it('keeps the bootstrap-start marker on the preserved scaffold (never a lone survivor)', () => {
    const text =
      scaffoldHead() + `\n\n${BOOTSTRAP_CONTEXT_START_MARKER}` + brainBootstrap() + scaffoldTail();
    const sections = decomposeInstructionSections(text);
    // The marker rides with a scaffold section, not the bootstrap section.
    const scaffoldText = sections.filter((s) => s.kind === 'scaffold').map((s) => s.text).join('');
    const bootstrapText = sections.filter((s) => s.kind === 'bootstrap').map((s) => s.text).join('');
    expect(scaffoldText).toContain(BOOTSTRAP_CONTEXT_START_MARKER);
    expect(bootstrapText).not.toContain(BOOTSTRAP_CONTEXT_START_MARKER);
  });

  it('assigns specialist (USER CONTEXT) and teacher to the specialist kind, override to override', () => {
    const text =
      scaffoldHead() +
      `\n\n${BOOTSTRAP_CONTEXT_START_MARKER}` +
      brainBootstrap() +
      specialistBlock() +
      overrideBlock() +
      teacherBlock() +
      scaffoldTail();
    const sections = decomposeInstructionSections(text);
    const specialistText = sections.filter((s) => s.kind === 'specialist').map((s) => s.text).join('');
    const overrideText = sections.filter((s) => s.kind === 'override').map((s) => s.text).join('');
    expect(specialistText).toContain(M.SPECIALIST_CONTEXT);
    expect(specialistText).toContain(M.TEACHER_MODE_OPEN);
    expect(overrideText).toContain(M.WAKE_BRIEF_OVERRIDE);
    // The override must NOT be lumped into specialist (it is preserved).
    expect(specialistText).not.toContain(M.WAKE_BRIEF_OVERRIDE);
  });

  it('round-trips when there is no history block (bootstrap still trimmable)', () => {
    const text =
      scaffoldHead() + `\n\n${BOOTSTRAP_CONTEXT_START_MARKER}` + brainBootstrap(500) + scaffoldTail();
    const sections = decomposeInstructionSections(text);
    expect(reassemble(sections)).toBe(text);
    expect(bytesOfKind(sections, 'bootstrap')).toBeGreaterThan(0);
    expect(bytesOfKind(sections, 'history')).toBe(0);
  });

  it('falls back to all-scaffold + history when no bootstrap-start marker is present (anonymous path)', () => {
    // Anonymous / persona-override sessions never emit the bootstrap marker.
    const text = scaffoldHead() + historyBlock() + scaffoldTail();
    const sections = decomposeInstructionSections(text);
    expect(reassemble(sections)).toBe(text);
    expect(bytesOfKind(sections, 'bootstrap')).toBe(0);
    expect(bytesOfKind(sections, 'specialist')).toBe(0);
    // History stays trimmable even on the fallback path.
    expect(bytesOfKind(sections, 'history')).toBeGreaterThan(0);
  });

  it('returns [] for empty input', () => {
    expect(decomposeInstructionSections('')).toEqual([]);
    // @ts-expect-error defensive null path
    expect(decomposeInstructionSections(undefined)).toEqual([]);
  });
});

describe('decomposeInstructionSections + enforceInstructionBudget — R0 end-to-end', () => {
  it('trims the bootstrap when it ALONE pushes the aggregate over budget (no history present)', () => {
    // This is the exact R0 scenario Codex flagged: a heavy user whose ~12 KB
    // bootstrap + scaffold exceeds budget BEFORE any conversation history
    // exists. Pre-fix the bootstrap lived inside the preserved scaffold and was
    // un-trimmable → oversized setup sent → silent ORB.
    const budget = 5_000;
    const heavyBootstrap = brainBootstrap(20_000); // ~20 KB bootstrap alone
    const text =
      scaffoldHead() +
      `\n\n${BOOTSTRAP_CONTEXT_START_MARKER}` +
      heavyBootstrap +
      overrideBlock() +
      scaffoldTail();

    const sections = decomposeInstructionSections(text);
    expect(byteLength(reassemble(sections))).toBeGreaterThan(budget); // genuinely over

    const result = enforceInstructionBudget(sections, budget);
    // Bootstrap is dropped first and that brings the assembly under budget.
    expect(result.trimmedSections).toEqual(['bootstrap']);
    expect(result.totalBytesAfter).toBeLessThanOrEqual(budget);
    // Preserved scaffold + the turn-1 wake-brief override survive verbatim.
    expect(result.text).toContain(M.WAKE_BRIEF_OVERRIDE);
    expect(result.text).toContain(M.NAVIGATOR_PREFIX);
    expect(result.text).toContain('=== AUTHORITATIVE USER ROLE ===');
    expect(result.text).toContain(SECTION_TRIM_SENTINEL('bootstrap'));
    // The heavy bootstrap body is gone.
    expect(result.text).not.toContain(rep('b', 20_000));
  });

  it('drops bootstrap → history → specialist in order, keeping override + scaffold', () => {
    const budget = 4_000;
    const text =
      scaffoldHead(300) +
      `\n\n${BOOTSTRAP_CONTEXT_START_MARKER}` +
      brainBootstrap(6_000) +
      specialistBlock(6_000) +
      overrideBlock(200) +
      historyBlock(6_000) +
      scaffoldTail(300);

    const sections = decomposeInstructionSections(text);
    const result = enforceInstructionBudget(sections, budget);

    // bootstrap first, then history, then specialist — until it fits.
    expect(result.trimmedSections).toEqual(['bootstrap', 'history', 'specialist']);
    expect(result.totalBytesAfter).toBeLessThanOrEqual(budget);
    // Override + scaffold tail/head preserved.
    expect(result.text).toContain(M.WAKE_BRIEF_OVERRIDE);
    expect(result.text).toContain(M.NAVIGATOR_PREFIX);
  });

  it('fails open (best-effort send) when even preserved-only exceeds budget', () => {
    // Pathological: scaffold + override alone blow the budget. Nothing trimmable
    // can help — the guard returns the over-budget text so the caller logs
    // loudly and sends best-effort rather than corrupting the scaffold.
    const budget = 1_000;
    const text =
      scaffoldHead(5_000) + // huge static scaffold
      `\n\n${BOOTSTRAP_CONTEXT_START_MARKER}` +
      brainBootstrap(100) +
      overrideBlock(5_000) + // huge preserved override
      scaffoldTail(5_000);

    const sections = decomposeInstructionSections(text);
    const result = enforceInstructionBudget(sections, budget);

    // Bootstrap is the only trimmable section here and dropping it is not enough.
    expect(result.trimmedSections).toEqual(['bootstrap']);
    expect(result.totalBytesAfter).toBeGreaterThan(budget); // observable failure → caller logs
    // Override + scaffold never dropped even though we are still over budget.
    expect(result.text).toContain(M.WAKE_BRIEF_OVERRIDE);
    expect(result.text).toContain('=== AUTHORITATIVE USER ROLE ===');
    expect(result.text).toContain(M.NAVIGATOR_PREFIX);
  });

  it('is a no-op when the full assembly is comfortably under budget', () => {
    const text =
      scaffoldHead() +
      `\n\n${BOOTSTRAP_CONTEXT_START_MARKER}` +
      brainBootstrap() +
      specialistBlock() +
      overrideBlock() +
      historyBlock() +
      scaffoldTail();
    const sections = decomposeInstructionSections(text);
    const result = enforceInstructionBudget(sections); // default 30 KB budget
    expect(result.trimmedSections).toEqual([]);
    expect(result.text).toBe(text); // byte-identical, nothing touched
  });
});
