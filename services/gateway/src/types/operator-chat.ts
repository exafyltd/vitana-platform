/**
 * Operator Chat Types - VTID-0531
 * Type definitions for Operator Chat → OASIS Integration
 */

import { z } from 'zod';

// ==================== Chat Role and Mode ====================

export type OperatorChatRole = 'operator' | 'assistant' | 'system';
export type OperatorChatMode = 'chat' | 'task' | 'control';

// ==================== Input Schema ====================

/**
 * Extended ChatMessageSchema with thread, vtid, role, and mode support
 * - threadId: Optional thread identifier for conversation grouping
 * - vtid: Optional VTID link (e.g., 'VTID-0516')
 * - role: Message role (defaults to 'operator')
 * - mode: Message mode (defaults to 'chat')
 * - metadata: Optional additional metadata
 */
export const OperatorChatMessageSchema = z.object({
  message: z.string().min(1, "Message is required"),
  attachments: z.array(z.object({
    oasis_ref: z.string(),
    kind: z.enum(['image', 'video', 'file'])
  })).optional().default([]),
  // VTID-0531: Extended fields
  threadId: z.string().uuid().optional(),
  vtid: z.string().optional(),
  role: z.enum(['operator', 'assistant', 'system']).optional().default('operator'),
  mode: z.enum(['chat', 'task', 'control']).optional().default('chat'),
  metadata: z.record(z.unknown()).optional(),
});

export type OperatorChatMessageInput = z.infer<typeof OperatorChatMessageSchema>;

// ==================== Normalized Internal Model ====================

/**
 * Normalized chat message - always has threadId, role, and mode
 */
export interface NormalizedChatMessage {
  threadId: string;
  vtid?: string;
  message: string;
  role: OperatorChatRole;
  mode: OperatorChatMode;
  attachments: Array<{ oasis_ref: string; kind: 'image' | 'video' | 'file' }>;
  metadata?: Record<string, unknown>;
}

// ==================== Response Types ====================

/**
 * Chat response with extended fields for OASIS integration
 * Preserves all existing fields while adding threadId, messageId, createdAt
 */
export interface OperatorChatResponse {
  ok: boolean;
  reply: string;
  attachments: Array<{ oasis_ref: string; kind: 'image' | 'video' | 'file' }>;
  oasis_ref: string;
  meta: Record<string, unknown>;
  // VTID-0531: Extended response fields
  threadId: string;
  messageId: string;
  createdAt: string;
}

/**
 * Error response for chat endpoint
 */
export interface OperatorChatErrorResponse {
  ok: false;
  error: string;
  details?: string;
}

// ==================== Thread History Types ====================

/**
 * Single message in thread history
 */
export interface ThreadHistoryMessage {
  id: string;
  threadId: string;
  vtid?: string;
  role: OperatorChatRole;
  mode: OperatorChatMode;
  message: string;
  createdAt: string;
}

/**
 * Response for thread history endpoint
 */
export interface ThreadHistoryResponse {
  ok: boolean;
  data: ThreadHistoryMessage[];
}

// ==================== OASIS Event Payload ====================

/**
 * Payload structure for operator.chat.message events in OASIS
 */
export interface OperatorChatEventPayload {
  threadId: string;
  vtid?: string;
  role: OperatorChatRole;
  mode: OperatorChatMode;
  attachments_count?: number;
  metadata?: Record<string, unknown>;
}

// ==================== VTID Validation ====================

/**
 * VTID format regex - matches patterns like VTID-0516, VTID-01006, VTID-0527-B, DEV-ABC-0001-0002
 * VTID-01007: Updated to accept 4-5 digit VTIDs (canonical format is VTID-##### from VTID-01000+)
 */
export const VTID_REGEX = /^(VTID-\d{4,5}(-[A-Za-z0-9]+)?|[A-Z]+-[A-Z0-9]+-\d{4}-\d{4})$/;

/**
 * Validate VTID format
 */
export function isValidVtidFormat(vtid: string): boolean {
  return VTID_REGEX.test(vtid);
}
