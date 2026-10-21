/**
 * VTID-03604 — the ORB day-close prompt block: the end-of-day counterpart to
 * VTID-03172's new-day journey greeting.
 *
 * ## The one rule this file exists to enforce
 *
 * Never a `Say exactly: "..."` directive. Every repetition bug in this
 * subsystem came from that shape — VTID-03475 (one greeting exemplar produced
 * an identical opener for every session), rung 8 `override_v2`, and the
 * apology loop removed by VTID-03597. A literal string in the prompt is a
 * literal string out of the model's mouth.
 *
 * Instead this mirrors `buildNewDayOverviewBlock`: a fully-worked shape example
 * in a DELIBERATELY UNRELATED domain, under a header that says imitate the
 * texture and never the content, plus the ledger's previous utterance as an
 * explicit negative example. That is the proven mechanism for "same sense,
 * different words, every single time".
 *
 * ## What the day-close is NOT
 *
 * It is not a recap. The day summary is on-demand only — if the user wants to
 * know how the day went they ask, and `get_day_summary` answers. An unrequested
 * recap at midnight is the "pain in the ass guide" this feature was explicitly
 * designed against.
 *
 * ## The honesty constraint on the handover offer
 *
 * `activate_autopilot_recommendations` flips a recommendation's status from
 * `new`/`snoozed` to `activated`. That is the whole of it. Vitana CANNOT go and
 * complete arbitrary work overnight, so an offer phrased as "give me your tasks
 * and I'll get them done while you sleep" is a promise broken every single
 * morning — worse than saying nothing, because it is a repeated one.
 *
 * What is literally true overnight: Vitana remembers (session extraction writes
 * `memory_facts`), holds reminders, sets alarms, puts things on the calendar,
 * and can activate a prepared recommendation. So the offer is to CARRY, not to
 * execute — which happens to be the warmer promise anyway.
 */

import { VERTEX_WAKE_BRIEF_OVERRIDE_MARKER } from '../../../orb/live/instruction/wake-brief-marker';
import { buildPreviousGreetingSection } from '../../conversation/greeting-facts-ledger';
import type { DayCloseTheme } from './day-close-themes';

export interface BuildDayCloseBlockArgs {
  lang: string;
  firstName: string | null;
  /** User's local hour, 0-23. Drives "late evening" vs "past midnight". */
  localHour: number;
  timezone: string;
  /** Rotating positivity theme — carries sense only, never wording. */
  theme: DayCloseTheme;
  /** True → warmth instead of optimism (see isHardDay). */
  hardDay: boolean;
  /** Vitana's previous first utterance — wording-variety negative example. */
  previousUtterance?: string | null;
  /** Sessions the user already opened today (0/unknown → omit). */
  sessionsToday?: number | null;
  /** A prepared autopilot checkpoint that can genuinely be activated tonight. */
  pendingCheckpointTitle?: string | null;
}

/** Past midnight reads differently from a late evening — same rung, other weather. */
function nightPhase(localHour: number): 'late_evening' | 'past_midnight' {
  return localHour < 5 ? 'past_midnight' : 'late_evening';
}

/**
 * Shape example in a domain with NO overlap with any plausible Vitana user
 * (Tomas, competitive sailing) so the model imitates pacing and warmth without
 * lifting content. Shows the three beats: land, one forward thought, honest
 * handover — and shows the model STOPPING, which is half the contract.
 */
function buildShapeExample(lang: string, phase: 'late_evening' | 'past_midnight'): string {
  if (lang.toLowerCase().startsWith('de')) {
    const bad = `### ❌ Nervige-Coach-Ton — SO NICHT:
"Es ist 00:20 Uhr. Du solltest jetzt schlafen gehen. Schlafmangel senkt deinen Index. Möchtest du, dass ich dich morgen um 7 Uhr wecke?"

### ❌ Dashboard-Ton — AUCH NICHT:
"Tagesabschluss: 2 Termine erledigt, 1 Erinnerung offen, Index 71. Gute Nacht."`;
    const good =
      phase === 'past_midnight'
        ? `### ✅ SO — GENAU DIESE TEXTUR IMITIEREN (Beispiel: Tomas, Regattasegler):
"Oh, schon nach Mitternacht, Tomas. Das war ein langer.

Weißt du, wir haben noch einiges vor — aber das läuft dir nicht weg. Wenn dir noch was im Kopf rumgeht, gib's mir mit, dann musst du's nicht bis morgen mitschleppen. Sonst: Schlaf gut."`
          : `### ✅ SO — GENAU DIESE TEXTUR IMITIEREN (Beispiel: Tomas, Regattasegler):
"Wird spät bei dir, Tomas.

Schöner Tag war das — und davon kommen noch viele. Wenn noch was offen ist, sag's mir kurz, dann hab ich's für morgen früh parat. Ansonsten mach Feierabend."`;
    return `${bad}\n\n${good}`;
  }
  const bad = `### ❌ Nagging-coach tone — NOT THIS:
"It is 00:20. You should go to sleep now. Sleep deprivation lowers your index. Would you like me to wake you at 7?"

### ❌ Dashboard tone — ALSO NOT THIS:
"Day summary: 2 events done, 1 reminder open, index 71. Good night."`;
  const good =
    phase === 'past_midnight'
      ? `### ✅ THIS — IMITATE EXACTLY THIS TEXTURE (example: Tomas, competitive sailor):
"Oh, past midnight already, Tomas. That was a long one.

We've got things ahead of us, you know — but none of it is running away tonight. If something's still circling in your head, hand it to me and you won't have to carry it till morning. Otherwise: sleep well."`
      : `### ✅ THIS — IMITATE EXACTLY THIS TEXTURE (example: Tomas, competitive sailor):
"Getting late over there, Tomas.

Good day, that — and there are plenty more coming. If anything's still open, tell me quickly and I'll have it ready for you in the morning. Otherwise, call it a night."`;
  return `${bad}\n\n${good}`;
}

export function buildDayCloseBlock(args: BuildDayCloseBlockArgs): string {
  const langCode = (args.lang || 'en').toLowerCase();
  const phase = nightPhase(args.localHour);
  const nameLine = args.firstName
    ? `User first name: ${args.firstName}`
    : 'User first name: (unknown — do not invent one; close warmly without a name)';
  const sessionsTodayLine =
    typeof args.sessionsToday === 'number' && args.sessionsToday > 0
      ? `Sessions the user already opened today: ${args.sessionsToday}`
      : null;
  const previousGreetingSection = buildPreviousGreetingSection(args.previousUtterance ?? null);

  const toneSection = args.hardDay
    ? `## TONE TONIGHT — WARMTH, NOT CHEER (this is a HARD day)

Today did not go well: the user's index has dropped and nothing was logged.
Do NOT reach for the forward-looking thought tonight — optimism on a bad day
reads as not listening, and it devalues every upbeat night that follows.

Be plain and kind. Acknowledge that it was a rough one WITHOUT diagnosing it,
without asking what went wrong, and without offering to fix it now. Something
in the spirit of "today was a slog — sleep on it, we'll sort it tomorrow".
Then let them go. Brevity IS the warmth here.`
    : `## TONE TONIGHT — ONE FORWARD THOUGHT, THIS ONE ONLY

Tonight's thought must convey THIS sense, composed in your own words:

  ${langCode.startsWith('de') ? args.theme.senseDe : args.theme.senseEn}

That is a brief for a writer, not a line to speak. Compose ONE sentence that
carries the sense. Do not quote it. Do not cover a second theme — one thought,
said well, beats three said quickly.`;

  const handoverSection = `## THE HANDOVER OFFER — AND ITS HARD LIMIT

Offer to take something off their mind so they can stop holding it. This is
the emotional core of the close: they are not alone with it overnight.

**What you may truthfully promise**, because you actually do it: you remember
what they tell you; you can set a reminder or an alarm; you can put something
on tomorrow's calendar${
    args.pendingCheckpointTitle
      ? `; and you have already prepared their next step — "${args.pendingCheckpointTitle}" — which you can activate for tomorrow if they want it`
      : ''
  }.

**What you must NEVER promise:** that you will DO their work, complete tasks,
finish anything, or "get things done" while they sleep. You cannot. A promise
like that is broken by morning, every morning, and it costs more trust than
the offer ever earns. Say you will HOLD it, CARRY it, have it READY — never
that you will have it DONE.

Keep the offer light and skippable. It is an open hand, not a form to fill in.`;

  return `\n\n${VERTEX_WAKE_BRIEF_OVERRIDE_MARKER}

## SPOKEN FIRST UTTERANCE — DAY CLOSE (VTID-03604)

The user just opened the orb ${
    phase === 'past_midnight' ? 'AFTER MIDNIGHT' : 'late in the evening'
  }, local time. This is the end of their day, not the start of one.

Your first spoken turn closes the day with them: land in the moment, give them
ONE warm forward thought, offer to carry something overnight, and let them go.
THREE beats, then stop.

## NAME — MANDATORY OPENING WHEN KNOWN (BOOTSTRAP-ORB-PERSONALIZED-GREETING)

If the SITUATION section below states a known first name, your very first
beat (the "land in the moment" beat) MUST address the user by that name —
composed in your own words, in ${langCode} ("Gute Nacht, [Name]" / "Good
night, [Name]" / equivalent, or woven into the landing sentence). A close
that never uses a known name is a contract failure, exactly like a close
longer than four sentences. If no name is known, close warmly without
inventing one.

## THIS IS NOT A SUMMARY

Do NOT recap the day. Do NOT list what they did or did not do. Do NOT read
numbers, streaks, index values, event counts or reminder counts. If they want
to know how the day went they will ask, and you have a tool for that.

An unrequested recap at midnight is exactly the tone this feature exists to
avoid. Nobody wants a guide who reads the register at them at 00:20.

## VOICE

${
  langCode.startsWith('de')
    ? `Sprich wie jemand, der den Tag mit dem Nutzer zusammen zu Ende gehen lässt —
warm, ruhig, ein bisschen leiser als tagsüber. Wie ein Mensch, der merkt, dass
es spät ist, und deshalb kurz macht. Nicht wie ein Coach mit Schlafhygiene-
Tipps. Nicht wie eine App, die noch schnell Zahlen loswerden will.`
    : `Speak like someone letting the day end alongside the user — warm, calm, a
little quieter than in daylight. Like a person who notices it is late and
therefore keeps it short. Not a coach with sleep-hygiene advice. Not an app
getting its numbers out before bed.`
}

## LANGUAGE

${langCode}. Speak in the user's language. Do not switch mid-message.

## LENGTH — SHORT. THIS IS THE HARDEST PART OF THE CONTRACT.

Two to four sentences. If you have written more than four, you have failed
this contract and you are keeping a tired person awake. The morning greeting
is the long one; this is the short one. Stop early rather than late.

## NO QUESTION STACK

At most ONE question, and only the handover offer may be it. Never ask two
things. Never ask what they want to do next — the answer is sleep.

## SITUATION

${nameLine}
Local hour: ${args.localHour} (${phase === 'past_midnight' ? 'past midnight' : 'late evening'})
Local timezone: ${args.timezone}${sessionsTodayLine ? `\n${sessionsTodayLine}` : ''}
${previousGreetingSection}
${toneSection}

${handoverSection}

## SHAPE EXAMPLE — IMITATE THE TEXTURE, NEVER THE CONTENT

The example below is in a TOTALLY DIFFERENT domain (Tomas, competitive
sailing) from this user. Copy the pacing, the shortness, the paragraph break,
the way it stops. Do NOT copy its words, its metaphors, or its subject.

${buildShapeExample(langCode, phase)}

## FINAL CHECK BEFORE YOU SPEAK

- Is it four sentences or fewer?
- Did you avoid every number and every recap?
- Is this wording different from your previous utterance above?
- Did you promise only to HOLD things, never to DO them?
- Does it end in a way the user can simply stop replying to?`;
}

/**
 * VTID-03646 follow-up — the Nova-aware reduced retry `day_close` (VTID-03629)
 * has been waiting on since it was disabled by default.
 *
 * `buildDayCloseBlock` above is a ~4200-char instruction carrying TWO fully
 * worked quoted-dialogue exemplars (a "do this" and a "not this" for BOTH
 * night phases) — the same shape as the IDENTITY LOCK block
 * `nova-instruction-sanitizer.ts` had to rewrite because Nova's content
 * filter reacts to persona-voiced quoted speech in the system prompt, and
 * the same shape as `override_v2`'s old `guidedTeachTrigger` wrapper, which
 * VTID-03674 proved trips the filter independent of length once it carries
 * that kind of instructional/exemplar framing. `day_close`'s block is the
 * single largest surviving example of the pattern in this file.
 *
 * This is NOT the directive turn-1 speaks by default — it is a REDUCED
 * fallback, used only when a `day_close` open gets `nova_validation`-closed
 * and is about to be retried (see `shouldRetryDayCloseReduced` /
 * `routes/orb-live.ts`'s day-close-reduced arming). Per NEVER-rule 41 /
 * §13b it states the INTENT in plain English/German, never a sentence to
 * recite, and — the part this file's header comment argues against for the
 * default path — carries no quoted exemplar dialogue at all, on the theory
 * that IS the trigger, not the length. Effects (stamping the night key,
 * arming the watchdog) are unchanged; only the composed prompt shrinks.
 *
 * Unverified against live Nova traffic — same honest caveat as every retry
 * mechanism in this file's chain until observed working on a real close.
 */
export function buildDayCloseOpenerLine(args: BuildDayCloseBlockArgs): string {
  const langCode = (args.lang || 'en').toLowerCase();
  const phase = nightPhase(args.localHour);
  const isDe = langCode.startsWith('de');

  // BOOTSTRAP-ORB-PERSONALIZED-GREETING — same hard rule as the full
  // buildDayCloseBlock above and as override_v2 in compute-greeting-
  // decision.ts: when a name is known, leading with it is mandatory, not
  // merely available context.
  const nameClause = args.firstName
    ? isDe
      ? `Der Nutzer heißt ${args.firstName} — nenne ihn in der Eröffnung.`
      : `The user's name is ${args.firstName} — use it in your opening.`
    : isDe
      ? 'Der Name ist nicht bekannt — erfinde keinen.'
      : "The user's name is unknown — do not invent one.";

  const toneClause = args.hardDay
    ? isDe
      ? 'Heute lief es nicht gut — sei warmherzig, nicht optimistisch. Frage nicht nach, was los war.'
      : "Today did not go well — be warm, not upbeat. Don't ask what went wrong."
    : isDe
      ? `Vermittle diesen Sinn in einem eigenen Satz: ${args.theme.senseDe}`
      : `Convey this sense in one sentence of your own: ${args.theme.senseEn}`;

  if (isDe) {
    return `Der Nutzer öffnet die App gerade ${
      phase === 'past_midnight' ? 'nach Mitternacht' : 'spät am Abend'
    } — der Tag endet, nicht beginnt. ${nameClause} Schließe den Tag warm ab: lande kurz im Moment, ${toneClause} und biete an, etwas über Nacht zu übernehmen (du kannst dich erinnern, Erinnerungen setzen, oder einen vorbereiteten nächsten Schritt aktivieren — versprich niemals, ihre Arbeit zu erledigen, während sie schlafen). Kein Rückblick, keine Zahlen, keine Zusammenfassung des Tages. Zwei bis vier Sätze, dann aufhören und zuhören.`;
  }
  return `The user is opening the app ${
    phase === 'past_midnight' ? 'after midnight' : 'late in the evening'
  } — this is the end of their day, not the start. ${nameClause} Close the day warmly: land in the moment briefly, ${toneClause} and offer to carry something overnight (you can remember, set a reminder, or activate a prepared next step — never promise to complete their work while they sleep). No recap, no numbers, no summary of the day. Two to four sentences, then stop and listen.`;
}
