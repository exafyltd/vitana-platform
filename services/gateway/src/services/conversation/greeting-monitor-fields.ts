/**
 * VTID-04369 (WS-0.6) — every `greeting_sent` diag carries the same Monitor
 * columns.
 *
 * Command Hub → Conversation → Monitor reads register, bucket, nba,
 * nba_domain, current_route and lang from each `greeting_sent` event. Only the
 * `conv_resume` rung filled them; every other opener left blank columns, so the
 * Monitor could not show why most openers were chosen.
 *
 * Precedence, per column: the rung's own value → what the session knew at
 * emit time → a register derived from the opener → null. A rung-provided
 * value is never overwritten, and nothing is invented: the next-best action is
 * only reported by the rungs that actually computed one.
 */

export interface GreetingMonitorContext {
  bucket?: string | null;
  currentRoute?: string | null;
  lang?: string | null;
  /**
   * VTID-04420 (WS-2.1): which provider's candidate won the ranker and whether
   * the rung that fired spoke it (`resolveCandidateOutcome`). Omitted → the
   * candidate columns are not added.
   */
  candidate?: Record<string, unknown> | null;
}

/** The register an opener implies when its rung does not report one itself. */
export function registerForOpener(wakeOpener: string | null | undefined): string {
  const w = wakeOpener ?? '';
  if (!w) return 'default';
  if (w === 'silent_reconnect') return 'reconnect';
  if (w.includes('newday') || w === 'safe_fast_newday') return 'daily_briefing';
  if (w.includes('day_close')) return 'day_close';
  if (w.includes('first_time')) return 'first_time';
  if (w === 'conv_resume') return 'resume';
  if (w === 'override_v2' || w.startsWith('safe_fast_proactive')) return 'continuation';
  if (w === 'safe_fast_pending_context') return 'pending_context';
  return 'default';
}

function pick(...vals: unknown[]): unknown {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return null;
}

export function withGreetingMonitorFields(
  diag: Record<string, unknown> | null | undefined,
  ctx: GreetingMonitorContext,
): Record<string, unknown> {
  const d = diag ?? {};
  return {
    ...d,
    wake_opener: pick(d.wake_opener, 'legacy_default'),
    register: pick(d.register, registerForOpener(d.wake_opener as string | undefined)),
    bucket: pick(d.bucket, ctx.bucket),
    nba: pick(d.nba),
    nba_domain: pick(d.nba_domain),
    current_route: pick(d.current_route, ctx.currentRoute),
    lang: pick(d.lang, ctx.lang),
    ...(ctx.candidate ?? {}),
  };
}
