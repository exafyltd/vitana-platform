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
  byteLength,
  INSTRUCTION_TOTAL_BYTE_BUDGET,
  SECTION_TRIM_SENTINEL,
  type InstructionSection,
} from '../../../../src/orb/live/instruction/instruction-budget';

const rep = (s: string, n: number): string => s.repeat(n);

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
