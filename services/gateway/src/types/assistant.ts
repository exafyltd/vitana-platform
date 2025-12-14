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
}
