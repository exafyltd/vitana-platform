/**
 * VTID-03273 Pillar A — the ONE First-Utterance Authority ("Opening Contract").
 *
 * The conversational-flow spec (docs/GOVERNANCE/CONVERSATIONAL-FLOW-SPEC.md)
 * diagnoses the recurring "what can I help you with after reconnect" /
 * "same summary every 2 minutes" / "vague opener" failures as a structural
 * one: ~10 independent authorities could each emit Vitana's first spoken line,
 * deduplicated only by a `greetingSent` boolean. Patching one always surfaced a
 * failure from another — unwinnable whack-a-mole.
 *
 * `decideOpening` is the single function that decides whether Vitana speaks an
 * opener at all, and if so, which line. The 7 wake-brief providers, the
 * greeting-policy gatekeeper, the reconnect/recovery paths and the journey
 * context become INPUTS to it — never independent emitters. Callers consult it
 * and obey the result; they no longer make their own first-line decision.
 *
 * Pillar B synergy: once a connection can resume the SAME server-side session
 * natively (session_resumption handle, Phase 0), a reconnect must return
 * `silent` — the model continues the thread itself, so re-greeting or replaying
 * a recovery intro is exactly the defect we are removing.
 *
 * This module is pure and side-effect free so the §4 Tier-0/1 suites can prove
 * the decision table directly.
 */

export type OpeningMode = 'speak' | 'silent';
export type OpeningBasis = 'fresh' | 'resumed';

export interface OpeningDecision {
  /** Whether Vitana speaks a first utterance at all. */
  mode: OpeningMode;
  /**
   * The exact line to speak, when the contract knows it (the wake-brief
   * selected line). `null` means "speak, but lead via the system-instruction
   * opening-shape matrix" (no verbatim line) — used for the baseline lead and
   * the no-verbatim-repeat downgrade.
   */
  line: string | null;
  /** Single, greppable source label for the `[opening-decision]` log. */
  source: string;
  /** Whether this opening is for a fresh conversation or a resumed one. */
  basis: OpeningBasis;
}

export interface OpeningContext {
  /** Anonymous sessions keep their own onboarding opener path (untouched). */
  isAnonymous: boolean;
  /** Phase 0 native resumption handle is available for this (re)connection. */
  hasResumptionHandle: boolean;
  /** This connection is a reconnect, not the first connect of the session. */
  isReconnect: boolean;
  /** The wake-brief ranker's selected user-facing line, if any. */
  wakeSelectedLine?: string | null;
  /** The winning provider kind (for source labelling), if any. */
  wakeSelectedKind?: string | null;
  /** Greeting-policy / cadence decided this open should stay silent. */
  wakeCadenceSkip?: boolean;
  /**
   * The last opener Vitana actually spoke (persisted continuity). When the
   * ranker re-selects the IDENTICAL line, we downgrade to a lead instead of
   * replaying it word-for-word — the structural kill for "the same greeting
   * every single session".
   */
  lastOpenerLine?: string | null;
}

/** Source label when the model leads via its opening-shape matrix (no line). */
export const OPENING_SOURCE_BASELINE_LEAD = 'baseline_lead';

export interface OpenerQualityVerdict {
  ok: boolean;
  /** Stable reason code when rejected (for the [opening-decision] source). */
  reason?: 'forbidden_preference_question' | 'contentless' | 'too_short';
}

// VTID-03273 Pillar D — forbidden preference questions. The doctrine
// (VTID-03271 baseline register) is that Vitana LEADS; a new user cannot tell
// us what they "would like" because they don't know the system yet. A selected
// opener that asks the user's preference is rejected verbatim and downgraded
// to a concrete lead. Conservative multi-language patterns (EN/DE/FR/ES/SR).
const FORBIDDEN_OPENER_PATTERNS: ReadonlyArray<RegExp> = [
  /how can i (help|support|assist)/i,
  /what (would you like|do you want|can i do for you|do you need)/i,
  /what'?s on your mind/i,
  /wie kann ich (dir|euch|ihnen) (helfen|unterst)/i,
  /womit kann ich (dir |euch |ihnen )?(helfen|dienen)/i,
  /was (möchtest|willst|brauchst) du/i,
  /que puis-je faire pour (toi|vous)/i,
  /en quoi puis-je (t'|vous )?aider/i,
  /en qué puedo ayudar/i,
  /qué (te gustaría|necesitas|quieres)/i,
  /како могу да помогнем/i,
  /шта (желиш|ти треба)/i,
];

// Pillar D — contentless / vague openers ("I want to introduce you to
// something", "Let me show you something") never name the value or step they
// lead to. The spec's §1 Pillar D explicitly rejects these.
const CONTENTLESS_OPENER_PATTERNS: ReadonlyArray<RegExp> = [
  /introduce you (to )?something/i,
  /show you something(\s|[.!?]|$)/i,
  /tell you something(\s|[.!?]|$)/i,
  /(dir|euch) (mal )?(etwas|was) (zeigen|vorstellen|erzählen)(\s|[.!?]|$)/i,
  /^(hello|hi|hey|hallo|salut|hola|здраво|ciao)[.!?\s]*$/i,
];

/**
 * VTID-03273 Pillar D — content-quality guard for the selected opener line.
 * Pure. Rejects (a) preference questions ("how can I help"), (b) contentless
 * teasers that name no concrete value/step, (c) lines too short to carry a
 * named next step. Rejection NEVER silences the orb — the caller downgrades to
 * the opening-shape-matrix lead, which is always a concrete lead.
 */
export function assessOpenerQuality(line: string): OpenerQualityVerdict {
  const trimmed = (line || '').trim();
  if (trimmed.length < 8) {
    return { ok: false, reason: 'too_short' };
  }
  for (const p of FORBIDDEN_OPENER_PATTERNS) {
    if (p.test(trimmed)) return { ok: false, reason: 'forbidden_preference_question' };
  }
  for (const p of CONTENTLESS_OPENER_PATTERNS) {
    if (p.test(trimmed)) return { ok: false, reason: 'contentless' };
  }
  return { ok: true };
}

/**
 * The single opening decision. Pure: same inputs → same output.
 */
export function decideOpening(ctx: OpeningContext): OpeningDecision {
  // Pillar B — a reconnect that can resume the same server-side session
  // natively must NOT re-greet. The model continues the thread itself; an
  // opener here is the "what can I help you with after reconnect" defect.
  if (ctx.isReconnect && ctx.hasResumptionHandle) {
    return { mode: 'silent', line: null, source: 'native_resume', basis: 'resumed' };
  }

  // A reconnect WITHOUT a handle (cold rebuild) still must not open with a
  // fresh greeting — continuity is handled by the recovery path, not a new
  // first utterance. Stay silent so we never re-introduce.
  if (ctx.isReconnect) {
    return { mode: 'silent', line: null, source: 'reconnect_no_handle', basis: 'resumed' };
  }

  // Fresh open — honor an explicit cadence/greeting-policy skip (recent
  // greeting within the greet-once window, cross-surface continuation, …).
  if (ctx.wakeCadenceSkip) {
    return { mode: 'silent', line: null, source: 'cadence_skip', basis: 'fresh' };
  }

  // Fresh open with a wake-brief selected line.
  const line = (ctx.wakeSelectedLine || '').trim();
  const kind = ctx.wakeSelectedKind || 'unknown';
  if (line.length > 0) {
    // No-verbatim-repeat guard: if the ranker re-selected the EXACT line we
    // last spoke, lead via the opening-shape matrix instead of replaying it
    // word-for-word. This is what stops "Lass uns dein Profil gemeinsam
    // vervollständigen" recurring identically every session.
    if (ctx.lastOpenerLine && ctx.lastOpenerLine.trim() === line) {
      return { mode: 'speak', line: null, source: `wake:${kind}:varied`, basis: 'fresh' };
    }
    // Pillar D content-quality guard: a vague/preference-question opener is
    // never spoken verbatim — downgrade to the opening-shape-matrix lead
    // (still SPEAK; the model produces a concrete lead instead).
    const quality = assessOpenerQuality(line);
    if (!quality.ok) {
      return {
        mode: 'speak',
        line: null,
        source: `wake:${kind}:quality_${quality.reason}`,
        basis: 'fresh',
      };
    }
    return { mode: 'speak', line, source: `wake:${kind}`, basis: 'fresh' };
  }

  // Fresh open, no selected line — the model leads via its opening-shape
  // matrix (a concrete lead, never a "how can I help" preference question).
  return { mode: 'speak', line: null, source: OPENING_SOURCE_BASELINE_LEAD, basis: 'fresh' };
}

/**
 * The single `[opening-decision]` log line (§2 acceptance criterion #6: exactly
 * one per conversation, naming the single source + speak/silent + fresh/resumed).
 */
export function formatOpeningDecisionLog(sessionId: string, d: OpeningDecision): string {
  const linePreview = d.line ? ` line="${d.line.slice(0, 80)}"` : '';
  return `[opening-decision] session=${sessionId} mode=${d.mode} source=${d.source} basis=${d.basis}${linePreview}`;
}
