/**
 * VTID-04393 (Plan v1 WS-1.1) — priority packer for the voice bootstrap context.
 *
 * Replaces the head-slice of `capBootstrapContext()` (12 KB, keeps the first
 * 12 000 characters) as the budget step inside `buildLiveSystemInstruction`.
 *
 * Why the head-slice was wrong: the ORB session builder (orb-live.ts) appends
 * the SESSION-OWNING blocks to the END of the bootstrap string — the wake-brief
 * override, Teacher Mode, the journey-guide and guided-topic blocks, the
 * swap-back welcome — after the memory, profile and awareness text. For a
 * heavy user the memory text alone can pass 12 KB, so the head-slice cut
 * exactly the blocks that decide what the session is about, and kept the
 * oldest memory bullets instead.
 *
 * What this does instead:
 *   1. Split the bootstrap into sections at its own headers (`=== X ===`,
 *      `## X`, the wake-brief sentinel, `<social_context>`). `=== END X ===`
 *      lines are kept as their own tiny always-kept pieces so a wrapper never
 *      loses its closing line.
 *   2. Give each section a priority from its header (pinned → least
 *      important). Pinned sections (identity, the override, the
 *      session-owning modes, the memory self-check contract) are always kept.
 *   3. Fill the budget in priority order; a large low-priority section may be
 *      shortened to fit, anything else that does not fit is dropped.
 *   4. Emit the kept text in the ORIGINAL order, plus one explicit sentinel
 *      naming what was shortened or dropped.
 *
 * Under budget the input is returned unchanged (byte-for-byte), so this only
 * ever changes the prompt of users whose bootstrap was already being cut.
 *
 * Pure: no I/O, no logging.
 */

export const BOOTSTRAP_PACK_MAX_CHARS = 12_000;

/** Below this many characters of room, a section is dropped rather than shortened. */
const MIN_PARTIAL_CHARS = 600;

export type SectionTier = 'core' | 'situational' | 'deep';

export interface BootstrapSection {
  /** Stable key for telemetry (derived from the header). */
  key: string;
  /** 0 = pinned (never dropped); higher = dropped earlier. */
  priority: number;
  tier: SectionTier;
  text: string;
  /** Original position; output keeps this order. */
  index: number;
}

export interface PackedSectionReport {
  key: string;
  priority: number;
  chars: number;
  outcome: 'kept' | 'shortened' | 'dropped';
  kept_chars: number;
}

export interface BootstrapPackResult {
  text: string;
  chars_before: number;
  chars_after: number;
  /** True when anything was shortened or dropped. */
  packed: boolean;
  sections: PackedSectionReport[];
}

interface Rule {
  test: RegExp;
  key: string;
  priority: number;
  tier: SectionTier;
}

/**
 * Header → priority. First match wins; order matters. Priority 0 = pinned.
 * Headers are the ones the builders really emit (see the VTID-04393 test for
 * the source contract that keeps this table honest).
 */
const RULES: Rule[] = [
  { test: /^<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>/, key: 'wake_brief_override', priority: 0, tier: 'core' },
  { test: /^=== AUTHORITATIVE /, key: 'authoritative_identity', priority: 0, tier: 'core' },
  { test: /^=== IDENTITY LOCK/, key: 'identity_lock', priority: 0, tier: 'core' },
  { test: /^=== TEACHER MODE/, key: 'teacher_mode', priority: 0, tier: 'core' },
  { test: /^## GUIDE[- ]MOD/, key: 'guide_mode', priority: 0, tier: 'core' },
  { test: /^=== (GUIDE|JOURNEY GUIDE|GUIDED)/, key: 'guide_mode', priority: 0, tier: 'core' },
  { test: /^\[SWAP-BACK WELCOME/, key: 'swap_back_welcome', priority: 0, tier: 'core' },
  { test: /^\[BEHAVIORAL RULES/, key: 'persona_rules', priority: 0, tier: 'core' },
  { test: /^ENVIRONMENT CONTEXT:/, key: 'environment_context', priority: 1, tier: 'situational' },
  { test: /^=== (FIRST-SESSION WELCOME|DAILY MORNING GREETING)/, key: 'journey_greeting', priority: 0, tier: 'core' },
  { test: /^=== HOW TO USE THIS MEMORY/, key: 'memory_self_check', priority: 0, tier: 'core' },
  // The memory wrapper's opening section can hold the whole memory text when
  // the formatter emitted no ## sub-headers, so it is shortenable, not pinned.
  { test: /^=== USER MEMORY CONTEXT ===/, key: 'memory_open', priority: 3, tier: 'deep' },
  { test: /^## (MOST RECENT USER UTTERANCES|LETZTE ECHTE NUTZER-AUSSAGEN)/, key: 'recent_utterances', priority: 1, tier: 'core' },
  { test: /^## Verified Facts/, key: 'verified_facts', priority: 1, tier: 'core' },
  { test: /^=== ACTIVE LIFE COMPASS GOAL/, key: 'life_compass_goal', priority: 1, tier: 'core' },
  // VTID-04414: the lesson surface's learner facts (session-context-builder.ts).
  { test: /^=== LEARNER BACKGROUND/, key: 'learner_background', priority: 1, tier: 'core' },
  { test: /^=== PROACTIVE (OPENER|INITIATIVE)/, key: 'proactive_opener', priority: 2, tier: 'situational' },
  { test: /^=== OPENING SHAPE MATRIX/, key: 'opening_shape', priority: 2, tier: 'situational' },
  { test: /^=== USER CONTEXT \(you already know this user\) ===/, key: 'specialist_context', priority: 3, tier: 'situational' },
  { test: /^## User Context \(from Memory/, key: 'memory_items', priority: 3, tier: 'deep' },
  { test: /^## USER CONTEXT PROFILE/, key: 'context_profile', priority: 4, tier: 'deep' },
  { test: /^<social_context>/, key: 'social_context', priority: 5, tier: 'deep' },
];

const DEFAULT_RULE = { key: 'other', priority: 4, tier: 'deep' as SectionTier };
// Untitled text before the first header (awareness lines, legacy preambles).
const HEAD_RULE = { key: 'head', priority: 3, tier: 'situational' as SectionTier };

const HEADER_RE = /^(=== .+ ===\s*$|## \S|<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>|<social_context>|\[SWAP-BACK WELCOME|\[BEHAVIORAL RULES|ENVIRONMENT CONTEXT:)/;
const END_RE = /^=== END [^=]+ ===\s*$/;

function slug(header: string): string {
  return header
    .replace(/^[=#<\s]+|[=>\s]+$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'section';
}

function classify(header: string): { key: string; priority: number; tier: SectionTier } {
  for (const r of RULES) if (r.test.test(header)) return { key: r.key, priority: r.priority, tier: r.tier };
  return { ...DEFAULT_RULE, key: `other:${slug(header)}` };
}

/**
 * Split at header lines. The concatenation of every section's text equals the
 * input exactly.
 */
export function splitBootstrapSections(input: string): BootstrapSection[] {
  const text = input ?? '';
  if (!text) return [];
  const lines = text.split(/(?<=\n)/); // keep the newline on each line
  const out: BootstrapSection[] = [];
  let cur: { key: string; priority: number; tier: SectionTier; parts: string[] } | null = null;
  const flush = () => {
    if (cur && cur.parts.length) {
      out.push({ key: cur.key, priority: cur.priority, tier: cur.tier, text: cur.parts.join(''), index: out.length });
    }
    cur = null;
  };
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, '');
    if (END_RE.test(bare)) {
      flush();
      out.push({ key: `end:${slug(bare.replace(/^=== END /, ''))}`, priority: 0, tier: 'core', text: line, index: out.length });
      continue;
    }
    if (HEADER_RE.test(bare)) {
      flush();
      const c = classify(bare);
      cur = { ...c, parts: [line] };
      continue;
    }
    if (!cur) cur = { ...HEAD_RULE, parts: [] };
    cur.parts.push(line);
  }
  flush();
  return out;
}

function packSentinel(shortened: string[], dropped: string[]): string {
  const parts: string[] = [];
  if (shortened.length) parts.push(`shortened: ${shortened.join(', ')}`);
  if (dropped.length) parts.push(`omitted: ${dropped.join(', ')}`);
  return `\n[context packed to fit budget — ${parts.join('; ')}]`;
}

export function packBootstrapContext(input: string, max: number = BOOTSTRAP_PACK_MAX_CHARS): BootstrapPackResult {
  const text = input ?? '';
  const sections = splitBootstrapSections(text);
  const report = (outcome: (s: BootstrapSection) => PackedSectionReport) => sections.map(outcome);

  if (text.length <= max) {
    return {
      text,
      chars_before: text.length,
      chars_after: text.length,
      packed: false,
      sections: report((s) => ({ key: s.key, priority: s.priority, chars: s.text.length, outcome: 'kept', kept_chars: s.text.length })),
    };
  }

  // Reserve room for the sentinel so the result stays within max when possible.
  const budget = Math.max(0, max - 160);
  const keptText = new Map<number, string>();
  let used = 0;
  // Pinned sections first, always.
  for (const s of sections) {
    if (s.priority === 0) { keptText.set(s.index, s.text); used += s.text.length; }
  }
  const order = sections
    .filter((s) => s.priority > 0)
    .sort((a, b) => a.priority - b.priority || a.index - b.index);
  for (const s of order) {
    const room = budget - used;
    if (s.text.length <= room) {
      keptText.set(s.index, s.text);
      used += s.text.length;
    } else if (s.priority >= 3 && room >= MIN_PARTIAL_CHARS) {
      // Cut at the last line break inside the room so no bullet is half-kept.
      let cut = s.text.slice(0, room);
      const nl = cut.lastIndexOf('\n');
      if (nl > room / 2) cut = cut.slice(0, nl + 1);
      keptText.set(s.index, cut);
      used += cut.length;
    }
  }

  const shortened: string[] = [];
  const dropped: string[] = [];
  const sectionReports: PackedSectionReport[] = sections.map((s) => {
    const k = keptText.get(s.index);
    const outcome: PackedSectionReport['outcome'] = k === undefined ? 'dropped' : k.length < s.text.length ? 'shortened' : 'kept';
    if (outcome === 'dropped') dropped.push(s.key);
    if (outcome === 'shortened') shortened.push(s.key);
    return { key: s.key, priority: s.priority, chars: s.text.length, outcome, kept_chars: k?.length ?? 0 };
  });

  let out = sections.map((s) => keptText.get(s.index) ?? '').join('');
  if (shortened.length || dropped.length) out += packSentinel(shortened, dropped);
  return {
    text: out,
    chars_before: text.length,
    chars_after: out.length,
    packed: shortened.length > 0 || dropped.length > 0,
    sections: sectionReports,
  };
}
