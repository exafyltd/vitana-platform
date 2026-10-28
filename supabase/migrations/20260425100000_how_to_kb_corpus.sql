-- =============================================================================
-- How-To KB Corpus (BOOTSTRAP-TEACH-BEFORE-REDIRECT Phase 1)
-- Date: 2026-04-25
--
-- Seeds 9 procedural how-to docs into the Knowledge Hub `vitana_system`
-- namespace. These complement the conceptual Book of the Vitana Index:
--   - Book chapters explain WHY (longevity, the five pillars, balance).
--   - How-to docs explain HOW (which buttons, which order, expected outcome).
--
-- The voice runtime calls explain_feature() for the same topics; the KB
-- docs are the long-form prose users can browse via search_knowledge or
-- the Command Hub System Knowledge tab.
--
-- Idempotent via upsert_knowledge_doc() (upsert on path). Safe to re-run.
-- =============================================================================

BEGIN;

-- ===========================================================================
-- 1. Log hydration manually
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to log hydration manually',
  p_path  := 'kb/vitana-system/how-to/log-hydration-manually.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','hydration','daily-diary','manual-log'],
  p_content := $CONTENT$
# How to log hydration manually

## What it is
Recording how much you drink across the day so your Hydration pillar has signal to score from. The fastest manual path is voice dictation into Daily Diary.

## Why it matters for your Index
Hydration is one of five pillars (max 200 each). Without logged data, your Hydration sub-score "data" component sits at zero — even if you drink plenty, the system can't see it. A few daily voice notes change that immediately.

## Steps
1. Open Daily Diary from the bottom navigation.
2. Tap the microphone button.
3. Say something natural, like *"I drank 500 millilitres of water this morning"* or *"Just finished a big glass of water with lunch"*.
4. Tap done. The system parses your sentence into a hydration entry automatically.
5. Your Hydration pillar updates within a few minutes.

## Expected outcome
A new diary entry appears with the hydration amount the system extracted. Within a recompute cycle (minutes), your Hydration pillar's "data" sub-score reflects the new entry.

## Pitfalls
- Vague phrasing ("I drank some water") records the action but not the amount — being specific lifts the score more.
- Logging in past dates doesn't count toward today's streak.
- A connected smart bottle (HidrateSpark, Apple Health Water) is more accurate than dictation; dictation is the gap-filler.

## Related
- [Connect a health tracker](kb/vitana-system/how-to/connect-health-tracker.md)
- [Use Daily Diary dictation](kb/vitana-system/how-to/use-daily-diary-dictation.md)
- [Book — Hydration chapter](kb/vitana-system/index-book/02-hydration.md)
$CONTENT$
);

-- ===========================================================================
-- 2. Log nutrition manually
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to log nutrition manually',
  p_path  := 'kb/vitana-system/how-to/log-nutrition-manually.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','nutrition','daily-diary','manual-log'],
  p_content := $CONTENT$
# How to log nutrition manually

## What it is
Recording what you eat through Daily Diary dictation. The system parses your description into a nutrition entry that feeds your Nutrition pillar.

## Why it matters for your Index
Nutrition (max 200) is the single largest lever in your Vitana Index for most users. Even a quick description of your meals — without weighing or counting calories — gives the system enough signal to score consistency, balance, and macro variety.

## Steps
1. Open Daily Diary.
2. Tap the microphone.
3. Describe your meal naturally, like *"I had oatmeal with berries and a coffee for breakfast"* or *"Lunch was a chicken salad with olive oil and a piece of bread"*.
4. Save the entry. The system parses it into a nutrition log.
5. Your Nutrition pillar updates within a few minutes.

## Expected outcome
A diary entry with the meal contents appears. The Nutrition pillar's "data" sub-score reflects the entry on next recompute.

## Pitfalls
- Vague entries ("had food") log the action but contribute little to scoring — describe what you actually ate.
- Logging multiple meals in one entry is fine — the system handles it. *"Breakfast was eggs, lunch was a sandwich, dinner was salmon and rice."*
- A connected nutrition app (MyFitnessPal, Cronometer) is more precise; dictation is the daily backbone.

## Related
- [Connect a health tracker](kb/vitana-system/how-to/connect-health-tracker.md)
- [Use Daily Diary dictation](kb/vitana-system/how-to/use-daily-diary-dictation.md)
- [Book — Nutrition chapter](kb/vitana-system/index-book/01-nutrition.md)
$CONTENT$
);

-- ===========================================================================
-- 3. Log exercise manually
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to log exercise manually',
  p_path  := 'kb/vitana-system/how-to/log-exercise-manually.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','exercise','daily-diary','manual-log'],
  p_content := $CONTENT$
# How to log exercise manually

## What it is
Recording physical activity through Daily Diary dictation when no tracker is on (or for a one-off session). A connected wearable like Apple Health or Strava gives richer data, but dictation works.

## Why it matters for your Index
Exercise (max 200) covers movement, intensity, and recovery. Without signal, the pillar relies only on your survey baseline — which is a prior, not a verdict. Logging real sessions lifts your Exercise sub-scores meaningfully.

## Steps
1. Open Daily Diary.
2. Tap the microphone.
3. Describe what you did, like *"I walked 30 minutes this morning"* or *"I did a 45-minute strength workout at the gym, mostly upper body"*.
4. Save. The system logs it for your Exercise pillar.

## Expected outcome
A diary entry with the activity description. Exercise pillar reflects it after recompute.

## Pitfalls
- Mention duration AND intensity if you can ("30 minutes brisk walk" beats "I walked").
- Steps from a phone or wearable are the cleanest signal — dictation is the supplement.
- Recovery counts too: *"Took a rest day, gentle 15-minute mobility"* is a valid entry.

## Related
- [Connect a health tracker](kb/vitana-system/how-to/connect-health-tracker.md)
- [Use Daily Diary dictation](kb/vitana-system/how-to/use-daily-diary-dictation.md)
- [Book — Exercise chapter](kb/vitana-system/index-book/03-exercise.md)
$CONTENT$
);

-- ===========================================================================
-- 4. Log sleep manually
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to log sleep manually',
  p_path  := 'kb/vitana-system/how-to/log-sleep-manually.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','sleep','daily-diary','manual-log'],
  p_content := $CONTENT$
# How to log sleep manually

## What it is
Recording how you slept by dictating into Daily Diary in the morning. A wearable (Oura, Whoop, Apple Watch) is more accurate, but a quick voice note feeds the Sleep pillar baseline.

## Why it matters for your Index
Sleep (max 200) is the recovery pillar — it disproportionately affects every other pillar. Even a one-line note about duration and how rested you feel gives the system signal.

## Steps
1. In the morning, open Daily Diary.
2. Tap the microphone.
3. Say something like *"I slept from 11 PM to 6:30 AM, woke up rested"* or *"Got about 6 hours, kept waking up"*.
4. Save. The system records it for your Sleep pillar.

## Expected outcome
A diary entry with sleep duration and quality. Sleep pillar updates after recompute.

## Pitfalls
- Mention BOTH duration and quality — the system tracks them as separate signals.
- Logging morning-of is more accurate than guessing later in the day.
- A sleep tracker (Oura, Whoop, Apple Sleep) gives stage data that dictation can't — pair both if possible.

## Related
- [Connect a health tracker](kb/vitana-system/how-to/connect-health-tracker.md)
- [Use Daily Diary dictation](kb/vitana-system/how-to/use-daily-diary-dictation.md)
- [Book — Sleep chapter](kb/vitana-system/index-book/04-sleep.md)
$CONTENT$
);

-- ===========================================================================
-- 5. Log mental state manually
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to log mental state manually',
  p_path  := 'kb/vitana-system/how-to/log-mental-state-manually.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','mental','daily-diary','manual-log'],
  p_content := $CONTENT$
# How to log mental state manually

## What it is
Recording how you feel — mood, stress, what's on your mind — by dictating into Daily Diary. Even a sentence helps the system extract your mental state for the Mental pillar.

## Why it matters for your Index
Mental (max 200) covers stress, mood, mindfulness, and cognitive load. It's the hardest pillar to track from sensors alone — dictation is often the primary signal source.

## Steps
1. Open Daily Diary.
2. Tap the microphone.
3. Say what's on your mind, like *"feeling a bit stressed about the meeting today, took 10 minutes to meditate this morning"* or *"calm and clear, slept well"*.
4. Save. The system records it for your Mental pillar.

## Expected outcome
A diary entry with extracted mental signals (mood, stress level, mindfulness mentions). Mental pillar reflects it on recompute.

## Pitfalls
- Honesty matters more than positivity — the Index isn't graded on cheerful tone.
- Mention specific practices ("meditated 10 minutes", "journaled") — they count toward sub-scores.
- A mood-tracking app or HRV tracker (Oura readiness) supplements dictation; both can run.

## Related
- [Use Daily Diary dictation](kb/vitana-system/how-to/use-daily-diary-dictation.md)
- [Book — Mental chapter](kb/vitana-system/index-book/05-mental.md)
$CONTENT$
);

-- ===========================================================================
-- 6. Use Daily Diary dictation (the foundational how-to)
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to use Daily Diary dictation',
  p_path  := 'kb/vitana-system/how-to/use-daily-diary-dictation.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','daily-diary','dictation','foundational'],
  p_content := $CONTENT$
# How to use Daily Diary dictation

## What it is
Daily Diary is the single voice-first surface for everything you can't (or don't want to) measure with a sensor. You speak; the system parses your words into health entries — food, water, exercise, sleep, mood — and saves them as your personal log. It's the manual counterpart to your trackers.

## Why it matters for your Index
Four of the five Vitana pillars (Nutrition, Hydration, Exercise, Sleep, Mental) accept signal from dictation. For users without wearables — and for any signal a wearable can't capture (mood, stress, food quality) — Daily Diary is the primary input. **The system can only score what it knows about.**

## Steps
1. Open Daily Diary from the bottom navigation.
2. Tap the microphone to start dictation.
3. Speak naturally — full sentences are fine. You can mention multiple things in one entry: *"Slept 7 hours, had eggs and toast for breakfast, going for a walk after lunch."*
4. Tap done. The system saves your entry and feeds the relevant pillars of your Vitana Index.
5. You can dictate multiple times a day — morning, midday, evening — to keep your day captured.

## Expected outcome
Your diary fills with timestamped entries. Each entry contributes to the relevant pillar's "data" sub-score. The Index recomputes within minutes of each save.

## Pitfalls
- One long entry per day works, but multiple short entries throughout the day give richer signal.
- The system parses on language, not punctuation — speak naturally, not in keywords.
- Diary entries are private to you — they're never shared with the community.
- If the parser misinterprets you, edit the entry to correct — your edits train future parsing.

## Related
- [Log hydration manually](kb/vitana-system/how-to/log-hydration-manually.md)
- [Log nutrition manually](kb/vitana-system/how-to/log-nutrition-manually.md)
- [Log exercise manually](kb/vitana-system/how-to/log-exercise-manually.md)
- [Log sleep manually](kb/vitana-system/how-to/log-sleep-manually.md)
- [Log mental state manually](kb/vitana-system/how-to/log-mental-state-manually.md)
$CONTENT$
);

-- ===========================================================================
-- 7. Connect a health tracker
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to connect a health tracker',
  p_path  := 'kb/vitana-system/how-to/connect-health-tracker.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','integrations','tracker','wearable'],
  p_content := $CONTENT$
# How to connect a health tracker

## What it is
Connecting a wearable, app, or sensor so it streams data into your Vitana Index automatically — instead of (or alongside) manual dictation. Once paired, your Vitana pillars draw from live data every day.

## Why it matters for your Index
A connected tracker gives your Index its richest signal. Every pillar accepts wearable data:
- **Nutrition** — MyFitnessPal, Cronometer, biomarker labs.
- **Hydration** — HidrateSpark, Apple Health Water.
- **Exercise** — Apple Health, Google Fit, Strava, Whoop, Oura, Garmin.
- **Sleep** — Oura, Whoop, Eight Sleep, Apple Sleep.
- **Mental** — Apple Health Mindful Minutes, Calm, Headspace, mood-tracking apps.

## Steps
1. Open the Integrations section in your Settings.
2. Pick the tracker or app you want to connect.
3. Today, log a single integration entry that points the system at your data source.
4. When native OAuth ships for that partner, you'll get a one-tap connect flow — and your Index will start drawing from the live data.

## Expected outcome
The integration appears as connected in your Settings. Each day, the relevant pillar's "data" sub-score and "streak" sub-score climb as data flows in.

## Pitfalls
- Connecting one tracker that covers multiple pillars (Apple Health, Google Fit) is a bigger jump than connecting five single-purpose apps.
- Trackers don't replace Daily Diary — they supplement it. Mood, stress, meal quality still need words.
- If a partner shows as `unavailable` in the catalog, native OAuth isn't ready yet — manual integration is the path until then.

## Related
- [Use Daily Diary dictation](kb/vitana-system/how-to/use-daily-diary-dictation.md)
- [Improve your Vitana Index](kb/vitana-system/how-to/improve-your-vitana-index.md)
$CONTENT$
);

-- ===========================================================================
-- 8. Improve your Vitana Index
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to improve your Vitana Index',
  p_path  := 'kb/vitana-system/how-to/improve-your-vitana-index.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','vitana-index','improve'],
  p_content := $CONTENT$
# How to improve your Vitana Index

## What it is
Practical guidance on the fastest, most durable ways to lift your Vitana Index — what works, in what order, and why.

## Why it matters
Your Vitana Index moves when you do small daily things across the five pillars (Nutrition, Hydration, Exercise, Sleep, Mental) AND when you keep them in balance. The scoring formula has a balance factor that dampens lopsided practice — so maxing one pillar while ignoring the rest doesn't work.

## Steps
1. **Find your weakest pillar.** Open the Index Detail screen. The lowest bar is where every point of effort gives the biggest lift.
2. **Pick one small action.** Either activate one Autopilot suggestion targeting that pillar, or dictate one entry into Daily Diary today.
3. **Repeat tomorrow.** Streaks of 7 days lift sub-scores noticeably (from 0 to +15 streak bonus per pillar).
4. **Connect a tracker for one pillar.** Apple Health is the broadest single connection — it covers Exercise, Sleep, and Hydration in one OAuth.
5. **Keep balance.** It's better to do 4-out-of-5 pillars at a moderate level than to max one and ignore the rest. The balance factor multiplies your raw score by 0.7–1.0 based on the gap between your strongest and weakest pillars.

## Expected outcome
At a moderate engagement pace (3–4 small actions per week + Daily Diary entries), users typically see the Index climb 50–100 points over a 90-day window. *Really good* (600+) is the aspirational Day-90 target. *Elite* (800+) is months of sustained practice.

## Pitfalls
- Trying to max your strongest pillar feels productive but the balance factor caps the return — diversify.
- Skipping Daily Diary on busy days breaks streaks. Even one short entry preserves the streak.
- Don't compare to other users — different lives have different capacities. The Index measures *your* trajectory, not a leaderboard position.

## Related
- [What is Autopilot](kb/vitana-system/how-to/what-is-autopilot.md)
- [Connect a health tracker](kb/vitana-system/how-to/connect-health-tracker.md)
- [Book — Reading your number](kb/vitana-system/index-book/08-reading-your-number.md)
- [Book — Balance](kb/vitana-system/index-book/06-balance.md)
$CONTENT$
);

-- ===========================================================================
-- 9. What is Autopilot
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'What is Autopilot',
  p_path  := 'kb/vitana-system/how-to/what-is-autopilot.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','autopilot','foundational'],
  p_content := $CONTENT$
# What is Autopilot

## What it is
Autopilot is the engine that watches your Vitana Index and suggests the next small action that would lift it the most. Each suggestion shows which pillar it targets and roughly how many points it would move you. You activate, you complete, you climb.

## Why it matters for your Index
Autopilot personalises the climb. Instead of guessing what to do, you get a ranked queue tuned to your current weakest pillar, your Life Compass goal, and what you've already done recently. The ranker dampens repeats and reinforces things you've shown engagement with.

## Steps
1. Open Autopilot from the home screen — you see a ranked list of suggestions, each tagged with the pillar it lifts (for example, *Sleep +4*) and an estimated time.
2. Activate one. The system schedules a calendar event for it.
3. Complete the event when the time comes (mark it done from the calendar or the Daily Diary).
4. Your Index recomputes within minutes; the queue regenerates with the next best suggestion.
5. Don't try to clear the whole list — pick one or two each day, balanced across pillars.

## Expected outcome
A short, always-fresh list of suggestions with pillar pills. Completing them moves your Index incrementally and updates the queue. Over weeks, the suggestions adapt to what you actually engage with vs. dismiss.

## Pitfalls
- More suggestions ≠ more progress. Quality > quantity. Two completed beats five activated-but-skipped.
- Dismissing repeatedly trains the ranker to surface less of that domain — that's the feedback loop working as designed.
- The queue refreshes after completions; if it looks stale, complete one to trigger regeneration.

## Related
- [Improve your Vitana Index](kb/vitana-system/how-to/improve-your-vitana-index.md)
- [Use Daily Diary dictation](kb/vitana-system/how-to/use-daily-diary-dictation.md)
$CONTENT$
);

COMMIT;

-- Reload the PostgREST schema cache so the new knowledge_docs rows are
-- immediately searchable via the API.
NOTIFY pgrst, 'reload schema';
