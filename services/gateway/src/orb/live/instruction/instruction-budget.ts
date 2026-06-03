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
 * Stable, model-ignored HTML-comment delimiter emitted by
 * `buildLiveSystemInstruction` at the START of the bootstrap-context region.
 *
 * The bootstrap text has no fixed leading marker (it varies per user), so this
 * is the ONLY reliable anchor the send-site has for telling where the static
 * scaffold ends and the trimmable bootstrap begins. {@link decomposeInstructionSections}
 * uses it (with the specialist / wake-brief / teacher / history / navigator
 * markers below) to carve the assembled instruction into ordered, individually
 * trimmable sections. HTML-comment style so Gemini ignores it as prompt content.
 */
export const BOOTSTRAP_CONTEXT_START_MARKER = '<!--VITANA_BOOTSTRAP_CONTEXT_START-->';

/**
 * Stable section-boundary markers already emitted verbatim by the instruction
 * builders. {@link decomposeInstructionSections} anchors on these to assign
 * each segment of the assembled text to a trimmable / preserved section kind.
 * None of these are invented by this fix — they are the existing headers/
 * sentinels produced by:
 *   - fetchSpecialistContextSection → formatSpecialistContextSection (orb-live.ts)
 *   - buildVertexWakeBriefBlock (live-session-controller.ts)
 *   - buildTeacherModeBlock (teacher-mode-prompt.ts)
 *   - buildLiveSystemInstruction (conversation_history block)
 *   - buildNavigatorPolicySection (orb-live.ts; de + en share this prefix)
 */
export const INSTRUCTION_MARKERS = {
  /** Specialist / ticket-history block (trimmable: specialist). */
  SPECIALIST_CONTEXT: '=== USER CONTEXT (you already know this user) ===',
  /** Turn-1 wake-brief override sentinel (PRESERVED: override). */
  WAKE_BRIEF_OVERRIDE: '<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>',
  /** Teacher Mode block — turn-2+ behavior (trimmable: specialist). */
  TEACHER_MODE_OPEN: '=== TEACHER MODE (VTID-03112) ===',
  TEACHER_MODE_CLOSE: '=== END TEACHER MODE ===',
  /** Conversation history block (trimmable: history). */
  HISTORY_OPEN: '<conversation_history>',
  HISTORY_CLOSE: '</conversation_history>',
  /** Navigator policy — start of the preserved scaffold tail. de + en share
   *  this exact prefix (`… NAVIGATIONSMODUS ===` / `… NAVIGATION GUIDE MODE ===`). */
  NAVIGATOR_PREFIX: '=== VITANA NAVIGATOR —',
} as const;

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

/**
 * Decompose a fully-assembled Vertex Live `system_instruction` string into
 * ordered, individually-trimmable {@link InstructionSection}s using ONLY the
 * stable markers the instruction builders already emit ({@link INSTRUCTION_MARKERS}
 * + {@link BOOTSTRAP_CONTEXT_START_MARKER}).
 *
 * This is the R0 fix. The previous send-site decomposition split the text on
 * the `<conversation_history>` delimiter alone, so EVERYTHING before history
 * (static scaffold + the ~12 KB bootstrap + specialist + teacher) was lumped
 * into the preserved `scaffold` section. The aggregate budget guard's intended
 * drop order (bootstrap → history → specialist) therefore never exercised
 * bootstrap/specialist at the send site — only history was trimmable. A heavy
 * user whose bootstrap + scaffold + tools already exceeded the budget BEFORE
 * any history existed got an oversized setup sent anyway (WS 1009/1007 →
 * silent ORB).
 *
 * Document order of the assembled authenticated instruction:
 *   [scaffold head] · BOOTSTRAP_START · [bootstrap] · [specialist: USER CONTEXT]
 *   · [bootstrap cont.] · [override: wake-brief] · [specialist: teacher]
 *   · [history] · [scaffold tail: navigator + temporal + proactive]
 *
 * Mapping to section kinds:
 *   - everything before BOOTSTRAP_START ............... scaffold (PRESERVED)
 *   - bootstrap region up to the first inner marker ... bootstrap (trimmable)
 *   - `=== USER CONTEXT … ===` block .................. specialist (trimmable)
 *   - `<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>` block ... override (PRESERVED)
 *   - `=== TEACHER MODE … ===` block .................. specialist (trimmable)
 *   - `<conversation_history>…</conversation_history>`  history (trimmable)
 *   - `=== VITANA NAVIGATOR — …` to end ............... scaffold (PRESERVED)
 *
 * When the bootstrap-start marker is absent (anonymous sessions, persona
 * overrides, or empty bootstrap), the text is split on the history block alone
 * with everything else preserved — identical to the safe pre-fix behavior.
 *
 * The concatenation of all returned section `text` values is byte-for-byte
 * equal to the input (this is verified by tests), so feeding the result to
 * {@link enforceInstructionBudget} is a no-op when under budget.
 *
 * Pure: no I/O, no logging.
 */
export function decomposeInstructionSections(finalText: string): InstructionSection[] {
  const text = finalText ?? '';
  if (text.length === 0) return [];

  const M = INSTRUCTION_MARKERS;

  // The scaffold tail begins at the navigator section. Everything from there to
  // the end (navigator + temporal/journey + proactive opener + activity
  // awareness) is static, turn-shaping scaffold and must be preserved.
  const navIdx = text.indexOf(M.NAVIGATOR_PREFIX);
  const tailStart = navIdx >= 0 ? navIdx : text.length;

  // History block, if present, sits between the bootstrap region and the tail.
  const histOpen = text.indexOf(M.HISTORY_OPEN);
  const hasHistory = histOpen >= 0 && histOpen < tailStart;
  let histClose = -1;
  if (hasHistory) {
    const c = text.indexOf(M.HISTORY_CLOSE, histOpen);
    histClose = c >= 0 ? c + M.HISTORY_CLOSE.length : tailStart;
  }
  // The body (scaffold head + bootstrap + specialist + override) is everything
  // before the history block (or before the tail when there is no history).
  const bodyEnd = hasHistory ? histOpen : tailStart;

  const sections: InstructionSection[] = [];

  // ── Scaffold head + bootstrap-region body ──────────────────────────────
  const bootStart = text.indexOf(BOOTSTRAP_CONTEXT_START_MARKER);
  if (bootStart >= 0 && bootStart < bodyEnd) {
    // Static scaffold head (persona, tools, greeting rules, role headers) up to
    // and INCLUDING the bootstrap-start marker so the marker rides with the
    // preserved scaffold and is never the lone survivor of a trim.
    const headEnd = bootStart + BOOTSTRAP_CONTEXT_START_MARKER.length;
    sections.push({ kind: 'scaffold', text: text.slice(0, headEnd) });

    // The bootstrap region runs from after the marker to bodyEnd. Inside it,
    // carve out the specialist, override, and teacher sub-blocks by their
    // stable markers, in document order. Anything between/around them is the
    // brain bootstrap proper (trimmable: bootstrap).
    pushBootstrapRegion(sections, text, headEnd, bodyEnd, M);
  } else {
    // No bootstrap-start marker (anonymous / persona-override / empty bootstrap):
    // preserve the whole body as scaffold — the safe pre-fix behavior.
    sections.push({ kind: 'scaffold', text: text.slice(0, bodyEnd) });
  }

  // ── History (trimmable) ────────────────────────────────────────────────
  if (hasHistory) {
    sections.push({ kind: 'history', text: text.slice(histOpen, histClose) });
    // Any stray text between history close and tail start (normally none).
    if (histClose < tailStart) {
      sections.push({ kind: 'scaffold', text: text.slice(histClose, tailStart) });
    }
  }

  // ── Scaffold tail (PRESERVED) ──────────────────────────────────────────
  if (tailStart < text.length) {
    sections.push({ kind: 'scaffold', text: text.slice(tailStart) });
  }

  // Drop empty sections so byte accounting stays clean; concatenation is still
  // byte-identical to the input (empty strings contribute nothing).
  return sections.filter((s) => s.text.length > 0);
}

/**
 * Carve the bootstrap region [start, end) into ordered sections, separating the
 * specialist (`=== USER CONTEXT …`), turn-1 wake-brief override
 * (`<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>`), and teacher (`=== TEACHER MODE …`)
 * sub-blocks from the surrounding brain bootstrap. Markers appear in a fixed
 * document order (specialist → override → teacher); each runs until the next
 * marker or the region end.
 */
function pushBootstrapRegion(
  out: InstructionSection[],
  text: string,
  start: number,
  end: number,
  M: typeof INSTRUCTION_MARKERS,
): void {
  // Collect the boundary markers that actually occur inside the region, each
  // tagged with the kind that BEGINS at that marker.
  const boundaries: Array<{ at: number; kind: InstructionSectionKind }> = [];
  const find = (needle: string, kind: InstructionSectionKind) => {
    const at = text.indexOf(needle, start);
    if (at >= start && at < end) boundaries.push({ at, kind });
  };
  find(M.SPECIALIST_CONTEXT, 'specialist');
  find(M.WAKE_BRIEF_OVERRIDE, 'override');
  find(M.TEACHER_MODE_OPEN, 'specialist');
  boundaries.sort((a, b) => a.at - b.at);

  // Walk the region cutting at each boundary. The opening segment (before the
  // first marker, or the whole region if none) is the brain bootstrap.
  let cursor = start;
  let kind: InstructionSectionKind = 'bootstrap';
  for (const b of boundaries) {
    if (b.at > cursor) {
      out.push({ kind, text: text.slice(cursor, b.at) });
    }
    cursor = b.at;
    kind = b.kind;
  }
  if (cursor < end) {
    out.push({ kind, text: text.slice(cursor, end) });
  }
}
