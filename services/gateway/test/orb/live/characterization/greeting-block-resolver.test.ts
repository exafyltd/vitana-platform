/**
 * VTID-03118 (Phase B.4) — byte-identical proof for the resolver-backed
 * greeting block.
 *
 * The Phase B.4 PR removes the inline `switch (bucket)` body that used to
 * push per-bucket greeting policy lines and replaces it with a single
 * `PolicyResolver.getRenderBlock()` call plus two token substitutions.
 *
 * This test locks the invariant: the output of `buildLiveSystemInstruction`
 * is **byte-identical** whether the resolver returns its seeded content or
 * the consumer falls back to BUCKET_DEFAULT_TEMPLATES. Both code paths must
 * produce the same prompt — that is the whole point of the vertical proof.
 */

// pickShortGapGreetings shuffles its return value, which would make the
// byte-identical comparison flap. Pin it to a fixed sequence so the two
// invocations (defaults path vs resolver path) emit the same menu lines.
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

import { buildLiveSystemInstruction } from '../../../../src/orb/live/instruction/live-system-instruction';
import {
  configurePolicyResolverForTests,
  __resetPolicyResolverForTests,
  POLICY_KEYS,
  RENDER_BLOCK_KEYS,
} from '../../../../src/services/decision-contract';

// Same template strings the consumer falls back to when the cache is cold
// (see BUCKET_DEFAULT_TEMPLATES in live-system-instruction.ts). Duplicating
// them here is the test contract: if the consumer ever diverges from these,
// the byte-identical claim fails.
const TEMPLATES = {
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

const RECENT_PAST = new Date(Date.now() - 60_000).toISOString();

type BucketName = 'reconnect' | 'recent' | 'same_day' | 'today' | 'yesterday' | 'week' | 'long' | 'first';

// Map each bucket to a lastSessionInfo timestamp that classifies into that
// bucket via describeTimeSince().
function timestampFor(bucket: BucketName): string {
  const now = Date.now();
  switch (bucket) {
    case 'reconnect': return new Date(now - 30000).toISOString();           // < 120s
    case 'recent':    return new Date(now - 5 * 60000).toISOString();        // 2-15 min
    case 'same_day':  return new Date(now - 2 * 3600000).toISOString();      // 15 min - 8 h
    case 'today':     return new Date(now - 10 * 3600000).toISOString();     // 8-24 h
    case 'yesterday': return new Date(now - 25 * 3600000).toISOString();     // ~1 day
    case 'week':      return new Date(now - 3 * 86400000).toISOString();    // 2-7 days
    case 'long':      return new Date(now - 14 * 86400000).toISOString();   // > 7 days
    case 'first':     return '';                                              // empty → 'first'
  }
}

function withResolverFromTable(): void {
  configurePolicyResolverForTests({
    decisionPolicy: [
      {
        policy_key: POLICY_KEYS.SESSION_RECENCY_RECONNECT_MAX_SECONDS,
        tenant_id: null, version: 1, value_json: 120,
        effective_from: RECENT_PAST, effective_until: null,
      },
      {
        policy_key: POLICY_KEYS.SESSION_RECENCY_RECENT_MAX_MINUTES,
        tenant_id: null, version: 1, value_json: 15,
        effective_from: RECENT_PAST, effective_until: null,
      },
      {
        policy_key: POLICY_KEYS.SESSION_RECENCY_SAME_DAY_MAX_HOURS,
        tenant_id: null, version: 1, value_json: 8,
        effective_from: RECENT_PAST, effective_until: null,
      },
      {
        policy_key: POLICY_KEYS.SESSION_RECENCY_TODAY_MAX_HOURS,
        tenant_id: null, version: 1, value_json: 24,
        effective_from: RECENT_PAST, effective_until: null,
      },
      {
        policy_key: POLICY_KEYS.SESSION_RECENCY_WEEK_MAX_DAYS,
        tenant_id: null, version: 1, value_json: 7,
        effective_from: RECENT_PAST, effective_until: null,
      },
    ],
    policyRenderBlock: [
      ['reconnect', RENDER_BLOCK_KEYS.GREETING_BUCKET_RECONNECT],
      ['recent', RENDER_BLOCK_KEYS.GREETING_BUCKET_RECENT],
      ['same_day', RENDER_BLOCK_KEYS.GREETING_BUCKET_SAME_DAY],
      ['today', RENDER_BLOCK_KEYS.GREETING_BUCKET_TODAY],
      ['yesterday', RENDER_BLOCK_KEYS.GREETING_BUCKET_YESTERDAY],
      ['week', RENDER_BLOCK_KEYS.GREETING_BUCKET_WEEK],
      ['long', RENDER_BLOCK_KEYS.GREETING_BUCKET_LONG],
      ['first', RENDER_BLOCK_KEYS.GREETING_BUCKET_FIRST],
    ].map(([bucket, blockKey]) => ({
      block_key: blockKey,
      language: 'en',
      tenant_id: null,
      version: 1,
      content: TEMPLATES[bucket as keyof typeof TEMPLATES],
      effective_from: RECENT_PAST,
      effective_until: null,
    })),
  });
}

function callBuilder(timestamp: string): string {
  return buildLiveSystemInstruction(
    'en',                       // lang
    'verbose',                  // voiceStyle
    undefined,                  // bootstrapContext (no wake-brief override marker)
    'community',                // activeRole
    undefined,                  // conversationSummary
    undefined,                  // conversationHistory
    false,                      // isReconnect
    timestamp ? { time: timestamp, wasFailure: false } : null,
    null,                       // currentRoute
    null,                       // recentRoutes
    { timeOfDay: 'evening' } as any, // clientContext — carries timeOfDay
    null,                       // vitanaId
    false,                      // omitGreetingPolicy
  );
}

beforeEach(() => {
  __resetPolicyResolverForTests();
});

afterAll(() => {
  __resetPolicyResolverForTests();
});

describe('VTID-03118 — resolver-backed greeting block parity', () => {
  const buckets: BucketName[] = [
    'reconnect', 'recent', 'same_day', 'today',
    'yesterday', 'week', 'long', 'first',
  ];

  for (const bucket of buckets) {
    it(`bucket="${bucket}" produces byte-identical output via defaults vs resolver`, () => {
      const ts = timestampFor(bucket);

      // Path 1: cache empty → defaults.
      __resetPolicyResolverForTests();
      const fromDefaults = callBuilder(ts);

      // Path 2: cache primed with the same templates the seed migration loaded.
      withResolverFromTable();
      const fromResolver = callBuilder(ts);

      expect(fromResolver).toBe(fromDefaults);
    });
  }

  it('today bucket output contains the expected verbatim line for greetingTimeOfDay="evening"', () => {
    const out = callBuilder(timestampFor('today'));
    expect(out).toContain(
      '  • ALWAYS open with "Good evening, [Name]." using the user\'s name from memory context.',
    );
    expect(out).toContain('  • If no name is available in memory, just say "Good evening."');
    // Sanity: the placeholder must NOT survive into the rendered prompt.
    expect(out).not.toContain('{{greeting_time_of_day}}');
  });

  it('reconnect bucket output contains the "do not speak" guardrail verbatim', () => {
    const out = callBuilder(timestampFor('reconnect'));
    expect(out).toContain(
      '- BUCKET = reconnect (transparent server-side resume — the user did NOT perceive any pause).',
    );
    expect(out).not.toContain('{{short_gap_phrase_menu}}');
  });

  it('recent bucket expands the short-gap phrase menu (non-wake-brief path)', () => {
    const out = callBuilder(timestampFor('recent'));
    expect(out).toContain('  • Pick ONE of these example phrasings (use them VERBATIM');
    expect(out).toContain(
      '  • Rotate across sessions — the user notices repetition. If the previous session used one of these, pick a different one.',
    );
    expect(out).toContain('  • Max ONE short phrase. Warm but direct.');
    // Placeholder must be fully substituted.
    expect(out).not.toContain('{{short_gap_phrase_menu}}');
  });

  it('describeTimeSince still classifies via the resolver-supplied thresholds', () => {
    // Prime the cache with the same constants the pre-PR literals used and
    // verify each timestamp lands in the expected bucket via output markers.
    withResolverFromTable();
    expect(callBuilder(timestampFor('reconnect'))).toContain('BUCKET = reconnect');
    expect(callBuilder(timestampFor('recent'))).toContain('BUCKET = recent');
    expect(callBuilder(timestampFor('same_day'))).toContain('BUCKET = same_day');
    expect(callBuilder(timestampFor('today'))).toContain('BUCKET = today');
    expect(callBuilder(timestampFor('yesterday'))).toContain('BUCKET = yesterday');
    expect(callBuilder(timestampFor('week'))).toContain('BUCKET = week');
    expect(callBuilder(timestampFor('long'))).toContain('BUCKET = long');
    expect(callBuilder(timestampFor('first'))).toContain('BUCKET = first');
  });
});
