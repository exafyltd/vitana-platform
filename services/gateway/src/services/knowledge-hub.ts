/**
 * VTID-0538: Vitana Knowledge Hub v2
 *
 * Provides doc-grounded answers for Operator Chat via full-text search.
 * Uses Supabase knowledge_docs table with tsvector for efficient search.
 *
 * Features:
 * - Full-text search across KB documents, docs, and specs
 * - Generates contextual answers from search results
 * - Integrates with Gemini as a function calling tool
 */

import fetch from 'node-fetch';
import { emitOasisEvent } from './oasis-event-service';

// Environment config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

// ==================== Types ====================

export interface KnowledgeSearchRequest {
  query: string;
  role?: string;
  tenant?: string;
  maxResults?: number;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  snippet: string;
  source: string;
  score: number;
}

export interface KnowledgeSearchResponse {
  ok: boolean;
  answer: string;
  docs: KnowledgeDoc[];
  error?: string;
}

interface SupabaseSearchResult {
  id: string;
  title: string;
  path: string;
  snippet: string;
  source_type: string;
  tags: string[];
  score: number;
}

// ==================== Core Search Function ====================

/**
 * Search knowledge docs using Supabase full-text search
 */
export async function searchKnowledgeDocs(
  query: string,
  maxResults: number = 5
): Promise<KnowledgeDoc[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0538] Supabase not configured for knowledge search');
    return [];
  }

  try {
    // Use the search_knowledge_docs RPC function
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_knowledge_docs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
      },
      body: JSON.stringify({
        search_query: query,
        max_results: maxResults
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[VTID-0538] Knowledge search failed: ${response.status} - ${errorText}`);
      return [];
    }

    const results = (await response.json()) as SupabaseSearchResult[];

    return results.map(r => ({
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      source: r.path,
      score: r.score
    }));
  } catch (error: any) {
    console.error(`[VTID-0538] Knowledge search error:`, error.message);
    return [];
  }
}

/**
 * Generate an answer from search results using Gemini
 */
async function generateAnswer(
  query: string,
  docs: KnowledgeDoc[]
): Promise<string> {
  if (docs.length === 0) {
    return `I couldn't find any documentation matching your query "${query}". Try rephrasing your question or check the Vitana documentation directly.`;
  }

  // If no Gemini API key, return a simple formatted answer
  if (!GOOGLE_GEMINI_API_KEY) {
    return formatSimpleAnswer(query, docs);
  }

  try {
    // Build context from docs
    const context = docs
      .map((doc, i) => `[Doc ${i + 1}: ${doc.title}]\n${doc.snippet}`)
      .join('\n\n');

    const prompt = `You are a Vitana documentation assistant. Answer the user's question based ONLY on the documentation excerpts provided below. Be concise and accurate. If the documentation doesn't contain enough information to fully answer, say so.

Documentation excerpts:
${context}

User question: ${query}

Answer (be specific and reference the documentation):`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GOOGLE_GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 512
          }
        })
      }
    );

    if (!response.ok) {
      console.warn(`[VTID-0538] Gemini answer generation failed: ${response.status}`);
      return formatSimpleAnswer(query, docs);
    }

    const result = (await response.json()) as any;
    const textPart = result.candidates?.[0]?.content?.parts?.find((p: any) => p.text);

    return textPart?.text || formatSimpleAnswer(query, docs);
  } catch (error: any) {
    console.warn(`[VTID-0538] Answer generation error:`, error.message);
    return formatSimpleAnswer(query, docs);
  }
}

/**
 * Format a simple answer from docs without Gemini
 */
function formatSimpleAnswer(query: string, docs: KnowledgeDoc[]): string {
  if (docs.length === 0) {
    return `No documentation found for "${query}".`;
  }

  const topDoc = docs[0];
  let answer = `Based on the Vitana documentation:\n\n`;
  answer += `**${topDoc.title}**\n`;
  answer += `${topDoc.snippet}\n\n`;

  if (docs.length > 1) {
    answer += `_Related documents: ${docs.slice(1).map(d => d.title).join(', ')}_`;
  }

  return answer;
}

// ==================== Main API Function ====================

/**
 * Search knowledge and generate an answer
 * This is the main function called by the API endpoint
 */
export async function searchKnowledge(
  request: KnowledgeSearchRequest
): Promise<KnowledgeSearchResponse> {
  const { query, role = 'operator', tenant, maxResults = 5 } = request;

  console.log(`[VTID-0538] Knowledge search: "${query}" (role=${role}, tenant=${tenant || 'default'})`);

  // Log search event
  await emitOasisEvent({
    vtid: 'VTID-0538',
    type: 'knowledge.search',
    source: 'operator-console',
    status: 'info',
    message: `Knowledge search: ${query}`,
    payload: {
      query,
      role,
      tenant,
      maxResults
    }
  }).catch(err => console.warn('[VTID-0538] Failed to log search event:', err.message));

  try {
    // Search for documents
    const docs = await searchKnowledgeDocs(query, maxResults);

    // Generate answer from docs
    const answer = await generateAnswer(query, docs);

    // Log success event
    await emitOasisEvent({
      vtid: 'VTID-0538',
      type: 'knowledge.search.success',
      source: 'operator-console',
      status: 'success',
      message: `Knowledge search completed: ${docs.length} docs found`,
      payload: {
        query,
        docsFound: docs.length,
        topDoc: docs[0]?.title || null
      }
    }).catch(err => console.warn('[VTID-0538] Failed to log success event:', err.message));

    console.log(`[VTID-0538] Search complete: ${docs.length} docs found`);

    return {
      ok: true,
      answer,
      docs
    };
  } catch (error: any) {
    console.error(`[VTID-0538] Knowledge search failed:`, error.message);

    // Log error event
    await emitOasisEvent({
      vtid: 'VTID-0538',
      type: 'knowledge.search.error',
      source: 'operator-console',
      status: 'error',
      message: `Knowledge search failed: ${error.message}`,
      payload: { query, error: error.message }
    }).catch(() => {});

    return {
      ok: false,
      answer: `I encountered an error searching the documentation: ${error.message}`,
      docs: [],
      error: error.message
    };
  }
}

// ==================== Gemini Tool Definition ====================

/**
 * Gemini tool definition for knowledge_search
 * This should be added to the existing GEMINI_TOOL_DEFINITIONS
 */
export const KNOWLEDGE_SEARCH_TOOL_DEFINITION = {
  name: 'knowledge_search',
  description: `Search the Vitana documentation and knowledge base to answer questions about Vitana concepts, architecture, features, and specifications.

Use this tool when the user asks:
- "What is the Vitana Index?"
- "Explain the Command Hub architecture"
- "What is OASIS?"
- "How does the Autopilot system work?"
- "What are the three tenants (Maxina, AlKalma, Earthlings)?"
- Any "What", "How", "Explain", "Why" questions about Vitana

Do NOT use this tool for action commands like "Create a task" or "Deploy gateway" - use autopilot tools for those.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query or question about Vitana documentation'
      }
    },
    required: ['query']
  }
};

/**
 * Execute knowledge_search tool
 * Called by the Gemini operator when this tool is invoked
 * VTID-01025: Added guard to reject non-Vitana queries
 */
export async function executeKnowledgeSearch(
  args: { query: string },
  threadId: string
): Promise<{
  ok: boolean;
  data?: { answer: string; docs: KnowledgeDoc[] };
  error?: string;
}> {
  console.log(`[VTID-0538] knowledge_search tool called: "${args.query}"`);

  const lowerQuery = args.query.toLowerCase().trim();

  // VTID-01025: Detect non-Vitana queries and return guidance
  // This prevents unhelpful "couldn't find documentation" responses
  const vitanaKeywords = [
    'vitana', 'oasis', 'autopilot', 'command hub', 'commandhub', 'vtid',
    'maxina', 'alkalma', 'earthlings', 'tenant', 'governance', 'planner',
    'worker', 'validator', 'gateway', 'ledger', 'spec', 'index'
  ];

  const isVitanaQuery = vitanaKeywords.some(kw => lowerQuery.includes(kw));

  // Also check if it's a "what is/how does" question that might be about Vitana
  const isExplanatoryQuestion = /^(what|how|explain|describe|tell me about)/i.test(lowerQuery);

  // Reject clearly non-Vitana queries (greetings, math, general chat)
  const isConversational = /^(hi|hello|hey|thanks|thank you|ok|okay|bye|yes|no|sure|fuck|shit|damn)/i.test(lowerQuery);
  const isMathOrGeneral = /^\d|capital|president|weather|calculate|multiply|divide/i.test(lowerQuery);

  if (!isVitanaQuery && (isConversational || isMathOrGeneral || !isExplanatoryQuestion)) {
    console.log(`[VTID-01025] Rejecting non-Vitana query: "${args.query}"`);
    return {
      ok: true,
      data: {
        answer: `[NOT_VITANA_QUERY] This query is not about Vitana documentation. Respond naturally to the user's message "${args.query}" using your general knowledge. Do not mention documentation or searching.`,
        docs: []
      }
    };
  }

  const result = await searchKnowledge({
    query: args.query,
    role: 'operator',
    maxResults: 5
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error || 'Knowledge search failed'
    };
  }

  return {
    ok: true,
    data: {
      answer: result.answer,
      docs: result.docs
    }
  };
}
