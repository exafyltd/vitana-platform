/**
 * v0 heuristic classifier — zero LLM calls, zero external deps.
 *
 * Good enough to filter noise in Phase 1. Phase 2+ replaces with Brain-side
 * semantic classification. Keep scoring axes identical so the swap is trivial.
 */

export interface ClassifierInput {
  body: string;
  author_external_id?: string;
  already_has_reply?: boolean;
  expertise_zones?: string[];
}

export interface ClassifierOutput {
  is_purchase_intent: number;
  topic_match: number;
  urgency: number;
  already_answered: number;
  poster_fit: number;
  combined_score: number;
  extracted_topics: string[];
  classifier_version: string;
}

const CLASSIFIER_VERSION = 'v0-heuristic';

const PURCHASE_PHRASES = [
  /\bwhere (?:can|do) (?:i|you) (?:buy|get|find|order)\b/i,
  /\banyone (?:know|have) (?:a )?(?:good )?recommendation/i,
  /\blooking for (?:a |an )?(?:good |reliable |trusted )?\w+/i,
  /\bcan (?:anyone|someone) recommend\b/i,
  /\bwhat\'?s the best\b/i,
  /\bwhich (?:one )?should i\b/i,
  /\bany (?:good )?(?:recommendations?|suggestions?)\b/i,
  /\bi (?:need|want) to buy\b/i,
  /\bhow much (?:does|is|for)\b/i,
  /\bwhere to (?:get|buy|find)\b/i,
];

const URGENCY_PHRASES = [
  /\burgent\b/i,
  /\btoday\b/i,
  /\btonight\b/i,
  /\bthis week\b/i,
  /\basap\b/i,
  /\b(?:quickly|soon)\b/i,
];

export function classifyIntent(input: ClassifierInput): ClassifierOutput {
  const body = input.body.trim();
  const lower = body.toLowerCase();

  const is_purchase_intent = score(PURCHASE_PHRASES.some((re) => re.test(body)) ? 0.9 : lower.includes('?') ? 0.25 : 0.05);
  const urgency = score(URGENCY_PHRASES.some((re) => re.test(body)) ? 0.8 : 0.2);
  const already_answered = score(input.already_has_reply ? 0.8 : 0.1);
  const poster_fit = score(input.author_external_id ? 0.7 : 0.5);

  const extracted_topics = extractTopics(body);
  const zones = (input.expertise_zones || []).map((z) => z.toLowerCase());
  const topic_match = zones.length === 0
    ? score(0.5) // no expertise zones configured → neutral
    : score(
        extracted_topics.some((t) => zones.some((z) => t.includes(z) || z.includes(t)))
          ? 0.85
          : 0.15,
      );

  // Weighted combo — tweak in Phase 2 once we have outcome data.
  const combined_score = score(
    is_purchase_intent * 0.45 +
      topic_match * 0.25 +
      (1 - already_answered) * 0.15 +
      poster_fit * 0.1 +
      urgency * 0.05,
  );

  return {
    is_purchase_intent,
    topic_match,
    urgency,
    already_answered,
    poster_fit,
    combined_score,
    extracted_topics,
    classifier_version: CLASSIFIER_VERSION,
  };
}

function score(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, Number(v.toFixed(2))));
}

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','if','then','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','i','you','he','she','it','we','they','me','him','her',
  'us','them','my','your','his','its','our','their','this','that','these','those','there','here',
  'of','to','in','on','for','with','at','by','from','as','about','into','like','through',
  'where','what','which','who','how','why','when','can','could','would','should','will','may',
  'any','some','good','best','buy','get','find','know','recommend','recommendation','looking',
  'need','want','anyone','someone','people','thing','things',
]);

function extractTopics(body: string): string[] {
  const tokens = body
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
  return Array.from(new Set(tokens)).slice(0, 8);
}
