/**
 * VTID-01973: Intent kind classifier for the Vitana Intent Engine (P2-A).
 *
 * First-stage Gemini call that maps a free-form utterance to one of the
 * registered intent_kinds + a confidence score. The dispatcher hands off
 * to the kind-specific extractor only when confidence ≥ 0.7; below that,
 * ORB asks a clarifying question.
 *
 * Mirrors the inline-fact-extractor pattern: Vertex AI primary, Gemini API
 * fallback, temperature 0.1 for deterministic classification, low token
 * budget. JSON-mode output.
 */

import { VertexAI } from '@google-cloud/vertexai';

const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'lovable-vitana-vers1';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const CLASSIFY_MODEL = 'gemini-2.0-flash';

let vertexAI: VertexAI | null = null;
try {
  if (VERTEX_PROJECT && VERTEX_LOCATION) {
    vertexAI = new VertexAI({ project: VERTEX_PROJECT, location: VERTEX_LOCATION });
  }
} catch {
  vertexAI = null;
}

export type IntentKind =
  | 'commercial_buy'
  | 'commercial_sell'
  | 'activity_seek'
  | 'partner_seek'
  | 'social_seek'
  | 'mutual_aid';

export interface IntentClassification {
  intent_kind: IntentKind | null;
  confidence: number; // 0-1
  reasoning?: string;
}

const CLASSIFIER_SYSTEM_PROMPT = `You classify user utterances for the Vitana Intent Engine into one of six kinds. Return ONLY a JSON object, no prose:

{ "intent_kind": "<one of: commercial_buy, commercial_sell, activity_seek, partner_seek, social_seek, mutual_aid, NONE>",
  "confidence": <0.0-1.0>,
  "reasoning": "<short>" }

Definitions:
- commercial_buy   = user wants to PURCHASE a service or product. ("I need a contractor", "I want to buy a road bike", "looking to hire a tutor")
- commercial_sell  = user wants to SELL a service or product. ("I'm offering tutoring", "I want to sell my bike", "I provide kitchen renovations")
- activity_seek    = user wants a partner for a recreational activity. ("looking for someone to play tennis", "anyone hiking Saturday?", "Mitspieler für Schach gesucht")
- partner_seek     = user wants a romantic life partner. ("looking for a life partner", "I want to find a girlfriend", "Partner fürs Leben")
- social_seek      = user wants a coffee chat / mentorship / networking conversation, NOT romantic. ("looking for a mentor", "want to chat with a Series A founder", "coffee chat anyone?")
- mutual_aid       = user is lending/borrowing/giving/receiving without commercial transaction. ("I can lend my drill", "anyone got a sewing machine I can borrow?", "free moving help")
- NONE             = utterance is not a marketplace/match intent (small talk, factual question, etc.).

Rules:
- Bias to NONE when ambiguous; the dispatcher will ask a clarifying question.
- Confidence reflects how clear the kind is, NOT how complete the slots are.
- Languages supported: English, German.

Examples:
"I need a kitchen contractor" -> {"intent_kind":"commercial_buy","confidence":0.95,"reasoning":"clear hire intent"}
"Ich biete Übersetzungen" -> {"intent_kind":"commercial_sell","confidence":0.9,"reasoning":"offering services in DE"}
"Anyone want to play tennis Tuesday?" -> {"intent_kind":"activity_seek","confidence":0.95,"reasoning":"recreational partner"}
"I'd like to find a girlfriend" -> {"intent_kind":"partner_seek","confidence":0.95,"reasoning":"romantic partner"}
"Looking for a mentor in fintech" -> {"intent_kind":"social_seek","confidence":0.9,"reasoning":"mentorship not romantic"}
"I can lend my drill if anyone needs" -> {"intent_kind":"mutual_aid","confidence":0.9,"reasoning":"free lending"}
"What's the weather?" -> {"intent_kind":"NONE","confidence":0.1,"reasoning":"factual question"}`;

function parseClassifierResponse(raw: string): IntentClassification {
  // Strip code fences if Gemini added them.
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    const kind = String(parsed.intent_kind || '').toLowerCase();
    const validKinds = ['commercial_buy', 'commercial_sell', 'activity_seek', 'partner_seek', 'social_seek', 'mutual_aid'];
    return {
      intent_kind: validKinds.includes(kind) ? (kind as IntentKind) : null,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 200) : undefined,
    };
  } catch {
    return { intent_kind: null, confidence: 0 };
  }
}

export async function classifyIntentKind(utterance: string): Promise<IntentClassification> {
  const trimmed = (utterance || '').trim();
  if (!trimmed) return { intent_kind: null, confidence: 0 };

  // Try Vertex AI first.
  if (vertexAI) {
    try {
      const model = vertexAI.getGenerativeModel({
        model: CLASSIFY_MODEL,
        generationConfig: { temperature: 0.1, maxOutputTokens: 200, topP: 0.8 },
        systemInstruction: { role: 'system', parts: [{ text: CLASSIFIER_SYSTEM_PROMPT }] },
      });
      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: trimmed }] }],
      });
      const textPart = response.response?.candidates?.[0]?.content?.parts?.find((p: any) => 'text' in p);
      const raw = textPart ? (textPart as any).text : '';
      if (raw) {
        const parsed = parseClassifierResponse(raw);
        if (parsed.intent_kind || parsed.confidence > 0) return parsed;
      }
    } catch (err: any) {
      console.warn(`[VTID-01973] Vertex classifier failed: ${err.message}`);
    }
  }

  // Gemini API fallback.
  if (GOOGLE_GEMINI_API_KEY) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${CLASSIFY_MODEL}:generateContent?key=${GOOGLE_GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: trimmed }] }],
            systemInstruction: { parts: [{ text: CLASSIFIER_SYSTEM_PROMPT }] },
            generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
          }),
        }
      );
      if (response.ok) {
        const data = await response.json() as any;
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return parseClassifierResponse(raw);
      }
    } catch (err: any) {
      console.warn(`[VTID-01973] Gemini API classifier failed: ${err.message}`);
    }
  }

  // No backend available — return null kind so callers fall back to clarification.
  return { intent_kind: null, confidence: 0 };
}
