/**
 * VTID-0150-B: Assistant Core Types
 *
 * Types for the global Assistant Core API.
 * This is separate from Operator Chat - it powers the Dev ORB.
 */

import { z } from 'zod';

/**
 * Assistant Chat Request Schema
 */
export const AssistantChatRequestSchema = z.object({
  message: z.string().min(1, 'Message is required'),
  sessionId: z.string().optional().nullable(),
  role: z.string().default('DEV'),
  tenant: z.string().default('Vitana-Dev'),
  route: z.string().optional().default(''),
  selectedId: z.string().optional().default('')
});

export type AssistantChatRequest = z.infer<typeof AssistantChatRequestSchema>;

/**
 * Assistant Chat Response
 */
export interface AssistantChatResponse {
  ok: boolean;
  reply: string;
  sessionId: string;
  oasis_ref: string;
  meta: {
    model: string;
    tokens_in: number;
    tokens_out: number;
    latency_ms: number;
  };
  error?: string;
  /** Intelligent Calendar: structured actions the assistant proposes */
  calendar_actions?: Array<{
    type: 'create_event' | 'reschedule_event' | 'cancel_event' | 'complete_event';
    payload: Record<string, unknown>;
    requires_confirmation: boolean;
    natural_language_summary: string;
  }>;
}

/**
 * Assistant Session Context
 * Passed to Gemini for contextual responses
 */
export interface AssistantContext {
  sessionId: string;
  role: string;
  tenant: string;
  route: string;
  selectedId: string;
  /**
   * VTID-01967: Canonical Vitana ID handle (e.g. "@alex3700"). Optional —
   * Dev ORB body does not currently carry one, but downstream prompts use
   * this when present so the assistant can answer "what is my user ID?"
   * with the handle instead of leaking the internal UUID.
   */
  vitanaId?: string | null;
}
