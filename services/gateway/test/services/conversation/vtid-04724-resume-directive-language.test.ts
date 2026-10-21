/**
 * VTID-04724 — a reopened voice conversation answered in GERMAN on a Russian
 * session.
 *
 * Reported live: "When selecting Russian language, it speaks German with Russian
 * TTS." Measured read-only in production `oasis_events` — one member, nine
 * `lang:'ru'` sessions inside ten minutes on 2026-09-27, every one of them on
 * `provider:'cascade/polly'`:
 *
 *   wake_opener            German replies   example
 *   resume_thread          4 of 6           "Soll ich den Media Hub mit
 *                                            Podcasts, Musik und Reels jetzt
 *                                            direkt für dich öffnen?"
 *   safe_fast_proactive    0 of 5
 *   legacy_default         0 of 1
 *
 * So it is not the cascade, not Polly, and not the language tag — `lang` was
 * `ru` on all nine. It is the `resume_thread` rung, and the mechanism is that
 * its turn-1 trigger (`buildResumeThreadOpenTrigger`) tells the model to
 * "continue that conversation … its earlier turns are in the conversation
 * history" while carrying NO language nudge whatsoever. That history is German
 * for most members, because DE is this platform's source of truth — so the
 * immediate task ("continue this German thread") beat the session's own
 * top-level "Respond ONLY in Russian".
 *
 * WHY THE NUDGE IS GENERIC, AND MUST STAY GENERIC. The obvious fix — name the
 * language, "Respond ONLY in Russian" — is a shape this repo has already
 * measured and REVERTED. VTID-04010 follow-up #1/#2 (see rung 4's own comment
 * in compute-greeting-decision.ts) added "Speak entirely in ${langName}" to a
 * turn-1 rung and got 2 of 11 authenticated trials through, the rest closing
 * `1007 "Request contains an invalid argument."`; the proven-reliable sibling
 * `override_v2` (24/24) never names the language at all and leaves language
 * SELECTION to the system prompt. So both fixes here say only "the user's own
 * language for this session", and name the source language (German) purely as
 * the thing NOT to mirror — exactly as rung 4 names English.
 *
 * `buildResumeDirective` (the `conv_resume` rung, a different rung) is fixed in
 * the same pass for the same class of defect: its LANGUAGE section named the
 * language by BARE ISO CODE ("ru. Speak only in the user's language.") and it
 * DEMONSTRATED its own phrasing in German three times to every language
 * ("ich würde vorschlagen, wir …", "schau dir deine Matches an", "lass uns
 * einen davon auswählen …") while its last line claimed "nothing here is
 * hardcoded wording". Those are spoken strings in a prompt (NEVER rule 41) and
 * quoted persona-voiced speech, the shape VTID-04124/VTID-03797 measured as
 * content-filter-prone.
 */
import { buildResumeDirective } from '../../../src/services/conversation/decide-opening';
import { buildResumeThreadOpenTrigger } from '../../../src/services/conversation/compute-greeting-decision';
import type { OverviewPayload } from '../../../src/services/assistant-continuation/providers/new-day-overview-payload';

function payload(over: Partial<OverviewPayload> = {}): OverviewPayload {
  return {
    journey: null,
    vitana_index: {
      state: 'ok', today: 200, tier: 'Early', tier_framing: null, trend_7d: 0,
      weakest_pillar: { name: 'nutrition', score: 30 }, strongest_pillar: null,
      balance_label: 'balanced', pillars: null, projected_day_90: null, projected_day_90_tier: null,
    },
    life_compass: {
      state: 'set', primary_goal: 'longer life', category: null, target_date: null,
      target_value: null, target_unit: null, starting_value: null, set_at: null,
      days_to_deadline: null, goal_progress_pct: null,
    },
    calendar_today: { count: 0, next: null },
    calendar_passed: { count: 0, most_recent: null },
    autopilot: { state: 'none_yet', today_checkpoint: null, this_week: [], pending_total: 0 },
    matches_unread: 0,
    messages_unread: 0,
    reminders_today: { count: 0, next: null },
    diary_last_7d: 3,
    facts_learned_since_last: null,
    guided_journey: null,
    last_session_date_user_tz: null,
    ...over,
  };
}

const base = {
  register: 'same_day' as const,
  payload: payload({ messages_unread: 26 }),
  firstName: 'Mariia',
  timeAgo: 'earlier today',
  currentScreen: '/home',
};

const NAMED_LANGUAGES = [
  'Russian', 'German', 'Serbian', 'Spanish', 'French', 'Portuguese',
  'Polish', 'Turkish', 'Arabic', 'Chinese',
];

describe('VTID-04724 — resume_thread trigger (the rung that answered in German)', () => {
  const trigger = buildResumeThreadOpenTrigger();

  it('tells the model to speak the session language even when the history is another one', () => {
    // This is the whole fix for the reported defect: the trigger previously
    // said "continue that conversation" with no language nudge at all.
    expect(trigger).toMatch(/user's own language for this session/);
    expect(trigger).toMatch(/even when the earlier turns/);
    expect(trigger).toMatch(/another language/);
  });

  it('carries the topic across but NOT the history\'s wording', () => {
    expect(trigger).toMatch(/carry the topic across, not its wording/);
  });

  it('never names a target language — the reverted VTID-04010/04015 shape', () => {
    // Naming the language in a turn-1 rung measured 2/11 and was reverted.
    // Language SELECTION belongs to the system prompt's own "Respond ONLY in X".
    for (const name of NAMED_LANGUAGES) {
      expect(trigger).not.toContain(name);
    }
    expect(trigger).not.toMatch(/Respond ONLY in/);
    expect(trigger).not.toMatch(/Speak entirely in/);
  });

  it('keeps the VTID-04575 continuation contract it was built for', () => {
    // The nudge must not have displaced the rung's actual job.
    expect(trigger).toMatch(/Continue that conversation from where it stopped/);
    expect(trigger).toMatch(/last question is still unanswered/);
    expect(trigger).toMatch(/Then stop and listen/);
  });

  it('stays a positive intent — no prohibition stack, no quoted dialogue', () => {
    // VTID-04124/VTID-03797: a pile-up of negative imperatives and quoted
    // persona speech is measurably content-filter-prone on Nova. This rung
    // exists because its predecessor was rejected on 44 of 61 reopens.
    expect(trigger).not.toMatch(/"/);
    const negatives = (trigger.match(/\b(Do NOT|NEVER|never|don't)\b/g) || []).length;
    expect(negatives).toBeLessThanOrEqual(2);
  });
});

describe('VTID-04724 — buildResumeDirective language section', () => {
  it('no longer states the language as a bare ISO code', () => {
    const { text } = buildResumeDirective({ ...base, lang: 'ru' });
    expect(text).not.toContain("ru. Speak only in the user's language.");
    expect(text).not.toMatch(/^\s*(ru|de|en|fr|es|pt|pl|zh|ar|tr|sr)\.\s/m);
  });

  it('nudges generically and tells the model not to mirror the German material', () => {
    const { text } = buildResumeDirective({ ...base, lang: 'ru' });
    expect(text).toMatch(/user's own language for this session/);
    expect(text).toMatch(/authored in German/);
    expect(text).toMatch(/carry their FACTS across, never their\s+wording/);
  });

  it('never names a target language, for ANY session language', () => {
    // Same reverted-shape guard as the trigger above. Checked across locales so
    // a later "just add the language name" edit fails here rather than live.
    for (const lang of ['ru', 'de', 'en', 'sr', 'es', 'fr', 'pt', 'pl', 'tr', 'ar', 'zh']) {
      const { text } = buildResumeDirective({ ...base, lang });
      expect(text).not.toMatch(/Respond ONLY in/);
      expect(text).not.toMatch(/DELIVERED in (Russian|German|Serbian|Spanish)/);
    }
  });

  it('carries no German sentence it expects every language to imitate', () => {
    const { text } = buildResumeDirective({ ...base, lang: 'ru' });
    for (const german of [
      'ich würde',
      'vorschlagen',
      'schau dir deine Matches an',
      'lass uns',
      'Aktivität',
      'für dich',
    ]) {
      expect(text).not.toContain(german);
    }
  });

  it('applies to all three same-day resume registers, not one of them', () => {
    for (const register of ['continue', 'quick_resume', 'same_day'] as const) {
      const { text } = buildResumeDirective({ ...base, register, lang: 'ru' });
      expect(text).toMatch(/user's own language for this session/);
    }
  });

  it('still guides to a concrete next step — the fix did not drop the offer contract', () => {
    const { text, nba } = buildResumeDirective({ ...base, lang: 'ru' });
    expect(text).toContain('suggested_next_step');
    expect(text).toContain('execute_with_tool');
    expect(nba).not.toBeNull();
  });
});
