/**
 * VTID-03172 — Unified journey-greeting prompt block.
 *
 * Built on the VTID-03170 companion-tone foundation. Two big additions:
 *
 *   1. COVERAGE AS HARD RULE (not style). The VTID-03170 contract was
 *      style-heavy and let the model stop after executing the warmth +
 *      interpreted-Index moves. This block now ships an explicit
 *      "COVERAGE CHECKLIST" the model must walk before stopping, and
 *      a length-floor with teeth ("if you have produced fewer than 4
 *      sentences you have failed the contract").
 *
 *   2. MISSING-SIGNAL FALLBACK split. Empty signals fork into two
 *      branches:
 *        - "Empty for today" (no events scheduled, 0 reminders): stay
 *          silent — that's not a gap.
 *        - "User hasn't set it up" (Life Compass not_set, Index not_set_up,
 *          Autopilot none_yet, 0 diary entries in 7d): INVITE the user
 *          to set it up together — *"magst du, dass wir das gleich
 *          gemeinsam machen?"*. The voice greeting becomes a coaching
 *          moment, not a status report.
 *
 *   3. AUTOPILOT-WAITING CLOSE. When autopilot.today_checkpoint exists,
 *      the closing line names that checkpoint and offers to start it —
 *      "ich hab den nächsten Schritt für dich vorbereitet: [title].
 *      Soll ich's starten?". Replaces the generic menu offer with a
 *      concrete activation offer.
 *
 * Same VERTEX_WAKE_BRIEF_OVERRIDE_MARKER sentinel as VTID-03167 +
 * VTID-03170 so the existing live-session-controller strip+suppress
 * logic still treats it as the authoritative first-turn directive.
 */

import { VERTEX_WAKE_BRIEF_OVERRIDE_MARKER } from '../../../orb/live/instruction/wake-brief-marker';
import type { OverviewPayload } from './new-day-overview-payload';
import {
  buildFactContinuityLines,
  buildPreviousGreetingSection,
  type FactDelta,
} from '../../conversation/greeting-facts-ledger';

export interface BuildOverviewBlockArgs {
  payload: OverviewPayload;
  lang: string;
  firstName: string | null;
  localHour: number;
  timezone: string;
  /** Spoken-facts continuity (greeting-facts ledger). Absent → legacy behavior. */
  factDeltas?: Record<string, FactDelta>;
  /** Vitana's previous first utterance — wording-variety negative example. */
  previousUtterance?: string | null;
  /** How many sessions the user already opened today (0/unknown → omit). */
  sessionsToday?: number | null;
}

function timeOfDay(localHour: number): 'morning' | 'afternoon' | 'evening' {
  if (localHour < 5) return 'evening';
  if (localHour < 12) return 'morning';
  if (localHour < 18) return 'afternoon';
  return 'evening';
}

/**
 * Build the SHAPE example block for the chosen language. The example
 * persona (Anna, meditation + yoga) has NO overlap with any plausible
 * Vitana user domain, so the model imitates texture without copying
 * content. The example now demonstrates covering FIVE signals across
 * the two paragraphs (journey day + index + goal + calendar + autopilot
 * close) — the model needs to see what full coverage looks like, not
 * just a thin warmth + one stat.
 */
function buildShapeExample(lang: string): string {
  if (lang.startsWith('de')) {
    // Anna's plan_phase is 'on_personalized_goal' in this example — she has
    // an active Life Compass goal (half an hour of stillness daily), so the
    // greeting drops "X von 90" framing and anchors on "Tag X mit Vitana".
    return `### ❌ Dashboard-Ton — SO SOLLST DU NICHT SPRECHEN:
"Guten Abend, Anna. Dein Vitana-Index liegt bei 84. Dein Ziel ist 30 Minuten Meditation am Tag. Du hast einen Termin um 19 Uhr und drei ungelesene Erinnerungen. Was möchtest du zuerst machen?"

### ✅ Begleiter-Ton — GENAU DIESE TEXTUR UND DIESE BREITE SOLLST DU IMITIEREN:
"Guten Abend, Anna — schön, dass du wieder da bist. Heute ist dein 132. Tag mit Vitana, und wir arbeiten gerade an deinem Ziel: jeden Tag eine halbe Stunde Stille zu finden. Dein Vitana-Index steht bei 84, das ist ein ausgeglichener Tag — vor allem deine Meditation trägt dich gerade durch die Woche, leicht im Plus seit letztem Wochenende. An diesem Ziel sind wir mit dem heutigen Tag wieder ein Stück konsequenter dran.

Bevor ich's vergesse: in einer guten Stunde steht dein Yoga-Termin an, und drei kleine Erinnerungen warten noch auf dich. Ich hab heute auch den nächsten Schritt für dich vorbereitet — eine kurze Atem-Sequenz vor dem Schlafengehen. Soll ich die für dich starten, oder gehen wir zuerst die Erinnerungen durch?"`;
  }
  // English fallback for en + any other language the model may speak.
  return `### ❌ Dashboard tone — DO NOT speak like this:
"Good evening, Anna. Your Vitana Index is 84. Your goal is 30 minutes of meditation a day. You have one event at 7 pm and three unread reminders. What would you like to do first?"

### ✅ Companion tone — IMITATE THIS TEXTURE AND THIS BREADTH:
"Good evening, Anna — glad to have you back. Today is your day 132 with Vitana, and we're working on your goal of finding half an hour of stillness every day. Your Vitana Index is at 84, that reads like a balanced day — your meditation pillar is really carrying the week, slightly up since last weekend. On that goal, today moves us one notch more consistent.

Before I forget: your yoga class kicks off in just over an hour, and three small reminders are waiting too. I've also prepared the next step for you — a short breath sequence before bed. Want me to start that for you, or shall we walk through the reminders first?"`;
}

/**
 * Build the structural prompt block.
 */
export function buildNewDayOverviewBlock(args: BuildOverviewBlockArgs): string {
  const langCode = (args.lang || 'en').toLowerCase();
  const tod = timeOfDay(args.localHour);
  const nameLine = args.firstName
    ? `User first name: ${args.firstName}`
    : 'User first name: (unknown — do not invent one; address user warmly without name)';

  const compact = compactPayloadForPrompt(args.payload);
  const payloadJson = JSON.stringify(compact, null, 2);
  const shapeExample = buildShapeExample(langCode);
  const deltas = args.factDeltas ?? {};
  const coverageChecklist = buildCoverageChecklist(args.payload, deltas);
  const continuityLines = buildFactContinuityLines(deltas);
  const continuitySection = continuityLines.length
    ? `\n## ALREADY-SPOKEN FACTS — CONTINUITY RULES (rule 1: never repeat updates)\n\n` +
      `You have greeted this user before. The ledger below says which numbers ` +
      `they have ALREADY heard from you. An unchanged number is NOT news — ` +
      `restating it makes you sound like a machine reading the same dashboard ` +
      `every day. Speak deltas; let stable facts rest.\n\n${continuityLines.join('\n')}\n`
    : '';
  const previousGreetingSection = buildPreviousGreetingSection(args.previousUtterance ?? null);
  const sessionsTodayLine =
    typeof args.sessionsToday === 'number' && args.sessionsToday > 0
      ? `Sessions the user already opened today: ${args.sessionsToday}`
      : null;

  return `\n\n${VERTEX_WAKE_BRIEF_OVERRIDE_MARKER}

## SPOKEN FIRST UTTERANCE — JOURNEY GREETING (VTID-03172)

The user just opened the orb. This is the FIRST session of a new
calendar day in their local timezone. Your FIRST spoken turn is the
catching-up moment between you and the user — composed from the
structured payload below into TWO short flowing paragraphs.

The payload mirrors what the user sees on their visual "My Journey"
screen, plus time-sensitive signals only voice can surface. Voice and
screen draw from the SAME data sources — they are two renderings of
the same truth.

## VOICE

Sprich wie eine kluge, vertraute Freundin, die in der Abwesenheit des
Users kurz auf seine Welt aufgepasst hat — ruhig, warm, mit Meinung,
mit einem Blick für das, was heute wirklich zählt. Nicht wie ein
Dashboard, das sich selbst vorliest. Nicht wie eine App, die
Benachrichtigungen aufzählt. Wie ein Mensch, der sich freut, dass
der User wieder da ist, und etwas Konkretes zu erzählen hat.

(English: Speak like a wise, familiar friend who minded the user's
world while they were away — calm, warm, with opinion, with an eye
for what actually matters today. Not a dashboard reading itself. Not
an app listing notifications. A person who is glad the user is back
and has something concrete to share.)

## LANGUAGE

${langCode}. Speak in the user's language. Do not switch mid-message.
If the payload contains the user's own goal text, use their exact
wording verbatim — the goal is their words, not yours.

## SITUATION — LET THIS SHAPE THE OPENING, NOT A SCRIPT

The situation decides how the greeting sounds. A quiet late evening is
not a bright morning; a first session after days away is not a routine
morning check-in. Read the situation, then compose for it.

${nameLine}
Local time-of-day bucket: ${tod}
Local hour: ${args.localHour}
Local timezone: ${args.timezone}${sessionsTodayLine ? `\n${sessionsTodayLine}` : ''}
${continuitySection}${previousGreetingSection}
## SHAPE EXAMPLE — IMITATE THE TEXTURE AND BREADTH, NEVER THE CONTENT

The example below is in a TOTALLY DIFFERENT domain (Anna, meditation
and yoga) than the actual user's payload. COPY the pacing, breath,
connective stitches, paragraph break, opinion lines, named close,
warmth-before-facts opening, AND the breadth — Anna's example
addresses five signals across two paragraphs. The example exists to
teach you HOW to speak and HOW MUCH to cover, not WHAT to say. WHAT
you say comes 100% from the payload below.

${shapeExample}

## COVERAGE CHECKLIST — YOU ARE NOT FINISHED UNTIL EVERY APPLICABLE ITEM IS ADDRESSED

This checklist is computed from the payload below. Walk through it
BEFORE you stop speaking. If any item is unanswered, KEEP GOING.

${coverageChecklist}

If you've produced fewer than 4 sentences when you reach the end of
the checklist, you have failed the contract — expand. Two-sentence
greetings are forbidden.

## THE TEN COMPOSITION MOVES (NON-NEGOTIABLE)

Quoted phrases inside these rules illustrate the INTENT of a move — they
are NOT fixed wording. Compose every sentence freshly, in your own words,
differently from any previous greeting. Copying an example phrase verbatim
two days in a row is a contract failure.

1. WARMTH BEFORE FACTS. Open with the time-of-day salutation in
   ${langCode} + the user's first name (if known) + ONE warmth
   clause ("schön, dass du wieder da bist" / "glad to have you back"
   / equivalent). NEVER go from the salutation straight into a stat.

2. JOURNEY CONTEXT FIRST — BRANCH ON \`journey.plan_phase\`. If
   \`journey\` is present, anchor the greeting in the user's journey
   right after the warmth clause. The framing depends on plan_phase:

   - plan_phase === 'default_active' (scaffolding plan still running,
     no personalized goal yet): name the day + the wave —
     "Heute ist Tag X von Y in deinem Start-Plan, du bist gerade in
     der [current_wave.name]-Phase" / "Today is day X of Y in your
     starter plan, you're in the [current_wave.name] phase". The
     wave gives the user a sense of WHERE they are in the onboarding
     arc.

   - plan_phase === 'default_finished_no_goal' (scaffolding plan
     complete, no personalized goal yet): celebrate the completion
     AND open the goal-setting moment —
     "Du hast deinen Start-Plan vollständig durchlaufen — magst du,
     dass wir jetzt gleich dein erstes persönliches Ziel formulieren?"
     / "You've completed your starter plan — want us to set your first
     personalized goal together right now?". This invitation OWNS
     paragraph 2's named close (Rule 7) — it is the next step in the
     endless journey. Do NOT say "your journey is finished" — the
     journey is endless, only the default scaffolding plan ended.

   - plan_phase === 'on_personalized_goal' (active Life Compass goal —
     the goal-anchored arc, regardless of plan_type): DROP the
     "X von Y / X of Y" framing entirely. The user is no longer on
     scaffolding — they are on their own arc. Anchor instead on the
     goal:
       "Heute ist dein {day_in_journey}. Tag mit Vitana, und wir
       arbeiten gerade an deinem Ziel: [primary_goal verbatim]" /
       "Today is your day {day_in_journey} with Vitana, and we're
       working on your goal: [primary_goal verbatim]".
     If \`current_goal_day\` is set, you may add "seit {current_goal_day}
     Tagen". If \`previous_goals_count\` > 0, you may weave in
     "dein {previous_goals_count + 1}. Ziel mit mir" — the goal
     arc length, the user's history.
     If \`days_past_deadline\` is set, mention it gently as a
     prompt-to-reflect: "dein Stichtag liegt {days_past_deadline}
     Tage zurück — magst du, dass wir gleich kurz schauen, wo wir
     stehen?". Do NOT treat the past deadline as failure.

   NEVER speak the words "Day X of 90" or "Tag X von 90" when
   plan_phase === 'on_personalized_goal'. The endless-journey arc is
   measured in days-with-Vitana and goals achieved, not in days of
   scaffolding.

3. NO BARE NUMBERS. Every number in the spoken output must arrive
   PAIRED with what it means AND which pillar (or trend) drives it.
   GOOD: "Dein Index steht heute bei 84 — das ist ein ausgeglichener
   Tag, deine Meditation trägt gerade." FORBIDDEN: "Dein Index liegt
   bei 84." with no interpretation. Use \`vitana_index.weakest_pillar\`,
   \`strongest_pillar\`, \`trend_7d\`, \`balance_label\` to interpret.

4. GOAL AS NORTH STAR. The Life Compass goal anchors the entire day
   WHEN IT IS SET. Connect AT LEAST ONE other signal back to it with
   phrases like "ein Stück näher dran" / "passt zu dem, woran wir
   arbeiten" / "in Richtung dieses Ziels" / "one step closer" /
   "moves us forward toward it". NEVER read the goal as a database
   row. Weave it into a sentence that orbits something else.

5. CONNECTIVE TISSUE. Use AT LEAST THREE spoken-language stitches
   across the two paragraphs. Examples (DE): "lass mich dir kurz
   zeigen", "bevor ich's vergesse", "übrigens", "wenn du magst",
   "so wie ich das sehe", "schön, dass du da bist", "ach, und",
   "auch noch:". Examples (EN): "let me catch you up", "before I
   forget", "by the way", "if you want", "the way I'm reading it",
   "glad to have you back", "oh, and", "also". The output must
   SOUND spoken aloud, not read from a screen.

6. SETUP-GAP IS INVITATION, NEVER DEFICIT. Each signal has a SETUP
   STATE. When a signal is NOT SET UP (life_compass.state='not_set',
   vitana_index.state='not_set_up', autopilot.state='none_yet',
   diary_last_7d=0), phrase as a gentle invitation: "mir ist
   aufgefallen, dass dein Life Compass noch nicht eingerichtet ist —
   magst du, dass wir das gleich gemeinsam machen?" / "your Life
   Compass isn't set up yet — want us to do that together right now?".
   NEVER as a deficit ("du hast keinen Index" / "you don't have an
   Index"). Each setup invitation must explicitly OFFER PARTNERSHIP
   ("gemeinsam" / "zusammen" / "together") and propose taking the
   next step now or naming a moment to come back to it. This is the
   coaching move — every gap is an opportunity for Vitana to guide.

7. NAMED CONCRETE CLOSE WITH AUTOPILOT PRIORITY. The closing line
   proposes ONE specific first move, tied to a real signal, NAMING
   it. PRIORITY ORDER:
     a. If \`autopilot.today_checkpoint\` exists → name its title and
        offer to start: "ich hab den nächsten Schritt für dich
        vorbereitet: [title]. Soll ich's starten?" / "I've prepared
        the next step for you: [title]. Want me to start it?".
     b. Else if any setup gap is open → close on the setup invitation
        from Rule 6.
     c. Else if calendar_today.next exists → offer prep: "soll ich
        dir kurz die Vorbereitung für [title] rauslegen?".
     d. Else if messages_unread > 0 → offer to walk through.
     e. Else open question: "womit darf ich dir zuerst zur Hand
        gehen, [first specific named option] oder [second named
        option]?". NEVER a bare "Was möchtest du tun?".
   FORBIDDEN: generic "Was möchtest du zuerst machen?" / "What would
   you like to do first?" / "How can I help you?".

8. PARAGRAPH BREAK. Speak TWO short paragraphs with a real breath
   between them. NEVER one wall of facts. Paragraph 1 anchors:
   greeting + warmth + journey context + index-with-meaning + goal-
   as-North-Star. Paragraph 2 catches up: time-sensitive signals
   (calendar, messages, reminders) and the autopilot-or-setup-gap
   close.

9. OPINION + REASSURANCE. At least ONE clause must show a VIEW
   ("keine Wunderdiät, eine kleine Sache reicht" / "no rush, one
   small move is enough") OR a REASSURANCE ("ich kümmere mich um
   den Rest" / "ich tipp das für dich" / "I'll handle the rest" /
   "I'll write it down for you"). Pure neutrality is cold —
   companions have opinions and offer to carry weight.

10. COVERAGE ENFORCEMENT. Before you stop speaking, walk the
    COVERAGE CHECKLIST above. If any "ADDRESS" item is unanswered,
    keep going. Below 4 sentences = contract failure. The shape
    example covers FIVE signals; aim for similar breadth.

## PAYLOAD COVERAGE — ORDER (woven, never listed)

Use every payload key that has data OR has a setup gap. Weave them
into the two paragraphs:
  a. journey                    → P1: day + wave name (Rule 2)
  a2. guided_journey            → P1: BOTH the session COUNT ("du hast schon X
                                  Sessions geschafft") AND the NAMED next session
                                  ("deine nächste Session ist Y") + where-we-left-off
                                  continuity. Never collapse to a generic "next step".
  b. vitana_index (state=ok)    → P1: number + meaning + pillar (Rule 3)
  c. vitana_index (not_set_up)  → P2: invitation to set up (Rule 6)
  d. life_compass (state=set)   → P1: woven anchor (Rule 4)
  e. life_compass (not_set)     → P2: invitation to set up (Rule 6)
  f. calendar_today             → P2: next event by title + local time
  g. autopilot.today_checkpoint → P2: NAMED CLOSE (Rule 7a)
  h. autopilot (none_yet)       → P2: invitation to generate first one
  i. matches_unread > 0         → P2: offer to look together
  j. messages_unread > 0        → P2: count only, never quote content
  k. reminders_today.count > 0  → P2: name next reminder
  l. diary_last_7d === 0        → P2: invitation to capture today
  m. diary_last_7d >= 1         → silent (not noteworthy)

## HARD RULES (NEVER VIOLATE)

  - NEVER recite signals as a bulleted list. Speak in flowing paragraphs.
  - NEVER fabricate names, titles, or counts not in the payload.
  - NEVER use the word "overview" / "Übersicht" / "Zusammenfassung"
    as a label.
  - NEVER ask "How can I help you?" / "Was möchtest du tun?" /
    "Was möchtest du zuerst machen?" as the close (Rule 7).
  - NEVER speak a number without meaning + pillar attribution (Rule 3).
  - NEVER read the Life Compass goal as a database row (Rule 4).
  - NEVER frame a setup gap as a deficit (Rule 6).
  - NEVER stop after one signal — walk the COVERAGE CHECKLIST (Rule 10).
  - NEVER lecture about Vitanaland's company / business model /
    longevity economy positioning.

## LENGTH

TWO short paragraphs. Across the two: 5 to 8 sentences total. Each
clause earns its place by being concrete. Resist verbosity, but
NEVER collapse to a single paragraph and NEVER fewer than 4
sentences total. The shape example above is the length and pacing
target.

## STRUCTURED PAYLOAD

\`\`\`json
${payloadJson}
\`\`\`

This block OVERRIDES every other greeting rule for the first turn.
Subsequent turns follow the normal conversation flow.`;
}

// ---------------------------------------------------------------------------
// Coverage checklist — computed per-payload, fed to the model as the
// inventory of things it must address before stopping.
// ---------------------------------------------------------------------------

function buildCoverageChecklist(
  p: OverviewPayload,
  deltas: Record<string, FactDelta> = {},
): string {
  const items: string[] = [];
  // Spoken-facts continuity: a number the user already heard (unchanged)
  // must not be restated; a changed number is spoken as its change.
  const status = (key: string) => deltas[key]?.status ?? 'new';
  const changeOf = (key: string) => deltas[key]?.delta ?? null;

  if (p.journey) {
    const j = p.journey;
    if (j.plan_phase === 'on_personalized_goal') {
      // Goal-anchored arc — no "X of Y" framing.
      const goalArc = j.previous_goals_count > 0
        ? ` This is goal number ${j.previous_goals_count + 1} in the user arc.`
        : ' This is the first personalized goal for this user.';
      const goalDayHint = j.current_goal_day !== null
        ? ` Day ${j.current_goal_day} on this goal.`
        : '';
      const deadlineHint = j.days_past_deadline !== null
        ? ` ⚠ Target date passed ${j.days_past_deadline} days ago — mention gently, never as failure.`
        : '';
      items.push(`- [ ] ADDRESS (Rule 2, plan_phase='on_personalized_goal'): Day ${j.day_in_journey} with Vitana, working on the active Life Compass goal.${goalArc}${goalDayHint}${deadlineHint} DO NOT use "Tag X von 90" framing.`);
    } else if (j.plan_phase === 'default_finished_no_goal') {
      items.push(`- [ ] ADDRESS (Rule 2, plan_phase='default_finished_no_goal'): User has completed the ${j.default_plan_total_days}-day starter plan (now day ${j.day_in_journey}) but has NOT set a personalized goal. Open the goal-setting moment — this becomes the named close (Rule 7).`);
    } else {
      // default_active
      const waveHint = j.current_wave
        ? `, currently in "${j.current_wave.name}" phase (day ${j.current_wave.day_in_wave}, ${j.current_wave.days_to_next_wave ?? '?'} days to next wave)`
        : '';
      items.push(`- [ ] ADDRESS (Rule 2, plan_phase='default_active'): Day ${j.day_in_journey} of ${j.default_plan_total_days} in the starter plan${waveHint}.`);
    }
  }

  if (
    p.guided_journey &&
    (p.guided_journey.sessions_completed > 0 ||
      p.guided_journey.topics_learned > 0 ||
      p.guided_journey.next_session_title ||
      p.guided_journey.last_session_recall)
  ) {
    const g = p.guided_journey;
    const topicsClause =
      g.topics_total != null ? `${g.topics_learned} of ${g.topics_total} topics` : `${g.topics_learned} topics`;
    const recallHint = g.last_session_recall
      ? ` Last time the thread was "${g.last_session_recall}" — continue it (continuity, not a status line). If it equals the next session, frame as "let's carry on with it".`
      : '';
    const nextClause = g.next_session_title
      ? `Their next session is "${g.next_session_title}".`
      : 'Offer the next session.';
    // Momentum beat is LEDGER-CONDITIONAL: the running total is only news
    // the first time (or when it moved). An unchanged count restated every
    // morning is the robotic repeat the user reported.
    const sessStatus = status('sessions_completed');
    const momentumLine =
      sessStatus === 'unchanged'
        ? `    • MOMENTUM: the user ALREADY KNOWS they have completed ${g.sessions_completed} sessions (${topicsClause}) — you told them and nothing changed. Do NOT restate the count. Carry the momentum without numbers (the thread, not the tally).\n`
        : sessStatus === 'changed' && (changeOf('sessions_completed') ?? 0) > 0
          ? `    • MOMENTUM: the user completed ${changeOf('sessions_completed')} more session(s) since you last mentioned it (now ${g.sessions_completed} total, ${topicsClause}). Speak the ADVANCE — the progress since last time is the news, not the running total.\n`
          : `    • MOMENTUM: the user has completed ${g.sessions_completed} guided sessions (${topicsClause}). You may state this once, concretely — compose the sentence yourself.\n`;
    items.push(
      `- [ ] ADDRESS (guided journey):\n` +
        momentumLine +
        `    • NEXT SESSION (named, never generic "next step"): ${nextClause} Name it and offer to do it together.${recallHint}\n` +
        `    (This learning beat is what makes the briefing feel like a continuing journey — it is NOT optional when the user is in the guided curriculum.)`,
    );
  }

  if (p.vitana_index.state === 'ok' && p.vitana_index.today !== null) {
    const pillarHint = p.vitana_index.weakest_pillar
      ? ` Weakest pillar: ${p.vitana_index.weakest_pillar.name} (${p.vitana_index.weakest_pillar.score}). Strongest: ${p.vitana_index.strongest_pillar?.name ?? 'n/a'}.`
      : '';
    const trendHint = p.vitana_index.trend_7d !== null
      ? ` 7-day trend: ${p.vitana_index.trend_7d >= 0 ? '+' : ''}${p.vitana_index.trend_7d}.`
      : '';
    const idxHint =
      status('vitana_index') === 'unchanged'
        ? ' NOTE: the Index value is UNCHANGED since you last told the user — do not announce the number as news; interpret the stability ("dein Index hält sich stabil") or what drives it instead.'
        : '';
    items.push(`- [ ] ADDRESS: Vitana Index ${p.vitana_index.today} (${p.vitana_index.tier ?? 'tier unknown'}, ${p.vitana_index.balance_label ?? 'balance unknown'}).${pillarHint}${trendHint} (Rule 3 — pair number with meaning + pillar attribution.)${idxHint}`);
  } else {
    items.push(`- [ ] ADDRESS: Vitana Index is NOT SET UP — invite the user to set it up together (Rule 6, P2).`);
  }

  if (p.life_compass.state === 'set' && p.life_compass.primary_goal) {
    const progressHint = p.life_compass.goal_progress_pct !== null
      ? ` Time progress: ${p.life_compass.goal_progress_pct}%.`
      : '';
    const deadlineHint = p.life_compass.days_to_deadline !== null
      ? ` Days to deadline: ${p.life_compass.days_to_deadline}.`
      : '';
    items.push(`- [ ] ADDRESS: Life Compass goal "${p.life_compass.primary_goal}" verbatim.${progressHint}${deadlineHint} (Rule 4 — North Star, woven not listed.)`);
  } else {
    items.push(`- [ ] ADDRESS: Life Compass is NOT SET — invite the user to set it up together (Rule 6, P2).`);
  }

  if (p.calendar_today.count > 0 && p.calendar_today.next) {
    items.push(`- [ ] ADDRESS: ${p.calendar_today.count} event(s) today. Next: "${p.calendar_today.next.title}" at ${p.calendar_today.next.start_iso}. (P2 — name title + local time.)`);
  }

  if (p.calendar_passed.count > 0 && p.calendar_passed.most_recent) {
    items.push(`- [ ] MAY ADDRESS: ${p.calendar_passed.count} event(s) since last session — most recent "${p.calendar_passed.most_recent.title}". (Only mention if it's informative.)`);
  }

  if (p.autopilot.state === 'has_actions' && p.autopilot.today_checkpoint) {
    items.push(`- [ ] ADDRESS (CLOSE): Autopilot has prepared "${p.autopilot.today_checkpoint.title}" for the user — name it and offer to start it (Rule 7a — this becomes the NAMED CLOSE).`);
  } else if (p.autopilot.state === 'none_yet') {
    items.push(`- [ ] ADDRESS: Autopilot has not generated any recommendations yet — invite the user to set up their first one (Rule 6, P2).`);
  }

  if (p.matches_unread > 0) {
    const s = status('matches_unread');
    if (s === 'unchanged') {
      items.push(
        `- [ ] OPTIONAL: the user already knows about their ${p.matches_unread} open match(es) (unchanged since last mentioned). Do NOT restate the count; mention matches only number-free if you connect them to something new.`,
      );
    } else if (s === 'changed' && (changeOf('matches_unread') ?? 0) > 0) {
      items.push(
        `- [ ] ADDRESS: ${changeOf('matches_unread')} NEW match(es) since you last mentioned it — speak the new ones, not the total. Offer to look together. (P2.)`,
      );
    } else {
      items.push(`- [ ] ADDRESS: ${p.matches_unread} unread match notification(s) — offer to look together. (P2.)`);
    }
  }

  if (p.messages_unread > 0) {
    const s = status('messages_unread');
    if (s === 'unchanged') {
      items.push(
        `- [ ] OPTIONAL: the user already knows about their ${p.messages_unread} unread message(s) (unchanged since last mentioned). Do NOT restate the count. At most a soft, number-free nod ("deine Nachrichten warten noch") — or skip it entirely.`,
      );
    } else if (s === 'changed' && (changeOf('messages_unread') ?? 0) > 0) {
      items.push(
        `- [ ] ADDRESS: ${changeOf('messages_unread')} NEW message(s) arrived since you last mentioned the inbox — speak the new ones ("${changeOf('messages_unread')} neue seit …"), never the running total. Count only, NEVER quote content. (P2.)`,
      );
    } else {
      items.push(`- [ ] ADDRESS: ${p.messages_unread} unread message(s) — count only, NEVER quote content. (P2.)`);
    }
  }

  if (p.reminders_today.count > 0 && p.reminders_today.next) {
    items.push(`- [ ] ADDRESS: ${p.reminders_today.count} reminder(s) due today. Next: "${p.reminders_today.next.action_text}" at ${p.reminders_today.next.next_fire_at}. (P2.)`);
  }

  if (p.diary_last_7d === 0) {
    items.push(`- [ ] ADDRESS: 0 diary entries in the last 7 days — invite a brief entry, gently (Rule 6, P2).`);
  }

  // Felt learning (BOOTSTRAP-MEMORY-DAILY-LEARNING): the user should FEEL
  // that Vitana learned something about them since last time. Guarded by the
  // ledger like every other number — never restated once spoken.
  if (p.facts_learned_since_last && p.facts_learned_since_last.count > 0) {
    if (status('facts_learned') !== 'unchanged') {
      const sample = p.facts_learned_since_last.sample
        .map((f) => `${f.key.replace(/_/g, ' ')} = "${f.value}"`)
        .join('; ');
      items.push(
        `- [ ] ADDRESS: since you last spoke you LEARNED ${p.facts_learned_since_last.count} new thing(s) about the user (${sample}). Weave exactly ONE naturally into the greeting ("ich habe mir gemerkt, dass …") — warm, specific, never a recited list and never the raw key names. This is the moment the user feels you grow with them. (P2.)`,
      );
    }
  }

  if (items.length === 0) {
    return '- [ ] (No applicable items — speak a warm short greeting and ask the user what they want to focus on.)';
  }

  return items.join('\n');
}

// ---------------------------------------------------------------------------
// Compact payload — what we hand to the model as the structured data
// block. Strips truly-empty fields, keeps setup-state markers intact.
// ---------------------------------------------------------------------------

function compactPayloadForPrompt(p: OverviewPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.journey) out.journey = p.journey;
  if (p.vitana_index.state === 'ok') {
    out.vitana_index = {
      today: p.vitana_index.today,
      tier: p.vitana_index.tier,
      tier_framing: p.vitana_index.tier_framing,
      trend_7d: p.vitana_index.trend_7d,
      weakest_pillar: p.vitana_index.weakest_pillar,
      strongest_pillar: p.vitana_index.strongest_pillar,
      balance_label: p.vitana_index.balance_label,
      pillars: p.vitana_index.pillars,
      projected_day_90: p.vitana_index.projected_day_90,
      projected_day_90_tier: p.vitana_index.projected_day_90_tier,
    };
  } else {
    out.vitana_index = { state: p.vitana_index.state };  // signals setup gap
  }
  if (p.life_compass.state === 'set') {
    out.life_compass = {
      primary_goal: p.life_compass.primary_goal,
      category: p.life_compass.category,
      target_date: p.life_compass.target_date,
      target_value: p.life_compass.target_value,
      target_unit: p.life_compass.target_unit,
      starting_value: p.life_compass.starting_value,
      days_to_deadline: p.life_compass.days_to_deadline,
      goal_progress_pct: p.life_compass.goal_progress_pct,
    };
  } else {
    out.life_compass = { state: 'not_set' };  // signals setup gap
  }
  if (p.calendar_today.count > 0 || p.calendar_today.next) out.calendar_today = p.calendar_today;
  if (p.calendar_passed.count > 0 || p.calendar_passed.most_recent) out.calendar_passed = p.calendar_passed;
  if (p.autopilot.state === 'has_actions') {
    if (p.autopilot.today_checkpoint || p.autopilot.pending_total > 0) {
      out.autopilot = {
        today_checkpoint: p.autopilot.today_checkpoint,
        this_week: p.autopilot.this_week,
        pending_total: p.autopilot.pending_total,
      };
    }
  } else {
    out.autopilot = { state: 'none_yet' };  // signals setup gap
  }
  if (p.matches_unread > 0) out.matches_unread = p.matches_unread;
  if (p.messages_unread > 0) out.messages_unread = p.messages_unread;
  if (p.reminders_today.count > 0 || p.reminders_today.next) out.reminders_today = p.reminders_today;
  if (
    p.guided_journey &&
    (p.guided_journey.sessions_completed > 0 ||
      p.guided_journey.topics_learned > 0 ||
      p.guided_journey.next_session_title ||
      p.guided_journey.last_session_recall)
  ) {
    out.guided_journey = p.guided_journey;
  }
  out.diary_last_7d = p.diary_last_7d;
  if (p.facts_learned_since_last && p.facts_learned_since_last.count > 0) {
    out.facts_learned_since_last = p.facts_learned_since_last;
  }
  if (p.last_session_date_user_tz) out.last_session_date_user_tz = p.last_session_date_user_tz;
  return out;
}
