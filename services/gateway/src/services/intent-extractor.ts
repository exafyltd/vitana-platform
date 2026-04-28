/**
 * VTID-01973: Per-kind intent extractor (P2-A).
 *
 * Strategy pattern over five Gemini-driven extractors. After
 * intent-classifier.ts identifies the kind, this module produces the
 * kind-specific structured payload (kind_payload JSONB on user_intents).
 *
 * Same Vertex+Gemini fallback pattern as inline-fact-extractor.ts. JSON
 * mode, temp 0.1, low token budget.
 *
 * Returns { fields, confidence, missing_critical } so the dispatcher knows
 * whether to fire single-shot or fall back to multi-turn slot-fill.
 */

import { VertexAI } from '@google-cloud/vertexai';
import type { IntentKind } from './intent-classifier';

const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'lovable-vitana-vers1';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const EXTRACT_MODEL = 'gemini-2.0-flash';

let vertexAI: VertexAI | null = null;
try {
  if (VERTEX_PROJECT && VERTEX_LOCATION) {
    vertexAI = new VertexAI({ project: VERTEX_PROJECT, location: VERTEX_LOCATION });
  }
} catch {
  vertexAI = null;
}

export interface ExtractedIntent {
  intent_kind: IntentKind;
  category: string | null;
  title: string | null;
  scope: string | null;
  kind_payload: Record<string, unknown>;
  confidence: number; // 0-1
  missing_critical: string[];
}

const CRITICAL_FIELDS_BY_KIND: Record<IntentKind, string[]> = {
  commercial_buy: ['title', 'scope'],
  commercial_sell: ['title', 'scope'],
  activity_seek: ['title', 'scope', 'kind_payload.activity'],
  partner_seek: ['title', 'scope'],
  social_seek: ['title', 'scope', 'kind_payload.topic'],
  mutual_aid: ['title', 'scope', 'kind_payload.direction', 'kind_payload.object_or_skill'],
  // VTID-DANCE-D2
  learning_seek: ['title', 'scope', 'kind_payload.learning'],
  mentor_seek:   ['title', 'scope', 'kind_payload.teaching'],
};

const SYSTEM_PROMPT_BY_KIND: Record<IntentKind, string> = {
  commercial_buy: `Extract a commercial_buy intent. Return JSON only:
{ "category": "<one of: home_services.refurbishment, home_services.electrician, home_services.plumbing, home_services.cleaning, pro_services.legal, pro_services.accounting, pro_services.translation, wellness.coaching, wellness.nutrition, travel.itinerary_planning, travel.local_guide, local.errands, local.delivery, local.handyman, digital.web_dev, digital.design, digital.marketing, education.tutoring, education.language, events.catering, events.photography, events.music, OR null if unclear>",
  "title": "<short headline ≤140 chars>",
  "scope": "<longer description 20-1500 chars, in user's words>",
  "kind_payload": { "budget_min": <number or null>, "budget_max": <number or null>, "currency": "<ISO 4217, default EUR>", "location_mode": "<remote|on_site|hybrid|null>", "location_label": "<city or null>", "urgency": "<asap|this_week|flexible|null>", "due_date": "<ISO date or null>" },
  "confidence": <0-1>
}
Leave fields null when unclear. Confidence reflects extraction certainty, not slot completeness.`,
  commercial_sell: `Extract a commercial_sell intent. Return JSON only:
{ "category": "<same enum as commercial_buy or null>",
  "title": "<headline ≤140>",
  "scope": "<description 20-1500 chars>",
  "kind_payload": { "price_floor": <number or null>, "price_ceiling": <number or null>, "currency": "<ISO 4217, default EUR>", "pricing_model": "<hourly|per_project|per_unit|quote_on_request|null>", "location_served": "<city or region label or null>", "skill_keywords": [<array of strings>], "availability": "<active|paused|null>" },
  "confidence": <0-1>
}`,
  activity_seek: `Extract an activity_seek intent. Return JSON only:
{ "category": "<one of: sport.tennis, sport.running, sport.hiking, sport.cycling, sport.yoga, sport.gym, creative.music, creative.painting, learning.language, learning.book_club, OR null>",
  "title": "<headline ≤140>",
  "scope": "<description 20-1500>",
  "kind_payload": { "activity": "<canonical activity name>", "time_windows": [<array of strings like 'tue 18:00-20:00'>], "location_label": "<city/area or null>", "group_size_pref": "<1on1|small_group|large_group|null>", "skill_level": "<beginner|intermediate|advanced|null>" },
  "confidence": <0-1>
}`,
  partner_seek: `Extract a partner_seek intent. Return JSON only — be PII-light and respect privacy:
{ "category": "<life_partner|dating|companionship|null>",
  "title": "<short tasteful headline ≤140>",
  "scope": "<description 20-1500, NO last names, NO phone numbers, NO emails>",
  "kind_payload": { "age_range": [<min int>,<max int>] or null, "gender_preference": "<string or null>", "location_radius_km": <number or null>, "life_stage": "<single|divorced|widowed|null>", "must_haves": [<short tags>], "deal_breakers": [<short tags>] },
  "confidence": <0-1>
}`,
  social_seek: `Extract a social_seek intent (mentorship/networking/coffee chat — NOT romantic). Return JSON only:
{ "category": "<mentorship|networking|coffee_chat|peer_support|null>",
  "title": "<headline ≤140>",
  "scope": "<description 20-1500>",
  "kind_payload": { "topic": "<canonical topic e.g. 'fintech-fundraising'>", "time_windows": [<strings>], "location_label": "<city or 'remote'>", "format_pref": "<in_person|video|either|null>" },
  "confidence": <0-1>
}`,
  mutual_aid: `Extract a mutual_aid intent. Return JSON only:
{ "category": "<lend|borrow|gift|receive|help_me>",
  "title": "<headline ≤140>",
  "scope": "<description 20-1500>",
  "kind_payload": { "direction": "<lend|borrow|give|receive|help_me>", "object_or_skill": "<short noun phrase>", "duration_estimate": "<short string or null>", "location_label": "<city/area>" },
  "confidence": <0-1>
}`,
  // VTID-DANCE-D2: learning_seek + mentor_seek wired with optional dance facet.
  // The dance enrichment helper adds a kind_payload.dance block post-extract
  // when category starts with 'dance.'.
  learning_seek: `Extract a learning_seek intent (user wants to LEARN a skill from a teacher). Return JSON only:
{ "category": "<one of: dance.learning.salsa, dance.learning.tango, dance.learning.bachata, dance.learning.kizomba, dance.learning.swing, dance.learning.ballroom, dance.learning.hiphop, dance.learning.contemporary, dance.learning.other, OR null when topic is non-dance>",
  "title": "<headline ≤140>",
  "scope": "<description 20-1500>",
  "kind_payload": {
    "learning": { "topic": "<canonical skill noun e.g. 'salsa'>", "mode_pref": "<in_person|online|either|null>", "secondary_modes": [<strings>], "duration_pref": "<short string or null>", "urgency": "<asap|this_month|flexible|null>" },
    "dance": { "variety": "<salsa|tango|bachata|kizomba|swing|ballroom|hiphop|contemporary|other|null>", "level_target": "<beginner|social|intermediate|advanced|professional|null>", "role_pref": "<lead|follow|either|null>", "formality": "<casual|social|professional|null>" },
    "counterparty_filter": { "gender": "<string or null>", "age_min": <number or null>, "age_max": <number or null>, "max_radius_km": <number or null>, "location_label": "<city or null>", "max_price_cents": <number or null> }
  },
  "confidence": <0-1>
}
Set "dance" only if the topic is a dance variety; leave the whole "dance" object out otherwise. Set "counterparty_filter" only when the user explicitly states preferences (gender/age/radius/price); omit otherwise.`,
  mentor_seek: `Extract a mentor_seek intent (user is OFFERING to teach a skill). Return JSON only:
{ "category": "<one of: dance.teaching.salsa, dance.teaching.tango, dance.teaching.bachata, dance.teaching.kizomba, dance.teaching.swing, dance.teaching.ballroom, dance.teaching.hiphop, dance.teaching.contemporary, dance.teaching.other, OR null when topic is non-dance>",
  "title": "<headline ≤140>",
  "scope": "<description 20-1500>",
  "kind_payload": {
    "teaching": { "topic": "<canonical skill noun>", "modes_offered": [<'in_person','online','hybrid'>], "price_cents": <number or null — leave null if free or not stated>, "currency": "<ISO 4217, default EUR>", "slot_windows": [<strings like 'tue 19:00-20:30'>], "level_targets": [<'beginner','intermediate','advanced'>] },
    "dance": { "variety": "<same enum as learning_seek or null>", "role_taught": "<lead|follow|both|null>", "formality": "<casual|social|professional|null>" }
  },
  "confidence": <0-1>
}
"dance" only when teaching a dance variety. price_cents=null means "free" or "not stated"; the dispatcher confirms free-vs-paid with the user.`,
};

function parseExtractorResponse(raw: string, kind: IntentKind): ExtractedIntent {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      intent_kind: kind,
      category: null,
      title: null,
      scope: null,
      kind_payload: {},
      confidence: 0,
      missing_critical: CRITICAL_FIELDS_BY_KIND[kind],
    };
  }

  const result: ExtractedIntent = {
    intent_kind: kind,
    category: typeof parsed.category === 'string' && parsed.category ? parsed.category : null,
    title: typeof parsed.title === 'string' && parsed.title ? parsed.title.slice(0, 140) : null,
    scope: typeof parsed.scope === 'string' && parsed.scope ? parsed.scope.slice(0, 1500) : null,
    kind_payload: typeof parsed.kind_payload === 'object' && parsed.kind_payload ? parsed.kind_payload : {},
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
    missing_critical: [],
  };

  // Compute missing_critical from CRITICAL_FIELDS_BY_KIND.
  for (const path of CRITICAL_FIELDS_BY_KIND[kind]) {
    if (path === 'title' && !result.title) result.missing_critical.push('title');
    else if (path === 'scope' && !result.scope) result.missing_critical.push('scope');
    else if (path.startsWith('kind_payload.')) {
      const key = path.slice('kind_payload.'.length);
      if (!result.kind_payload[key]) result.missing_critical.push(path);
    }
  }

  return result;
}

export async function extractIntent(utterance: string, kind: IntentKind): Promise<ExtractedIntent> {
  const trimmed = (utterance || '').trim();
  if (!trimmed) {
    return {
      intent_kind: kind,
      category: null,
      title: null,
      scope: null,
      kind_payload: {},
      confidence: 0,
      missing_critical: CRITICAL_FIELDS_BY_KIND[kind],
    };
  }

  const systemPrompt = SYSTEM_PROMPT_BY_KIND[kind];

  if (vertexAI) {
    try {
      const model = vertexAI.getGenerativeModel({
        model: EXTRACT_MODEL,
        generationConfig: { temperature: 0.1, maxOutputTokens: 800, topP: 0.8 },
        systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
      });
      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: trimmed }] }],
      });
      const textPart = response.response?.candidates?.[0]?.content?.parts?.find((p: any) => 'text' in p);
      const raw = textPart ? (textPart as any).text : '';
      if (raw) return parseExtractorResponse(raw, kind);
    } catch (err: any) {
      console.warn(`[VTID-01973] Vertex extractor failed (kind=${kind}): ${err.message}`);
    }
  }

  if (GOOGLE_GEMINI_API_KEY) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${EXTRACT_MODEL}:generateContent?key=${GOOGLE_GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: trimmed }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: { temperature: 0.1, maxOutputTokens: 800 },
          }),
        }
      );
      if (response.ok) {
        const data = await response.json() as any;
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return parseExtractorResponse(raw, kind);
      }
    } catch (err: any) {
      console.warn(`[VTID-01973] Gemini API extractor failed (kind=${kind}): ${err.message}`);
    }
  }

  return {
    intent_kind: kind,
    category: null,
    title: null,
    scope: null,
    kind_payload: {},
    confidence: 0,
    missing_critical: CRITICAL_FIELDS_BY_KIND[kind],
  };
}
