/**
 * Diary → Health Features Extractor (VTID-01977)
 *
 * Pattern-matching extractor that runs after a diary entry is saved and
 * looks for hydration / nutrition / exercise / sleep / mental signals in
 * the raw text. For every match it writes a structured row to
 * `health_features_daily` (the table the Vitana Index v3 RPC reads as the
 * `connected_data` sub-score) and returns a per-pillar list of writes so
 * the caller can trigger one Index recompute at the end.
 *
 * Deterministic — no LLM, no network — so it stays fast on the diary
 * write hot path. Idempotent: the upsert is keyed by
 * (tenant_id, user_id, date, feature_key) so multiple diary entries on
 * the same day for the same feature_key UPDATE rather than duplicate.
 *
 * Coverage (English + German because those are the two languages we ship):
 *
 * | Pillar     | Patterns matched                                | feature_key                |
 * | ---------- | ----------------------------------------------- | -------------------------- |
 * | Hydration  | "1 L", "500 ml", "two glasses", "drei Gläser"   | water_intake (ml)          |
 * | Nutrition  | "breakfast", "lunch", "dinner", "snack",        | meal_log (count)           |
 * |            |   "Frühstück", "Mittagessen", "Abendessen"      |                            |
 * | Exercise   | "walked X km/min", "ran X", "workout",          | wearable_steps (count) /   |
 * |            |   "Spaziergang", "trainiert"                    |   wearable_workout (min)   |
 * | Sleep      | "slept 7h", "schlief 8 Stunden", "got 6 hours"  | wearable_sleep_duration    |
 * |            |                                                 |   (minutes)                |
 * | Mental     | "meditated 10 min", "journaling",               | meditation_minutes /       |
 * |            |   "meditiert", "journale"                       |   journal_entry            |
 *
 * The journaling itself is treated as a `journal_entry` feature row
 * automatically — every successful diary write counts as +1 mental
 * journal entry, regardless of whether other patterns matched.
 *
 * Quantities are clamped to sane bounds:
 *   water_intake: 0..6000 ml
 *   meal_log:     1..6 per match (one row per meal-noun mention)
 *   wearable_steps: 0..40000
 *   wearable_workout: 0..240 min
 *   wearable_sleep_duration: 0..720 min  (12 h)
 *   meditation_minutes: 0..240
 */

import { SupabaseClient } from '@supabase/supabase-js';

export interface DiaryFeatureWrite {
  feature_key: string;
  feature_value: number;
  feature_unit: string;
  pillar: 'nutrition' | 'hydration' | 'exercise' | 'sleep' | 'mental';
  evidence: string;       // text snippet that triggered the match
}

export interface ExtractDiaryResult {
  writes: DiaryFeatureWrite[];
  matched: boolean;
}

// =====================================================================
// Pattern library — kept compact and explicit so they're easy to audit.
// =====================================================================

const HYDRATION_REGEX = [
  // "1L water" / "1 L water" / "1.5L of water" / "drank 2L" — also tea/coffee/juice
  { re: /(\d+(?:\.\d+)?)\s*l(?:iters?)?\s*(?:of\s+)?(?:water|tea|coffee|juice|wasser|tee|kaffee|saft)/gi,
    multiplier: 1000 },
  // "500 ml water" / "750ml of tea"
  { re: /(\d+(?:\.\d+)?)\s*ml\s*(?:of\s+)?(?:water|tea|coffee|juice|wasser|tee|kaffee|saft)/gi,
    multiplier: 1 },
  // "two glasses of water" / "drei Gläser Wasser"
  { re: /(one|two|three|four|five|six|seven|eight|drei|vier|f[uü]nf|sechs|sieben|acht|zwei|ein(?:e|en)?)\s+(?:glass(?:es)?|cups?|gl[äa]ser|tassen?)\s*(?:of\s+)?(?:water|tea|coffee|wasser|tee|kaffee)/gi,
    multiplier: 250, words: true },
  // "drank water" with no quantity → assume 1 glass
  { re: /\b(?:drank|trank|getrunken|hatte)\s+(?:some\s+)?(?:water|wasser)\b/gi,
    multiplier: 250, fallbackOne: true },
];

const MEAL_NOUNS = [
  'breakfast', 'lunch', 'dinner', 'snack', 'meal',
  'fr[üu]hst[üu]ck', 'mittagessen', 'abendessen', 'mahlzeit', 'snack',
];
const MEAL_REGEX = new RegExp(`\\b(${MEAL_NOUNS.join('|')})\\b`, 'gi');
// "had breakfast" / "ate lunch" / "skipped dinner" — only counts the eaten ones
const MEAL_VERB_REGEX = new RegExp(
  `\\b(?:had|ate|hatte|gegessen|skipped|ausgelassen)\\s+(?:a\\s+|some\\s+|mein\\s+|meinen\\s+)?(${MEAL_NOUNS.join('|')})\\b`,
  'gi',
);

const EXERCISE_KM_REGEX = /(\d+(?:\.\d+)?)\s*(km|kilometers?|kilometers)\s*(?:walk|walking|run|running|hike|hiking|spaziergang|gelaufen|gerannt)/gi;
const EXERCISE_MIN_REGEX = /(\d+)\s*(?:min(?:utes?)?|m)\s*(?:walk|walking|run|running|workout|cardio|training|trainiert)/gi;
const EXERCISE_HR_REGEX = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h|stunden?|std)\s*(?:workout|cardio|gym|training|trainiert)/gi;
// "did a workout" / "went for a walk" → count as 30 min default
const EXERCISE_VERB_REGEX = /\b(?:walked|ran|jogged|cycled|trained|spazierengegangen|gelaufen|gerannt|trainiert|workout|gym|spaziergang)\b/gi;

// "slept 7 hours" / "schlief 8 Stunden" / "got 6h of sleep"
const SLEEP_HR_REGEX = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h|stunden?|std)\s*(?:of\s+)?(?:sleep|geschlafen|schlaf|schlief)/gi;
const SLEEP_HR_REVERSE = /(?:slept|geschlafen|schlief)\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h|stunden?|std)/gi;

const MEDITATE_MIN_REGEX = /(\d+)\s*(?:min(?:utes?)?|m)\s*(?:meditation|meditate|meditat(?:ed|ing)|meditiert)/gi;
const MEDITATE_VERB_REGEX = /\b(?:meditated|meditiert|did\s+a\s+meditation|made\s+a\s+meditation)\b/gi;

const WORD_TO_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  ein: 1, eine: 1, einen: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5,
  sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10,
};

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// =====================================================================
// Extractor
// =====================================================================

export function extractHealthFeaturesFromDiary(rawText: string): DiaryFeatureWrite[] {
  if (!rawText || rawText.trim().length === 0) return [];
  const writes: DiaryFeatureWrite[] = [];

  // ── Hydration ────────────────────────────────────────────────────────
  let totalHydrationMl = 0;
  const hydrationEvidence: string[] = [];
  for (const { re, multiplier, words, fallbackOne } of HYDRATION_REGEX) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rawText)) !== null) {
      const captured = m[1] || '';
      let quantity = 1;
      if (fallbackOne) {
        quantity = 1;
      } else if (words) {
        quantity = WORD_TO_NUM[captured.toLowerCase()] ?? 1;
      } else {
        quantity = parseFloat(captured) || 1;
      }
      totalHydrationMl += quantity * multiplier;
      hydrationEvidence.push(m[0]);
    }
  }
  if (totalHydrationMl > 0) {
    writes.push({
      feature_key: 'water_intake',
      feature_value: clamp(totalHydrationMl, 0, 6000),
      feature_unit: 'ml',
      pillar: 'hydration',
      evidence: hydrationEvidence.slice(0, 3).join(' | '),
    });
  }

  // ── Nutrition: count distinct meal mentions ──────────────────────────
  // "had breakfast and lunch" should count both. Strategy: collect every
  // meal-noun mention, then drop any preceded by a negation token within
  // ~3 words ("skipped", "didn't have", "ausgelassen", "kein").
  const meals = new Set<string>();
  let m: RegExpExecArray | null;
  MEAL_REGEX.lastIndex = 0;
  while ((m = MEAL_REGEX.exec(rawText)) !== null) {
    if (!m[1]) continue;
    const idx = m.index;
    const lookbehind = rawText.slice(Math.max(0, idx - 30), idx).toLowerCase();
    if (/\b(skipped|skip|didn['’ ]t\s+have|nicht\s+gegessen|ausgelassen|kein(e[mnrs]?)?|no)\b\s*$/i.test(lookbehind)) continue;
    meals.add(m[1].toLowerCase());
  }
  if (meals.size > 0) {
    writes.push({
      feature_key: 'meal_log',
      feature_value: clamp(meals.size, 1, 6),
      feature_unit: 'count',
      pillar: 'nutrition',
      evidence: Array.from(meals).join(', '),
    });
  }

  // ── Exercise ─────────────────────────────────────────────────────────
  let exerciseMin = 0;
  const exerciseEv: string[] = [];
  EXERCISE_MIN_REGEX.lastIndex = 0;
  while ((m = EXERCISE_MIN_REGEX.exec(rawText)) !== null) {
    exerciseMin += parseFloat(m[1] || '0') || 0;
    exerciseEv.push(m[0]);
  }
  EXERCISE_HR_REGEX.lastIndex = 0;
  while ((m = EXERCISE_HR_REGEX.exec(rawText)) !== null) {
    exerciseMin += (parseFloat(m[1] || '0') || 0) * 60;
    exerciseEv.push(m[0]);
  }
  EXERCISE_KM_REGEX.lastIndex = 0;
  while ((m = EXERCISE_KM_REGEX.exec(rawText)) !== null) {
    // 12 min/km walking / 6 min/km running — average 9 min/km
    const km = parseFloat(m[1] || '0') || 0;
    exerciseMin += km * 9;
    exerciseEv.push(m[0]);
  }
  // Fallback: any exercise verb without a quantity → assume 30 min (one block).
  if (exerciseMin === 0) {
    EXERCISE_VERB_REGEX.lastIndex = 0;
    if (EXERCISE_VERB_REGEX.test(rawText)) {
      exerciseMin = 30;
      exerciseEv.push('exercise verb');
    }
  }
  if (exerciseMin > 0) {
    writes.push({
      feature_key: 'wearable_workout',
      feature_value: clamp(exerciseMin, 0, 240),
      feature_unit: 'min',
      pillar: 'exercise',
      evidence: exerciseEv.slice(0, 3).join(' | '),
    });
  }

  // ── Sleep ────────────────────────────────────────────────────────────
  let sleepMin = 0;
  const sleepEv: string[] = [];
  SLEEP_HR_REGEX.lastIndex = 0;
  while ((m = SLEEP_HR_REGEX.exec(rawText)) !== null) {
    sleepMin = Math.max(sleepMin, (parseFloat(m[1] || '0') || 0) * 60);
    sleepEv.push(m[0]);
  }
  SLEEP_HR_REVERSE.lastIndex = 0;
  while ((m = SLEEP_HR_REVERSE.exec(rawText)) !== null) {
    sleepMin = Math.max(sleepMin, (parseFloat(m[1] || '0') || 0) * 60);
    sleepEv.push(m[0]);
  }
  if (sleepMin > 0) {
    writes.push({
      feature_key: 'wearable_sleep_duration',
      feature_value: clamp(sleepMin, 0, 720),
      feature_unit: 'min',
      pillar: 'sleep',
      evidence: sleepEv.slice(0, 2).join(' | '),
    });
  }

  // ── Mental (meditation + journaling) ─────────────────────────────────
  let meditationMin = 0;
  const meditationEv: string[] = [];
  MEDITATE_MIN_REGEX.lastIndex = 0;
  while ((m = MEDITATE_MIN_REGEX.exec(rawText)) !== null) {
    meditationMin += parseFloat(m[1] || '0') || 0;
    meditationEv.push(m[0]);
  }
  if (meditationMin === 0) {
    MEDITATE_VERB_REGEX.lastIndex = 0;
    if (MEDITATE_VERB_REGEX.test(rawText)) {
      meditationMin = 10;
      meditationEv.push('meditation verb');
    }
  }
  if (meditationMin > 0) {
    writes.push({
      feature_key: 'meditation_minutes',
      feature_value: clamp(meditationMin, 0, 240),
      feature_unit: 'min',
      pillar: 'mental',
      evidence: meditationEv.slice(0, 2).join(' | '),
    });
  }

  // Journaling itself: every successful diary entry is a journal_entry.
  // The diary write path always calls this — so emit a journal_entry row
  // unconditionally when raw_text has any content. This guarantees the
  // mental pillar's `connected_data` sub-score moves on every diary post.
  writes.push({
    feature_key: 'journal_entry',
    feature_value: 1,
    feature_unit: 'count',
    pillar: 'mental',
    evidence: 'diary_entry',
  });

  return writes;
}

// =====================================================================
// Persistence helper — used by the diary route to apply the writes.
// =====================================================================

/**
 * Apply extracted features to health_features_daily for the given user
 * and date. Idempotent: upserts on (tenant_id, user_id, date, feature_key).
 * On day-collision, the new value REPLACES the existing one — diary
 * entries are treated as the latest report for that day. Callers that
 * want additive semantics should call /api/v1/integrations/manual/log
 * instead.
 *
 * Returns the number of rows written so the caller can decide whether
 * to trigger an Index recompute.
 */
export async function persistDiaryHealthFeatures(
  admin: SupabaseClient,
  userId: string,
  tenantId: string,
  date: string,
  writes: DiaryFeatureWrite[],
): Promise<{ written: number; failed: number }> {
  if (writes.length === 0) return { written: 0, failed: 0 };

  let written = 0;
  let failed = 0;
  for (const w of writes) {
    try {
      const { error } = await admin
        .from('health_features_daily')
        .upsert(
          {
            tenant_id: tenantId,
            user_id: userId,
            date,
            feature_key: w.feature_key,
            feature_value: w.feature_value,
            feature_unit: w.feature_unit,
            sample_count: 1,
            confidence: 0.6,
            metadata: { source: 'diary_extractor', evidence: w.evidence.slice(0, 200) },
          },
          { onConflict: 'tenant_id,user_id,date,feature_key' },
        );
      if (error) {
        console.warn(`[VTID-01977] feature write failed (${w.feature_key}): ${error.message}`);
        failed += 1;
      } else {
        written += 1;
      }
    } catch (e: any) {
      console.warn(`[VTID-01977] feature write threw (${w.feature_key}): ${e?.message ?? e}`);
      failed += 1;
    }
  }
  return { written, failed };
}
