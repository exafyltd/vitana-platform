/**
 * Vitana Voice Skill for OpenClaw
 *
 * ORB live voice session management, voice feedback collection,
 * session diagnostics, and turn-by-turn observability.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SessionDiagnosticsSchema = z.object({
  tenant_id: z.string().uuid(),
  session_id: z.string().uuid(),
});

const ListSessionsSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

const SubmitFeedbackSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  session_id: z.string().uuid().optional(),
  feedback_type: z.enum(['bug', 'ux_suggestion', 'content_issue', 'general']),
  description: z.string().min(1).max(5000),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  metadata: z.record(z.unknown()).optional(),
});

const ListFeedbackSchema = z.object({
  tenant_id: z.string().uuid(),
  feedback_type: z.enum(['bug', 'ux_suggestion', 'content_issue', 'general']).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

const OrbContextSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  message: z.string().min(1).max(10000),
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

async function callGateway(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<unknown> {
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
  const res = await fetch(`${gatewayUrl}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Voice endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Get diagnostics for a voice session (turn-by-turn observability).
   */
  async session_diagnostics(input: unknown) {
    const { tenant_id, session_id } = SessionDiagnosticsSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);

    const data = await callGateway(`/voice-lab/sessions/${session_id}/diagnostics?${params.toString()}`, 'GET');
    return { success: true, diagnostics: data };
  },

  /**
   * List voice sessions with optional user filter.
   */
  async list_sessions(input: unknown) {
    const { tenant_id, user_id, limit } = ListSessionsSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    if (user_id) params.set('user_id', user_id);
    params.set('limit', String(limit));

    const data = await callGateway(`/voice-lab/sessions?${params.toString()}`, 'GET');
    return { success: true, sessions: data };
  },

  /**
   * Submit voice/ORB feedback (bug report, UX suggestion, etc.).
   */
  async submit_feedback(input: unknown) {
    const { tenant_id, user_id, session_id, feedback_type, description, severity, metadata } =
      SubmitFeedbackSchema.parse(input);

    const data = await callGateway('/voice-feedback', 'POST', {
      tenant_id,
      user_id,
      session_id,
      feedback_type,
      description,
      severity,
      metadata,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'voice.feedback_submitted',
      actor: 'openclaw-autopilot',
      details: { user_id, feedback_type, severity },
      created_at: new Date().toISOString(),
    });

    return { success: true, feedback: data };
  },

  /**
   * List voice feedback reports.
   */
  async list_feedback(input: unknown) {
    const { tenant_id, feedback_type, limit } = ListFeedbackSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    if (feedback_type) params.set('feedback_type', feedback_type);
    params.set('limit', String(limit));

    const data = await callGateway(`/voice-feedback?${params.toString()}`, 'GET');
    return { success: true, feedback: data };
  },

  /**
   * Process a message through the ORB conversation intelligence layer.
   */
  async process_message(input: unknown) {
    const { tenant_id, user_id, message } = OrbContextSchema.parse(input);

    const data = await callGateway('/orb/process', 'POST', {
      tenant_id,
      user_id,
      message,
      source: 'openclaw-autopilot',
    });

    return { success: true, response: data };
  },
};

export const SKILL_META = {
  name: 'vitana-voice',
  description: 'ORB voice sessions, diagnostics, feedback collection, and conversation intelligence',
  actions: Object.keys(actions),
};
