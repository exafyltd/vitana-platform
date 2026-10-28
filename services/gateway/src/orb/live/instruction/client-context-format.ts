/**
 * VTID-03252 — ENVIRONMENT context formatter (extracted for testability).
 *
 * Builds the "ENVIRONMENT CONTEXT" block the assistant reads for the user's
 * location + LOCAL TIME. Extracted out of the 13k-line orb-live route so the
 * context-integrity gate can assert its contract directly: it must surface
 * location + local time when known, must NEVER fabricate a city, and must
 * always carry a UTC anchor so the model can compute any timezone. Pure.
 */

import type { ClientContext } from '../types';

export function formatClientContextForInstruction(ctx: ClientContext): string {
  const parts: string[] = [];
  if (ctx.city && ctx.country) parts.push(`User location: ${ctx.city}, ${ctx.country}`);
  else if (ctx.country) parts.push(`User location: ${ctx.country}`);
  if (ctx.timezone) parts.push(`Timezone: ${ctx.timezone}`);
  if (ctx.localTime) parts.push(`Local time: ${ctx.localTime}`);
  // Always include UTC reference so the model can accurately calculate any timezone
  parts.push(`Current UTC time: ${new Date().toISOString()}`);
  if (ctx.device) parts.push(`Device: ${ctx.device}`);
  if (ctx.os) parts.push(`OS: ${ctx.os}`);
  if (parts.length === 0) return '';
  return `\nENVIRONMENT CONTEXT:\n${parts.join('\n')}\nWhen asked about the time in any city or timezone, calculate from the UTC time above — do NOT guess UTC offsets from memory, as DST rules change. Use this context naturally — e.g. time-appropriate greetings, location-relevant suggestions.`;
}
