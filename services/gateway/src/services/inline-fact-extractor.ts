/**
 * VTID-01225: Inline Fact Extractor (Cognee Fallback)
 *
 * Lightweight Gemini-based fact extractor that runs INSIDE the gateway
 * when the external Cognee extractor service is unavailable (404/down).
 *
 * Uses the SAME write_fact() RPC that Cognee uses, writing to the SAME
 * memory_facts table with the SAME schema. The read path (context-pack-builder)
 * doesn't care which service wrote the fact.
 *
 * Design constraints:
 * - Fire-and-forget (non-blocking, same as Cognee)
 * - Uses Vertex AI (primary) or Gemini API (fallback) - same as conversation route
 * - Writes via write_fact() RPC (same as cognee-extractor-client.ts line 582)
 * - Low temperature (0.1) for deterministic extraction
 * - Small token budget (512) to keep latency low
 * - Only extracts identity/preference/relationship facts (high-value)
 */

import { VertexAI } from '@google-cloud/vertexai';

// =============================================================================
// Configuration (mirrors gemini-operator.ts)
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'lovable-vitana-vers1';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
// Use flash model for extraction - faster and cheaper than pro
const EXTRACTION_MODEL = 'gemini-2.0-flash';

let vertexAI: VertexAI | null = null;
try {
  if (VERTEX_PROJECT && VERTEX_LOCATION) {
    vertexAI = new VertexAI({ project: VERTEX_PROJECT, location: VERTEX_LOCATION });
  }
} catch (err: any) {
  console.warn(`[VTID-01225-inline] Failed to init Vertex AI: ${err.message}`);
}

// =============================================================================
// Extraction Prompt
// =============================================================================

const EXTRACTION_SYSTEM_PROMPT = `You extract structured facts from a conversation turn.

Given a conversation between a User and Assistant, extract any personal facts the user reveals about themselves or others.

Return ONLY a JSON array of facts. Each fact must have:
- "fact_key": semantic key (e.g. "user_name", "user_residence", "user_favorite_color", "spouse_name", "user_occupation")
- "fact_value": the value (e.g. "Dusan", "Amsterdam", "blue", "Maria", "engineer")
- "entity": "self" if about the user, "disclosed" if about someone else
- "fact_value_type": "text", "date", or "number"

Common fact keys:
- user_name, user_residence, user_hometown, user_birthday, user_occupation, user_company
- user_favorite_color, user_favorite_food, user_favorite_drink, user_favorite_*
- user_allergy, user_medication, user_health_condition
- user_preference_*, user_goal_*
- spouse_name, fiancee_name, partner_name, mother_name, father_name, child_name, friend_name_*

Rules:
- Only extract facts the USER explicitly states (not assistant assumptions)
- If no facts are present, return an empty array: []
- Do NOT invent facts. Only extract what is clearly stated.
- Keep fact_value concise (1-5 words)
- For preferences, use "user_favorite_X" or "user_preference_X" as the key

Example input:
User: My name is Dusan and I live in Amsterdam. My favorite tea is Earl Grey.
Assistant: Nice to meet you Dusan! Amsterdam is a beautiful city.

Example output:
[{"fact_key":"user_name","fact_value":"Dusan","entity":"self","fact_value_type":"text"},{"fact_key":"user_residence","fact_value":"Amsterdam","entity":"self","fact_value_type":"text"},{"fact_key":"user_favorite_tea","fact_value":"Earl Grey","entity":"self","fact_value_type":"text"}]`;

// =============================================================================
// Types
// =============================================================================

interface ExtractedFact {
  fact_key: string;
  fact_value: string;
  entity: string;
  fact_value_type: string;
}

// =============================================================================
// Core: Extract facts using Gemini
// =============================================================================

async function callGeminiForExtraction(conversationText: string): Promise<ExtractedFact[]> {
  // Try Vertex AI first (primary on Cloud Run)
  if (vertexAI) {
    try {
      const model = vertexAI.getGenerativeModel({
        model: EXTRACTION_MODEL,
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 512,
          topP: 0.8,
        },
        systemInstruction: {
          role: 'system',
          parts: [{ text: EXTRACTION_SYSTEM_PROMPT }],
        },
      });

      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: conversationText }] }],
      });

      const candidate = response.response?.candidates?.[0];
      const textPart = candidate?.content?.parts?.find((p: any) => 'text' in p);
      const rawText = textPart ? (textPart as any).text : '[]';
      return parseFactsResponse(rawText);
    } catch (err: any) {
      console.warn(`[VTID-01225-inline] Vertex extraction failed: ${err.message}`);
    }
  }

  // Fallback to Gemini API key
  if (GOOGLE_GEMINI_API_KEY) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GOOGLE_GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: conversationText }] }],
            systemInstruction: { parts: [{ text: EXTRACTION_SYSTEM_PROMPT }] },
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 512,
            },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Gemini API returned ${response.status}`);
      }

      const data = await response.json() as any;
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
      return parseFactsResponse(rawText);
    } catch (err: any) {
      console.warn(`[VTID-01225-inline] Gemini API extraction failed: ${err.message}`);
    }
  }

  return [];
}

/**
 * Parse the LLM response into structured facts.
 * Handles markdown code blocks, trailing text, etc.
 */
function parseFactsResponse(raw: string): ExtractedFact[] {
  try {
    // Strip markdown code blocks if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    // Find the JSON array in the response
    const arrayStart = cleaned.indexOf('[');
    const arrayEnd = cleaned.lastIndexOf(']');
    if (arrayStart === -1 || arrayEnd === -1) {
      return [];
    }

    const jsonStr = cleaned.substring(arrayStart, arrayEnd + 1);
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed)) return [];

    // Validate each fact
    return parsed.filter((f: any) =>
      f &&
      typeof f.fact_key === 'string' && f.fact_key.length > 0 &&
      typeof f.fact_value === 'string' && f.fact_value.length > 0 &&
      typeof f.entity === 'string' &&
      typeof f.fact_value_type === 'string'
    );
  } catch (err) {
    console.warn(`[VTID-01225-inline] Failed to parse extraction response: ${raw.substring(0, 100)}`);
    return [];
  }
}

// =============================================================================
// Core: Persist facts via write_fact() RPC
// =============================================================================

async function persistFact(
  tenant_id: string,
  user_id: string,
  fact: ExtractedFact
): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return false;

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/write_fact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({
        p_tenant_id: tenant_id,
        p_user_id: user_id,
        p_fact_key: fact.fact_key,
        p_fact_value: fact.fact_value,
        p_entity: fact.entity,
        p_fact_value_type: fact.fact_value_type,
        p_provenance_source: 'assistant_inferred',
        p_provenance_confidence: 0.80,
      }),
    });

    if (response.ok) {
      const factId = await response.json();
      console.log(`[VTID-01225-inline] Persisted: ${fact.fact_key}="${fact.fact_value}" (id=${factId})`);
      return true;
    } else {
      const errorText = await response.text();
      console.warn(`[VTID-01225-inline] write_fact failed for "${fact.fact_key}": ${response.status} - ${errorText}`);
      return false;
    }
  } catch (err: any) {
    console.warn(`[VTID-01225-inline] Persist error for "${fact.fact_key}": ${err.message}`);
    return false;
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Extract facts from a conversation turn and persist to memory_facts.
 * Fire-and-forget: call this without awaiting.
 *
 * Uses the same write_fact() RPC as Cognee, writing to the same table.
 * The read path (context-pack-builder fetchMemoryFacts) picks up both.
 */
export async function extractAndPersistFacts(input: {
  conversationText: string;
  tenant_id: string;
  user_id: string;
  session_id: string;
}): Promise<void> {
  const startTime = Date.now();

  try {
    // Skip very short messages (unlikely to contain facts)
    if (input.conversationText.length < 30) return;

    const facts = await callGeminiForExtraction(input.conversationText);

    if (facts.length === 0) {
      console.debug(`[VTID-01225-inline] No facts extracted from turn (${input.session_id})`);
      return;
    }

    let persisted = 0;
    let failed = 0;

    for (const fact of facts) {
      const ok = await persistFact(input.tenant_id, input.user_id, fact);
      if (ok) persisted++;
      else failed++;
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `[VTID-01225-inline] Extraction complete: ${facts.length} facts found, ` +
      `${persisted} persisted, ${failed} failed (${durationMs}ms)`
    );
  } catch (err: any) {
    console.warn(`[VTID-01225-inline] Extraction failed (non-blocking): ${err.message}`);
  }
}

/**
 * Check if inline extraction is available (has LLM + Supabase config)
 */
export function isInlineExtractionAvailable(): boolean {
  const hasLLM = !!vertexAI || !!GOOGLE_GEMINI_API_KEY;
  const hasSupabase = !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE;
  return hasLLM && hasSupabase;
}
