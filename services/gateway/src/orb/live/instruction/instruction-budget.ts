/**
 * Aggregate instruction budget guard — R0 fix (BOOTSTRAP-ORB-R0-INSTRUCTION-CAP).
 *
 * THE AGGREGATE SAFETY NET. Phase A (`bootstrap-cap.ts`, #2403) caps only the
 * bootstrap sub-component of the Vertex Live `system_instruction`. But the
 * instruction is an aggregate of many independently-grown sections — static
 * scaffold, persona behavioral rules, specialist/teacher blocks, conversation
 * history, the wake-brief turn-1 override, AND the (already-capped) bootstrap.
 * For heavy users the SUM of these can still exceed the ~32 KB Vertex Live
 * setup budget even when each component is individually reasonable. When the
 * aggregate `setup` envelope is too large, Vertex closes the handshake (WS code
 * 1009 "message too big" / 1007) or never emits `setup_complete` → no TTS
 * frames → "Vitana won't talk".
 *
 * This module enforces a guarantee the per-component caps cannot: the FINAL
 * assembled instruction text never exceeds a fixed BYTE budget (UTF-8 bytes,
 * matching what the WebSocket frame actually carries — not JS string length,
 * which under-counts multi-byte German/Serbian characters).
 *
 * It is intentionally defensive, NOT optimal. When over budget it trims whole
 * named sections in a fixed PRIORITY ORDER, dropping the lowest-value context
 * first while preserving the structural scaffold and the turn-1 wake-brief
 * override (which owns the first spoken turn) as long as possible:
 *
 *   1. bootstrap context        (highest accumulation; lowest per-byte value)
 *   2. conversation history     (reconstructable; degrades gracefully)
 *   3. specialist / teacher     (turn-2+ behavior; turn-1 still works without)
 *   ── preserved as long as possible ──
 *   • static scaffold           (the prompt skeleton — never dropped here)
 *   • wake-brief override        (turn-1 authority — never dropped here)
 *
 * Pure + side-effect free so it is exhaustively unit-testable and reusable by
 * any caller. The send site (orb-live.ts envelope builder) is responsible for
 * logging the structured overflow warning when trimming occurs.
 */

/**
 * Default aggregate byte budget for the assembled `system_instruction` text.
 * 30 KB leaves headroom under the ~32 KB Vertex Live `setup` envelope budget
 * for the surrounding JSON (model path, generation_config, tools catalog,
 * transcription flags) that shares the same frame.
 */
export const INSTRUCTION_TOTAL_BYTE_BUDGET = 30_720; // 30 * 1024

/**
 * Section kinds, in DROP priority order (index 0 dropped first). The two
 * preserved kinds (`scaffold`, `override`) are never trimmed by this guard.
 */
export type InstructionSectionKind =
  | 'bootstrap'   // bootstrap / brain context — dropped first
  | 'history'     // rendered conversation history — dropped second
  | 'specialist'  // specialist / teacher behavioral blocks — dropped third
  | 'scaffold'    // static prompt skeleton — preserved
  | 'override';   // turn-1 wake-brief override — preserved

/** Order in which trimmable sections are dropped when over budget. */
const DROP_ORDER: InstructionSectionKind[] = ['bootstrap', 'history', 'specialist'];

/** Kinds this guard will never trim. */
const PRESERVED: ReadonlySet<InstructionSectionKind> = new Set<InstructionSectionKind>([
  'scaffold',
  'override',
]);

export interface InstructionSection {
  kind: InstructionSectionKind;
  /** The section's contribution to the assembled instruction. */
  text: string;
}

export interface InstructionBudgetResult {
  /** The (possibly trimmed) assembled instruction text. */
  text: string;
  /** UTF-8 byte length of the assembly before trimming. */
  totalBytesBefore: number;
  /** UTF-8 byte length of the assembly after trimming. */
  totalBytesAfter: number;
  /** Section kinds that were dropped (in the order they were dropped). */
  trimmedSections: InstructionSectionKind[];
  /** Per-section UTF-8 byte sizes of the ORIGINAL (pre-trim) input. */
  sectionBytes: Record<string, number>;
}

/** UTF-8 byte length — the measure the WebSocket frame actually carries. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text ?? '', 'utf8');
}

/**
 * Sentinel appended in place of a dropped trimmable section so the model (and
 * any human reading a captured instruction) knows truncation happened rather
 * than silently believing the context was complete.
 */
export const SECTION_TRIM_SENTINEL = (kind: InstructionSectionKind): string =>
  `\n[${kind} context omitted to fit the Vertex Live setup budget]`;

/**
 * Enforce an aggregate byte budget on an assembled instruction built from
 * named sections.
 *
 * Sections are concatenated in the order supplied to form the assembled text.
 * When the assembly exceeds `budget`, trimmable sections are dropped in fixed
 * priority order (`bootstrap` → `history` → `specialist`), each replaced by a
 * short sentinel, until the assembly fits or no trimmable sections remain.
 * Preserved sections (`scaffold`, `override`) are never dropped — if the
 * preserved-only assembly still exceeds the budget the over-budget text is
 * returned as-is (failing loudly via `totalBytesAfter > budget` for the caller
 * to log), which is strictly better than silently corrupting the scaffold.
 *
 * Pure: no I/O, no logging, no mutation of inputs.
 *
 * @param sections Ordered instruction sections.
 * @param budget   Aggregate byte budget. Defaults to {@link INSTRUCTION_TOTAL_BYTE_BUDGET}.
 */
export function enforceInstructionBudget(
  sections: InstructionSection[],
  budget: number = INSTRUCTION_TOTAL_BYTE_BUDGET,
): InstructionBudgetResult {
  // Work on a local copy so inputs are never mutated.
  const working = sections.map((s) => ({ kind: s.kind, text: s.text ?? '' }));

  const assemble = (parts: { kind: InstructionSectionKind; text: string }[]): string =>
    parts.map((p) => p.text).join('');

  const sectionBytes: Record<string, number> = {};
  for (const s of working) {
    // Aggregate by kind in case a kind appears more than once.
    sectionBytes[s.kind] = (sectionBytes[s.kind] ?? 0) + byteLength(s.text);
  }

  const totalBytesBefore = byteLength(assemble(working));

  if (totalBytesBefore <= budget) {
    return {
      text: assemble(working),
      totalBytesBefore,
      totalBytesAfter: totalBytesBefore,
      trimmedSections: [],
      sectionBytes,
    };
  }

  const trimmedSections: InstructionSectionKind[] = [];

  for (const dropKind of DROP_ORDER) {
    if (byteLength(assemble(working)) <= budget) break;
    if (PRESERVED.has(dropKind)) continue; // defensive; DROP_ORDER excludes these

    let droppedAny = false;
    for (const part of working) {
      if (part.kind === dropKind && part.text.length > 0) {
        part.text = SECTION_TRIM_SENTINEL(dropKind);
        droppedAny = true;
      }
    }
    if (droppedAny) trimmedSections.push(dropKind);
  }

  const text = assemble(working);
  return {
    text,
    totalBytesBefore,
    totalBytesAfter: byteLength(text),
    trimmedSections,
    sectionBytes,
  };
}
