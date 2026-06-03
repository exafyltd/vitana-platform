/**
 * VTID-03118 (Phase B.4) — greeting-bucket fallback content lock.
 *
 * ORIGINAL PURPOSE: prove that `buildLiveSystemInstruction` rendered the
 * per-bucket greeting-policy block byte-identically whether the PolicyResolver
 * returned its seeded content or the consumer fell back to the inline
 * BUCKET_DEFAULT_TEMPLATES.
 *
 * R2 (BOOTSTRAP-ORB-R2-GREETING-POLICY): the legacy `## GREETING POLICY` stack
 * was DELETED from `buildLiveSystemInstruction`. Its temporal/bucketed
 * fallback pools moved verbatim to the priority-80 voice-wake-brief provider,
 * which owns the no-provider fallback path in the Central Continuation
 * Contract. The resolver-vs-defaults parity is no longer relevant (the moved
 * pools are static constants, not resolver-backed), but the VERBATIM bucket
 * content + token substitution must still be locked — that is what this test
 * now does, against the new owner.
 */

// pickShortGapGreetings shuffles its return value, which would make the
// menu-expansion comparison flap. Pin it to a fixed sequence.
jest.mock('../../../../src/orb/instruction/greeting-pools', () => ({
  pickShortGapGreetings: (_lang: string, _n: number) => [
    'fixed phrase 1',
    'fixed phrase 2',
    'fixed phrase 3',
    'fixed phrase 4',
    'fixed phrase 5',
    'fixed phrase 6',
  ],
}));

import {
  WAKE_BRIEF_BUCKET_TEMPLATES,
  renderWakeBriefFallbackBlock,
  expandShortGapPhraseMenu,
  type WakeBriefTemporalBucket,
} from '../../../../src/services/assistant-continuation/providers/voice-wake-brief';

// The template strings the moved pools must render. Duplicating them here is
// the test contract: if the provider ever diverges from these verbatim
// strings, the lock fails. These are byte-identical to the pre-R2
// BUCKET_DEFAULT_TEMPLATES that used to live in live-system-instruction.ts.
const TEMPLATES: Record<WakeBriefTemporalBucket, string> = {
  reconnect:
`- BUCKET = reconnect (transparent server-side resume — the user did NOT perceive any pause).
  • DO NOT speak. DO NOT greet. DO NOT acknowledge any "interruption", "reconnection", "resume", "where were we", "I'm back", "I'm listening", "picking up", or anything similar. Saying any of these creates a perceived apology that the user reads as a bug.
  • Wait for the user to speak. Your next message must be a direct response to the user's next utterance — nothing else.
  • If the user says nothing, you say nothing. Silence is correct here.`,
  recent:
`- BUCKET = recent (2–15 min since last session).
  • Do NOT use a formal greeting. NO "Hello <name>!", NO "Hi there!", NO self-introduction. NO user name.
  • Open with ONE single short phrase. NEVER use two-part sentences joined by dashes or commas.
{{short_gap_phrase_menu}}
  • Max ONE short phrase. Warm but direct.`,
  same_day:
`- BUCKET = same_day (15 min – 8 h since last session).
  • Light re-engagement. NOT a formal greeting. No user name. NEVER "Hello <name>!" as if you've never met.
  • Open with ONE single short phrase. NEVER use two-part sentences joined by dashes or commas.
{{short_gap_phrase_menu}}
  • Max ONE short phrase. Warm and direct.`,
  today:
`- BUCKET = today (8–24 h since last session — this is a NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "What's on your mind today?"
      "Where would you like to focus today?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.`,
  yesterday:
`- BUCKET = yesterday (this is a NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "What would you like to explore today?"
      "Picking up where we left off?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.`,
  week:
`- BUCKET = week (2–7 days since last session — this is a NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "Good to hear from you again — what's been on your mind?"
      "What would you like to explore today?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.`,
  long:
`- BUCKET = long (> 7 days since last session — this is a NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available — for >7-day absences the candidate should explicitly acknowledge the gap).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "It's been a few days — happy you're back. What's been on your mind?"
      "What would you like to focus on today?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.`,
  first:
`- BUCKET = first (telemetry lookup found no prior session — usually treat as RETURNING with NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • EXCEPTION: when the brain context's USER AWARENESS shows tenure.stage="day0", the user is genuinely new. Use the FULL INTRODUCTION shape from the brain context's OPENING SHAPE MATRIX — that overrides this fallback.
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "What's on your mind today?"
      "Where would you like to focus today?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.`,
};

const ALL_BUCKETS: WakeBriefTemporalBucket[] = [
  'reconnect', 'recent', 'same_day', 'today',
  'yesterday', 'week', 'long', 'first',
];

describe('R2: voice-wake-brief owns the temporal fallback pools (byte-identical to legacy)', () => {
  it('exposes one template per temporal bucket', () => {
    for (const bucket of ALL_BUCKETS) {
      expect(WAKE_BRIEF_BUCKET_TEMPLATES[bucket]).toBe(TEMPLATES[bucket]);
    }
  });

  it('today bucket substitutes greetingTimeOfDay verbatim', () => {
    const out = renderWakeBriefFallbackBlock('today', 'en', 'evening');
    expect(out).toContain(
      '  • ALWAYS open with "Good evening, [Name]." using the user\'s name from memory context.',
    );
    expect(out).toContain('  • If no name is available in memory, just say "Good evening."');
    expect(out).not.toContain('{{greeting_time_of_day}}');
  });

  it('reconnect bucket renders the "do not speak" guardrail verbatim', () => {
    const out = renderWakeBriefFallbackBlock('reconnect', 'en', 'evening');
    expect(out).toContain(
      '- BUCKET = reconnect (transparent server-side resume — the user did NOT perceive any pause).',
    );
    expect(out).not.toContain('{{short_gap_phrase_menu}}');
  });

  it('recent bucket expands the short-gap phrase menu (non-wake-brief path)', () => {
    const out = renderWakeBriefFallbackBlock('recent', 'en', 'evening');
    expect(out).toContain('  • Pick ONE of these example phrasings (use them VERBATIM');
    expect(out).toContain(
      '  • Rotate across sessions — the user notices repetition. If the previous session used one of these, pick a different one.',
    );
    expect(out).toContain('  • Max ONE short phrase. Warm but direct.');
    expect(out).not.toContain('{{short_gap_phrase_menu}}');
  });

  it('wake-brief override suppresses the short-gap phrase list', () => {
    const out = renderWakeBriefFallbackBlock('recent', 'en', 'evening', true);
    expect(out).toContain('SHORT-GAP PHRASE LIST SUPPRESSED');
    expect(out).not.toContain('Pick ONE of these example phrasings');
  });

  it('expandShortGapPhraseMenu emits the pinned fixed phrases verbatim', () => {
    const menu = expandShortGapPhraseMenu('en');
    expect(menu).toContain('"fixed phrase 1"');
    expect(menu).toContain('"fixed phrase 6"');
  });

  it('every bucket renders with no surviving placeholder tokens', () => {
    for (const bucket of ALL_BUCKETS) {
      const out = renderWakeBriefFallbackBlock(bucket, 'en', 'morning');
      expect(out).not.toContain('{{greeting_time_of_day}}');
      expect(out).not.toContain('{{short_gap_phrase_menu}}');
      expect(out).toContain(`BUCKET = ${bucket}`);
    }
  });
});
