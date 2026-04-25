-- =============================================================================
-- How-To KB Corpus v2 — promotional tone refresh (BOOTSTRAP-PROMOTIONAL-DICTATION)
-- Date: 2026-04-25
--
-- Refreshes the 6 dictation-related how-to docs with promotional voice
-- copy that highlights ease, simplicity, and convenience. Same paths +
-- upsert_knowledge_doc() means voice's search_knowledge fallback now
-- finds the warmer browse-able versions when the in-memory topic library
-- doesn't match.
--
-- Idempotent. Touches only the 6 docs that needed tone refresh — the 3
-- foundational docs (improve_your_vitana_index, what_is_autopilot,
-- connect_health_tracker) keep their existing v1 copy because their
-- framing is already correct (not promo-driven).
-- =============================================================================

BEGIN;

-- ===========================================================================
-- 1. Log hydration manually (refreshed)
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to log hydration manually',
  p_path  := 'kb/vitana-system/how-to/log-hydration-manually.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','hydration','daily-diary','manual-log','promotional-v2'],
  p_content := $CONTENT$
# How to log hydration manually

## What it is
The easiest thing in the entire system. You tap the microphone in Daily Diary, say one sentence about a drink, and you're done. The system parses your voice into a hydration entry that lifts your Hydration pillar.

## Why it matters for your Index
Hydration is one of five Vitana pillars (max 200 each). Without logged data, your Hydration sub-score "data" component sits at zero — even if you drink plenty, the system can't see it. A few daily voice notes change that immediately.

## Why dictation is the right path
- **Two seconds per entry.** Faster than picking up a glass.
- **No typing on a phone keyboard.** No menus to scroll. No measuring cups. No forms.
- **Natural language.** Say it the way you'd tell a friend — "had a big glass of water" — and the system handles the parsing.
- **Works while you're doing other things.** Walking, cooking, in line for coffee.

## Steps
1. Open Daily Diary, tap the microphone.
2. Say it naturally — *"I just drank a big glass of water"*.
3. Tap done. Your Hydration pillar updates within the next minute.

## Pitfalls
- Vague phrasing ("I drank some water") records the action but not the amount — being specific lifts the score more.
- Logging in past dates doesn't count toward today's streak.
- A connected smart bottle (HidrateSpark, Apple Health Water) is more accurate than dictation; dictation is the gap-filler that always works.

## Related
- [Use Daily Diary dictation](kb/vitana-system/how-to/use-daily-diary-dictation.md)
- [Connect a health tracker](kb/vitana-system/how-to/connect-health-tracker.md)
- [Book — Hydration chapter](kb/vitana-system/index-book/02-hydration.md)
$CONTENT$
);

-- ===========================================================================
-- 2. Log nutrition manually (refreshed)
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to log nutrition manually',
  p_path  := 'kb/vitana-system/how-to/log-nutrition-manually.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','nutrition','daily-diary','manual-log','promotional-v2'],
  p_content := $CONTENT$
# How to log nutrition manually

## What it is
Logging a meal is faster than typing this sentence. You describe what you ate the way you'd tell a friend, and Daily Diary turns it into a Nutrition entry that feeds your pillar.

## Why it matters for your Index
Nutrition (max 200) is the single largest lever in your Vitana Index for most users. Even a quick description of your meals — without weighing or counting calories — gives the system enough signal to score consistency, balance, and macro variety.

## Why dictation is the right path
- **One sentence per meal.** Breakfast, lunch, snack, doesn't matter.
- **No calorie counting.** No menus to scroll through. No photos to take. No portion sizes to estimate.
- **Multiple meals in one entry are fine.** *"Eggs for breakfast, chicken salad for lunch, salmon for dinner"* lands as three logged meals.
- **Works at any moment of the day.** While the kettle's boiling, walking back from the kitchen.

## Steps
1. Open Daily Diary, tap the microphone.
2. Describe the meal in one sentence — *"I had oatmeal with berries and a coffee for breakfast"*.
3. Tap done. The system handles the rest.

## Pitfalls
- Vague entries ("had food") log the action but contribute little to scoring — describe what you actually ate.
- A connected nutrition app (MyFitnessPal, Cronometer) is more precise; dictation is the daily backbone that always works.

## Related
- [Use Daily Diary dictation](kb/vitana-system/how-to/use-daily-diary-dictation.md)
- [Connect a health tracker](kb/vitana-system/how-to/connect-health-tracker.md)
- [Book — Nutrition chapter](kb/vitana-system/index-book/01-nutrition.md)
$CONTENT$
);

-- ===========================================================================
-- 3. Log exercise manually (refreshed)
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to log exercise manually',
  p_path  := 'kb/vitana-system/how-to/log-exercise-manually.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','exercise','daily-diary','manual-log','promotional-v2'],
  p_content := $CONTENT$
# How to log exercise manually

## What it is
One sentence into Daily Diary, right after you finish moving. *"Walked 30 minutes"* or *"gym session, mostly upper body"* is enough to log a workout and feed your Exercise pillar.

## Why it matters for your Index
Exercise (max 200) covers movement, intensity, and recovery. Without signal, the pillar relies only on your survey baseline — which is a prior, not a verdict. Logging real sessions lifts your Exercise sub-scores meaningfully.

## Why dictation is the right path
- **Super easy.** No timer to start, no app to launch, no fields to fill.
- **Faster than the time it took to put your shoes back on.**
- **Mention duration AND intensity if you can** — "30 minutes brisk walk" beats "I walked".
- **Recovery counts too** — *"rest day, gentle 15-minute mobility"* is a valid entry that protects your streak.

## Steps
1. Open Daily Diary, tap the microphone.
2. One sentence — what you did, roughly how long.
3. Tap done. Goes straight to your Exercise pillar.

## Pitfalls
- Steps from a phone or wearable are the cleanest signal — dictation is the supplement.
- Connecting Apple Health, Strava, or any tracker later means workouts log themselves; dictation stays as the gap-filler for one-offs.

## Related
- [Use Daily Diary dictation](kb/vitana-system/how-to/use-daily-diary-dictation.md)
- [Connect a health tracker](kb/vitana-system/how-to/connect-health-tracker.md)
- [Book — Exercise chapter](kb/vitana-system/index-book/03-exercise.md)
$CONTENT$
);

-- ===========================================================================
-- 4. Log sleep manually (refreshed)
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to log sleep manually',
  p_path  := 'kb/vitana-system/how-to/log-sleep-manually.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','sleep','daily-diary','manual-log','promotional-v2'],
  p_content := $CONTENT$
# How to log sleep manually

## What it is
About ten seconds in the morning. Open Daily Diary, tap the microphone, say *"slept from eleven to six-thirty, woke up rested"*. That's the whole entry. Your Sleep pillar updates within minutes.

## Why it matters for your Index
Sleep (max 200) is the recovery pillar — it disproportionately affects every other pillar. Even a one-line note about duration and how rested you feel gives the system signal.

## Why dictation is the right path
- **Becomes part of your morning routine.** Most people do it before the first coffee.
- **No fumbling with timers at bedtime.** No app to launch when you're tired.
- **Works without a wearable.** A sleep tracker (Oura, Whoop, Apple Watch) gives stage data dictation can't, but a one-line note is enough to get the pillar moving.
- **Both numbers count.** Mention BOTH duration and quality — the system tracks them as separate signals.

## Steps
1. Morning routine — open Daily Diary, tap the microphone.
2. One sentence: when you slept, how rested you feel.
3. Tap done. Sleep pillar updates.

## Pitfalls
- Logging morning-of is more accurate than guessing later in the day.
- A sleep tracker (Oura, Whoop, Apple Sleep) gives stage data that dictation can't — pair both if possible.

## Related
- [Use Daily Diary dictation](kb/vitana-system/how-to/use-daily-diary-dictation.md)
- [Connect a health tracker](kb/vitana-system/how-to/connect-health-tracker.md)
- [Book — Sleep chapter](kb/vitana-system/index-book/04-sleep.md)
$CONTENT$
);

-- ===========================================================================
-- 5. Log mental state manually (refreshed)
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to log mental state manually',
  p_path  := 'kb/vitana-system/how-to/log-mental-state-manually.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','mental','daily-diary','manual-log','promotional-v2'],
  p_content := $CONTENT$
# How to log mental state manually

## What it is
The easiest pillar to feed — you literally just say what's on your mind. Tap the mic in Daily Diary, talk for ten or fifteen seconds the way you'd talk to a friend, and that's an entry. *"A bit stressed about the meeting, meditated for ten minutes"* — done.

## Why it matters for your Index
Mental (max 200) covers stress, mood, mindfulness, and cognitive load. It's the hardest pillar to track from sensors alone — dictation is often the primary signal source.

## Why dictation is the right path
- **No mood scales to tap, no checkboxes.** Just words.
- **Honesty matters more than positivity.** The Index isn't graded on cheerful tone.
- **Mention specific practices** ("meditated 10 minutes", "journaled") — they count toward sub-scores.
- **A mood-tracking app or HRV tracker** (Oura readiness) supplements dictation; both can run.

## Steps
1. Open Daily Diary, tap the microphone.
2. Talk freely for a few seconds — what's on your mind, what helped today.
3. Tap done. Your Mental pillar reflects it.

## Pitfalls
- The system parses on language, not punctuation — speak naturally, not in keywords.
- Diary entries are private to you — they're never shared with the community.

## Related
- [Use Daily Diary dictation](kb/vitana-system/how-to/use-daily-diary-dictation.md)
- [Book — Mental chapter](kb/vitana-system/index-book/05-mental.md)
$CONTENT$
);

-- ===========================================================================
-- 6. Use Daily Diary dictation (refreshed — the foundational doc)
-- ===========================================================================

SELECT public.upsert_knowledge_doc(
  p_title := 'How to use Daily Diary dictation',
  p_path  := 'kb/vitana-system/how-to/use-daily-diary-dictation.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','how-to','procedural','daily-diary','dictation','foundational','promotional-v2'],
  p_content := $CONTENT$
# How to use Daily Diary dictation

## What it is
Daily Diary is, honestly, the most enjoyable part of the Vitana system to use. You tap the microphone, talk for a few seconds about your day — what you ate, how you slept, how the workout went, what's on your mind — and the system turns it all into entries that feed four of your five Vitana pillars.

## Why dictation is the right path
- **No typing on a phone keyboard.** No menus, no checkboxes, no portion sizes to estimate.
- **Faster than writing it down.** More accurate than trying to remember at the end of the day.
- **One entry can cover several things.** *"Slept seven hours, had eggs and toast for breakfast, going for a walk after lunch."* — three logs in one breath.
- **People who use it daily** say it becomes the favourite ritual of their morning or evening.

## Why it matters for your Index
Four of the five Vitana pillars (Nutrition, Hydration, Exercise, Sleep, Mental) accept signal from dictation. For users without wearables — and for any signal a wearable can't capture (mood, stress, food quality) — Daily Diary is the primary input. **The system can only score what it knows about.**

## Steps
1. Open Daily Diary from the bottom navigation, tap the microphone.
2. Talk naturally — one entry can cover several things.
3. Tap done. The system splits it across the right pillars automatically.
4. Dictate two or three times a day — morning, midday, evening — and your Index has rich signal to work with.

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

COMMIT;

NOTIFY pgrst, 'reload schema';
