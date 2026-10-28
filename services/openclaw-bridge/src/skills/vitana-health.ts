/**
 * Vitana Health Skill for OpenClaw
 *
 * Mandatory skill that handles health-related operations with
 * PHI protection. All health data is processed locally via Ollama
 * and redacted before any external LLM interaction.
 *
 * This skill MUST be invoked before OpenClaw planning for any
 * task that involves health/wellness data.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { redactPhi, containsPhi, redactObjectPhi } from '../middleware/phi-redactor';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RedactTextSchema = z.object({
  text: z.string().min(1),
  context: z.string().optional(),
});

const SummarizeReportSchema = z.object({
  tenant_id: z.string().uuid(),
  report_id: z.string().uuid(),
});

const CheckConsentSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  purpose: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE required');
  return createClient(url, key);
}

/**
 * Call local Ollama for health-safe summarization.
 * PHI stays on-premise - never sent to external providers.
 */
async function callLocalLlm(prompt: string): Promise<string> {
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const model = process.env.OPENCLAW_HEALTH_MODEL ?? 'llama3.1:8b';

  const res = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.3 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Local LLM call failed (${res.status}): ${await res.text()}`);
  }

  const result = (await res.json()) as { response: string };
  return result.response;
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Redact PHI from text. Returns redacted text with entity annotations.
   */
  async redact_phi(input: unknown) {
    const { text, context } = RedactTextSchema.parse(input);
    const result = redactPhi(text);

    return {
      success: true,
      original_length: text.length,
      redacted: result.redacted,
      entities_found: result.entityCount,
      entity_types: [...new Set(result.entities.map((e) => e.type))],
      context,
    };
  },

  /**
   * Check if text contains PHI. Use as a gate before external LLM calls.
   */
  async check_phi(input: unknown) {
    const { text } = z.object({ text: z.string().min(1) }).parse(input);
    const hasPhi = containsPhi(text);

    return {
      success: true,
      contains_phi: hasPhi,
      recommendation: hasPhi
        ? 'USE_LOCAL_LLM: Text contains PHI - must use Ollama for processing'
        : 'SAFE: No PHI detected - external LLM may be used',
    };
  },

  /**
   * Summarize a health report using LOCAL LLM only.
   * Fetches report from DB, redacts PHI, summarizes via Ollama.
   */
  async summarize_report(input: unknown) {
    const { tenant_id, report_id } = SummarizeReportSchema.parse(input);
    const supabase = getSupabase();

    // Fetch report
    const { data: report, error } = await supabase
      .from('health_reports')
      .select('*')
      .eq('id', report_id)
      .eq('tenant_id', tenant_id)
      .single();

    if (error || !report) {
      throw new Error(`Report ${report_id} not found: ${error?.message ?? 'not found'}`);
    }

    // Redact before summarization (defense in depth)
    const { redacted: safeReport } = redactObjectPhi(report as Record<string, unknown>);

    // Summarize using local LLM
    const prompt = `Summarize the following health report concisely. Focus on key findings and recommendations. Do not include any personally identifiable information.\n\nReport:\n${JSON.stringify(safeReport, null, 2)}`;
    const summary = await callLocalLlm(prompt);

    // Double-check: redact the summary output too
    const { redacted: safeSummary } = redactPhi(summary);

    // Audit
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'health.report_summarized',
      actor: 'openclaw-autopilot',
      details: { report_id, used_local_llm: true },
      created_at: new Date().toISOString(),
    });

    return { success: true, summary: safeSummary, report_id };
  },

  /**
   * Check if a user has given consent for autopilot health operations.
   * Required before any health data processing.
   */
  async check_consent(input: unknown) {
    const { tenant_id, user_id, purpose } = CheckConsentSchema.parse(input);
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('user_consents')
      .select('consent_given, consent_date, scope')
      .eq('tenant_id', tenant_id)
      .eq('user_id', user_id)
      .eq('purpose', purpose)
      .single();

    if (error || !data) {
      return {
        success: true,
        has_consent: false,
        reason: 'No consent record found - must obtain user consent before processing',
      };
    }

    return {
      success: true,
      has_consent: data.consent_given === true,
      consent_date: data.consent_date,
      scope: data.scope,
    };
  },
};

export const SKILL_META = {
  name: 'vitana-health',
  description: 'Health data operations with mandatory PHI protection and local LLM processing',
  actions: Object.keys(actions),
};
