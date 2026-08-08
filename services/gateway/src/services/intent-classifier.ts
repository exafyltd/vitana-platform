/**
 * VTID-01973: Intent kind classifier for the Vitana Intent Engine (P2-A).
 *
 * First-stage LLM call that maps a free-form utterance to one of the
 * registered intent_kinds + a confidence score. The dispatcher hands off
 * to the kind-specific extractor only when confidence ≥ 0.7; below that,
 * ORB asks a clarifying question.
 *
 * BOOTSTRAP-GEMINI-TO-CLAUDE: migrated off the Vertex Gemini fallback chain
 * (gemini-2.5-flash → gemini-2.5-pro, plus a GOOGLE_GEMINI_API_KEY REST
 * fallback that was never actually configured on the gateway) to Claude
 * Sonnet 4.6 via the direct Anthropic API. withGeminiLog telemetry is kept
 * (logs to the existing gemini_call_log table by feature+model) so any
 * regression is still visible in the same dashboard.
 */

import { withGeminiLog } from './gemini-call-log';
import { callClaudeText, CLAUDE_SONNET_4_6 } from './claude-text-client';

const CLASSIFY_MAX_OUTPUT_TOKENS = 2048;

export type IntentKind =
  | 'commercial_buy'
  | 'commercial_sell'
  | 'activity_seek'
  | 'partner_seek'
  | 'social_seek'
  | 'mutual_aid'
  // VTID-DANCE-D2: dance-market wires the two reserved-but-unwired kinds.
  | 'learning_seek'
  | 'mentor_seek';

export interface IntentClassification {
  intent_kind: IntentKind | null;
  confidence: number; // 0-1
  reasoning?: string;
}

const CLASSIFIER_SYSTEM_PROMPT = `You classify user utterances for the Vitana Intent Engine into one of eight kinds. Return ONLY a JSON object, no prose:

{ "intent_kind": "<one of: commercial_buy, commercial_sell, activity_seek, partner_seek, social_seek, mutual_aid, learning_seek, mentor_seek, NONE>",
  "confidence": <0.0-1.0>,
  "reasoning": "<short>" }

Definitions:
- commercial_buy   = user wants to PURCHASE a service or product. ("I need a contractor", "I want to buy a road bike", "looking to hire a tutor")
- commercial_sell  = user wants to SELL a service or product. ("I'm offering tutoring", "I want to sell my bike", "I provide kitchen renovations")
- activity_seek    = user wants a partner for a recreational activity. ("looking for someone to play tennis", "anyone hiking Saturday?", "Mitspieler für Schach gesucht", "going out dancing Saturday?")
- partner_seek     = user wants a romantic life partner. ("looking for a life partner", "I want to find a girlfriend", "Partner fürs Leben")
- social_seek      = user wants a coffee chat / networking conversation, NOT romantic and NOT learning a specific skill. ("want to chat with a Series A founder", "coffee chat anyone?")
- mutual_aid       = user is lending/borrowing/giving/receiving without commercial transaction. ("I can lend my drill", "anyone got a sewing machine I can borrow?", "free moving help")
- learning_seek    = user wants to LEARN a specific skill or topic — looking for a teacher/instructor. ("I want to learn salsa", "find me a piano teacher", "Ich möchte Tango lernen", "looking for someone to teach me kitesurfing")
- mentor_seek      = user is OFFERING to teach a specific skill — instructor/teacher offering lessons. ("I teach salsa Tuesdays", "I'm a yoga instructor", "biete Klavierunterricht", "I offer photography classes")
- NONE             = utterance is not a marketplace/match intent (small talk, factual question, etc.).

Rules:
- Bias to NONE when ambiguous; the dispatcher will ask a clarifying question.
- Confidence reflects how clear the kind is, NOT how complete the slots are.
- Languages supported: English, German.

Disambiguation hints:
- learning_seek vs commercial_buy: if user says "I want to learn X" → learning_seek (teacher relationship). If "I need to buy X-class lessons" with explicit purchase framing, also acceptable as commercial_buy. Prefer learning_seek when the focus is on the SKILL acquisition; commercial_buy when the focus is the TRANSACTION.
- mentor_seek vs commercial_sell: if user says "I teach X" or "I offer X classes" → mentor_seek (relationship + skill transfer). If user says "I sell my X services for €Y" with an explicit price tag, prefer commercial_sell.
- learning_seek vs social_seek: if user wants structured skill instruction → learning_seek. If user wants peer conversation/networking → social_seek.
- activity_seek vs learning_seek: "want a salsa partner Saturday" → activity_seek. "want someone to TEACH me salsa" → learning_seek. The verb "learn"/"teach" is the discriminator.

Examples:
"I need a kitchen contractor" -> {"intent_kind":"commercial_buy","confidence":0.95,"reasoning":"clear hire intent"}
"Ich biete Übersetzungen" -> {"intent_kind":"commercial_sell","confidence":0.9,"reasoning":"offering services in DE"}
"Anyone want to play tennis Tuesday?" -> {"intent_kind":"activity_seek","confidence":0.95,"reasoning":"recreational partner"}
"I'd like to find a girlfriend" -> {"intent_kind":"partner_seek","confidence":0.95,"reasoning":"romantic partner"}
"Looking for a coffee chat with a fintech founder" -> {"intent_kind":"social_seek","confidence":0.9,"reasoning":"networking, not skill instruction"}
"I can lend my drill if anyone needs" -> {"intent_kind":"mutual_aid","confidence":0.9,"reasoning":"free lending"}
"I want to learn salsa, looking for a teacher" -> {"intent_kind":"learning_seek","confidence":0.95,"reasoning":"explicit teacher search for a skill"}
"I teach salsa Tuesday evenings" -> {"intent_kind":"mentor_seek","confidence":0.95,"reasoning":"offering instruction"}
"What's the weather?" -> {"intent_kind":"NONE","confidence":0.1,"reasoning":"factual question"}`;

/** Pull the first balanced JSON object out of a model response, tolerating fences/prose. */
function extractJsonObject(raw: string): string {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  if (cleaned.startsWith('{')) return cleaned;
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

/** Confidence may arrive as a number or a stringified number ("0.95"); coerce + clamp. */
function coerceConfidence(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function parseClassifierResponse(raw: string): IntentClassification {
  try {
    const parsed = JSON.parse(extractJsonObject(raw));
    const kind = String(parsed.intent_kind || '').toLowerCase();
    const validKinds = ['commercial_buy', 'commercial_sell', 'activity_seek', 'partner_seek', 'social_seek', 'mutual_aid', 'learning_seek', 'mentor_seek'];
    return {
      intent_kind: validKinds.includes(kind) ? (kind as IntentKind) : null,
      confidence: coerceConfidence(parsed.confidence),
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 200) : undefined,
    };
  } catch {
    return { intent_kind: null, confidence: 0 };
  }
}

/**
 * Claude call, JSON requested via prompt instructions (parsed leniently by
 * extractJsonObject/parseClassifierResponse). Recorded in gemini_call_log
 * (success/error) so silent breakage like the original confidence-0 bug
 * surfaces in telemetry.
 */
async function runClaudeClassify(userText: string): Promise<string> {
  try {
    const raw = await withGeminiLog(
      { feature: 'classifier', model: CLAUDE_SONNET_4_6 },
      async () => {
        const text = await callClaudeText({
          model: CLAUDE_SONNET_4_6,
          system: CLASSIFIER_SYSTEM_PROMPT,
          prompt: `Utterance to classify:\n${userText}`,
          maxTokens: CLASSIFY_MAX_OUTPUT_TOKENS,
          temperature: 0.1,
        });
        if (!text) throw new Error('empty Claude response');
        return text;
      },
    );
    return raw ?? '';
  } catch (err: any) {
    console.warn(`[VTID-01973] Claude classifier failed: ${err?.message}`);
    return '';
  }
}

export async function classifyIntentKind(utterance: string): Promise<IntentClassification> {
  const trimmed = (utterance || '').trim();
  if (!trimmed) return { intent_kind: null, confidence: 0 };

  const raw = await runClaudeClassify(trimmed);
  if (raw) {
    const parsed = parseClassifierResponse(raw);
    if (parsed.intent_kind || parsed.confidence > 0) return parsed;
  }

  // No backend available — return null kind so callers fall back to clarification.
  return { intent_kind: null, confidence: 0 };
}
