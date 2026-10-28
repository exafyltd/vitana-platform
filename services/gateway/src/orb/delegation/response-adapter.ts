/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Normalize a provider response for voice
 * or chat delivery.
 *
 * - Voice mode: strip markdown, code fences, headers, bullet markers — the
 *   TTS pipeline reads text literally so "*bold*" becomes "asterisk bold
 *   asterisk" without this. Length-capped so a runaway provider response
 *   doesn't create a 5-minute voice monologue.
 * - Chat mode: preserve markdown for rich rendering.
 */
import type { DelegationResult } from './types';

const VOICE_MAX_CHARS = 4000;

export type DeliveryMode = 'voice' | 'chat';

export function adaptForDelivery(result: DelegationResult, mode: DeliveryMode): string {
  if (mode === 'chat') return result.text;
  return normalizeForVoice(result.text);
}

/**
 * Converts markdown-ish output into clean, spoken-friendly text.
 * Conservative — preserves sentence structure, just drops formatting syntax.
 */
export function normalizeForVoice(text: string): string {
  if (!text) return '';
  let out = text;

  // Strip fenced code blocks wholesale — TTS reading code is unusable
  out = out.replace(/```[\s\S]*?```/g, '(code omitted)');
  // Strip inline code backticks but keep the content
  out = out.replace(/`([^`]+)`/g, '$1');
  // Strip markdown headers (leading #/##/### etc.)
  out = out.replace(/^#{1,6}\s+/gm, '');
  // Strip bold/italic markers (keep the content)
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/\*([^*]+)\*/g, '$1');
  out = out.replace(/__([^_]+)__/g, '$1');
  out = out.replace(/_([^_]+)_/g, '$1');
  // Bullet markers → soft comma breaks
  out = out.replace(/^\s*[-*+]\s+/gm, '');
  // Numbered lists → plain
  out = out.replace(/^\s*\d+\.\s+/gm, '');
  // Links [text](url) → just "text"
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  // Collapse multiple blank lines
  out = out.replace(/\n{3,}/g, '\n\n');
  // Trim
  out = out.trim();

  if (out.length > VOICE_MAX_CHARS) {
    out = out.slice(0, VOICE_MAX_CHARS).replace(/\s+\S*$/, '') + '…';
  }

  return out;
}
