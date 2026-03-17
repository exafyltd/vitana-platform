/**
 * LLM-Powered Analyzer - VTID-01185
 *
 * Replaces static heuristic analyzers with intelligent LLM-powered analysis.
 * Uses Gemini to analyze:
 * - Recent OASIS error patterns and suggest root-cause fixes
 * - System health patterns and architectural improvements
 * - Stalled VTIDs and what would unblock them
 */

import { createHash } from 'crypto';

const LOG_PREFIX = '[VTID-01185:LLM]';

// =============================================================================
// Types
// =============================================================================

export interface LLMSignal {
  type: 'root_cause' | 'architecture' | 'unblock' | 'optimization' | 'security';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  message: string;
  source_ref: string;
  suggested_action: string;
  suggested_files: string[];
  confidence: number; // 0-1
}

export interface LLMAnalysisResult {
  ok: boolean;
  signals: LLMSignal[];
  summary: {
    events_analyzed: number;
    signals_generated: number;
    model_used: string;
    duration_ms: number;
  };
  error?: string;
}

// =============================================================================
// Supabase Helper
// =============================================================================

async function queryOasisEvents(query: string): Promise<any[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) return [];

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/oasis_events?${query}`, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    if (!response.ok) return [];
    return (await response.json()) as any[];
  } catch {
    return [];
  }
}

async function queryVtidLedger(query: string): Promise<any[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) return [];

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?${query}`, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    if (!response.ok) return [];
    return (await response.json()) as any[];
  } catch {
    return [];
  }
}

// =============================================================================
// LLM Call
// =============================================================================

async function callLLM(prompt: string, systemInstruction: string): Promise<string | null> {
  // Try Gemini via Vertex AI
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || 'lovable-vitana-vers1';
  const location = 'us-central1';
  const model = 'gemini-3.1-pro-preview';

  try {
    // Get access token via ADC
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const accessToken = (await client.getAccessToken()).token;

    if (!accessToken) {
      console.warn(`${LOG_PREFIX} No access token available, skipping LLM analysis`);
      return null;
    }

    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`${LOG_PREFIX} Gemini API error: ${response.status}: ${err}`);
      return null;
    }

    const data = await response.json() as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text || null;
  } catch (error) {
    console.error(`${LOG_PREFIX} LLM call failed:`, error);
    return null;
  }
}

// =============================================================================
// Analysis Functions
// =============================================================================

/**
 * Analyze recent error patterns using LLM to find root causes
 */
async function analyzeErrorPatterns(): Promise<LLMSignal[]> {
  const lookbackHours = 24;
  const lookbackTime = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  // Get recent errors grouped by topic
  const errors = await queryOasisEvents(
    `status=eq.error&created_at=gte.${lookbackTime}&order=created_at.desc&limit=200&select=topic,message,service,metadata,created_at`
  );

  if (errors.length < 3) return []; // Not enough data

  // Group errors by topic for summary
  const grouped: Record<string, { count: number; messages: string[]; services: Set<string> }> = {};
  for (const err of errors) {
    const key = err.topic || 'unknown';
    if (!grouped[key]) grouped[key] = { count: 0, messages: [], services: new Set() };
    grouped[key].count++;
    if (grouped[key].messages.length < 3) {
      grouped[key].messages.push((err.message || '').slice(0, 200));
    }
    if (err.service) grouped[key].services.add(err.service);
  }

  const errorSummary = Object.entries(grouped)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 10)
    .map(([topic, data]) => ({
      topic,
      count: data.count,
      services: Array.from(data.services),
      sample_messages: data.messages,
    }));

  const prompt = `Analyze these error patterns from the last ${lookbackHours} hours and suggest concrete fixes:

${JSON.stringify(errorSummary, null, 2)}

For each significant error pattern, provide:
1. Root cause analysis
2. Specific fix recommendation
3. Files/services likely involved
4. Risk level (low/medium/high/critical)
5. Confidence score (0-1)

Return JSON array of objects with fields: type, severity, title, message, source_ref, suggested_action, suggested_files, confidence`;

  const systemInstruction = `You are a platform reliability engineer analyzing error patterns in the Vitana health/longevity platform.
The platform runs on Cloud Run with a Node.js/Express gateway, Supabase database, and Gemini AI integration.
Focus on actionable, specific recommendations. Avoid vague suggestions.
Return valid JSON array. Each item must have: type (one of: root_cause, optimization, security), severity (low/medium/high/critical), title (string, max 100 chars), message (string, detailed explanation), source_ref (string, the error topic), suggested_action (string, specific action), suggested_files (string array), confidence (number 0-1).`;

  const result = await callLLM(prompt, systemInstruction);
  if (!result) return [];

  try {
    const parsed = JSON.parse(result) as LLMSignal[];
    return Array.isArray(parsed) ? parsed.filter(s => s.title && s.message).slice(0, 5) : [];
  } catch {
    console.error(`${LOG_PREFIX} Failed to parse LLM response for error analysis`);
    return [];
  }
}

/**
 * Analyze stalled VTIDs and suggest unblocking actions
 */
async function analyzeStalledVtids(): Promise<LLMSignal[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const stalled = await queryVtidLedger(
    `status=neq.completed&is_terminal=eq.false&updated_at=lt.${thirtyDaysAgo}&select=vtid,title,status,summary,updated_at&order=updated_at.asc&limit=15`
  );

  if (stalled.length === 0) return [];

  const stalledSummary = stalled.map(v => ({
    vtid: v.vtid,
    title: v.title,
    status: v.status,
    summary: (v.summary || '').slice(0, 200),
    days_stalled: Math.floor((Date.now() - new Date(v.updated_at).getTime()) / (1000 * 60 * 60 * 24)),
  }));

  const prompt = `These VTIDs (tasks) have been stalled for over 30 days. Analyze why they might be stuck and suggest how to unblock them:

${JSON.stringify(stalledSummary, null, 2)}

For each stalled task, suggest:
1. Why it's likely stuck (common reasons: missing dependencies, unclear spec, blocked by other work)
2. Specific action to unblock it
3. Whether it should be cancelled, re-scoped, or retried

Return JSON array with: type ("unblock"), severity, title, message, source_ref (the VTID), suggested_action, suggested_files (empty array is fine), confidence`;

  const systemInstruction = `You are a project management AI analyzing stalled tasks in the Vitana platform.
Provide actionable suggestions to unblock stalled work. Be realistic about which tasks should be cancelled vs retried.
Return valid JSON array.`;

  const result = await callLLM(prompt, systemInstruction);
  if (!result) return [];

  try {
    const parsed = JSON.parse(result) as LLMSignal[];
    return Array.isArray(parsed) ? parsed.filter(s => s.title && s.message).slice(0, 5) : [];
  } catch {
    console.error(`${LOG_PREFIX} Failed to parse LLM response for stalled analysis`);
    return [];
  }
}

// =============================================================================
// Main Analyzer
// =============================================================================

export async function analyzeLLM(): Promise<LLMAnalysisResult> {
  const startTime = Date.now();
  console.log(`${LOG_PREFIX} Starting LLM-powered analysis...`);

  try {
    const [errorSignals, stalledSignals] = await Promise.all([
      analyzeErrorPatterns(),
      analyzeStalledVtids(),
    ]);

    const allSignals = [...errorSignals, ...stalledSignals];

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Analysis complete: ${allSignals.length} signals in ${duration}ms`);

    return {
      ok: true,
      signals: allSignals,
      summary: {
        events_analyzed: allSignals.length,
        signals_generated: allSignals.length,
        model_used: 'gemini-3.1-pro-preview',
        duration_ms: duration,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} Analysis failed:`, errorMessage);

    return {
      ok: false,
      signals: [],
      summary: {
        events_analyzed: 0,
        signals_generated: 0,
        model_used: 'gemini-3.1-pro-preview',
        duration_ms: Date.now() - startTime,
      },
      error: errorMessage,
    };
  }
}

// =============================================================================
// Fingerprint
// =============================================================================

export function generateLLMFingerprint(signal: LLMSignal): string {
  const data = `llm:${signal.type}:${signal.source_ref}:${signal.title.slice(0, 50)}`;
  return createHash('sha256').update(data).digest('hex').substring(0, 16);
}
