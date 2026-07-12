/**
 * Assistant briefing envelope (VTID-ASSISTANT-ROLES).
 *
 * One envelope shape for both the developer and the admin briefing so the
 * ORB session-start injection, the /api/v1/assistant/briefing routes, and
 * the get_briefing voice tools all speak the same contract:
 *
 *   status            — current state of the caller's domain
 *   since_last_session— what changed since they last talked to Vitana
 *   attention         — ranked items that need action NOW
 *   next_step         — the SINGLE recommended next action
 *   degraded_sources  — sources that timed out / failed (honesty > silence)
 *
 * Ranking lives in the briefing services (deterministic, unit-testable),
 * never in the prompt.
 */

export type BriefingRole = 'developer' | 'admin';

export type AttentionSeverity = 'critical' | 'warning' | 'info';

export interface BriefingItem {
  /** Stable machine key of the source (e.g. 'self_healing', 'moderation'). */
  source: string;
  /** One spoken-friendly sentence. LLM-facing English (system-prompt content). */
  line: string;
  /** Optional structured payload for the text surface / drill-down. */
  data?: Record<string, unknown>;
}

export interface AttentionItem extends BriefingItem {
  severity: AttentionSeverity;
  /**
   * Deterministic rank score — higher = more urgent. Computed by the
   * briefing service's ranking rules so voice and text order identically.
   */
  rank: number;
  /** ISO timestamp of the oldest underlying item, when known. */
  oldest_at?: string | null;
  /** True when an SLA/age threshold is breached. */
  sla_breach?: boolean;
  /** Suggested tool the assistant can call to act on this item. */
  action_hint?: string;
}

export interface NextStep {
  /** One-sentence recommendation, phrased as a proposal. */
  recommendation: string;
  /** Tool name the assistant should call (or offer) for this step. */
  tool: string | null;
  /** Argument template for the tool call (ids resolved, confirm omitted). */
  args_template: Record<string, unknown>;
  /** Action tier: 0 read, 1 reversible write, 2 destructive/outward. */
  tier: 0 | 1 | 2;
}

export interface BriefingEnvelope {
  ok: true;
  role: BriefingRole;
  tenant_id?: string | null;
  generated_at: string;
  status: { headline: string; items: BriefingItem[] };
  since_last_session: { since: string | null; items: BriefingItem[] };
  attention: { items: AttentionItem[] };
  next_step: NextStep | null;
  degraded_sources: string[];
}

/** Per-source fetch budget — a slow upstream degrades, never blocks. */
export const BRIEFING_SOURCE_TIMEOUT_MS = 2_500;

/** Envelope cache TTL — briefings are point-in-time, not real-time. */
export const BRIEFING_CACHE_TTL_MS = 60_000;

/**
 * Run a briefing source with a timeout. On timeout/failure the source is
 * recorded in `degraded` and `fallback` is returned — a failed source
 * becomes an honest "couldn't check X" line, never a crash.
 */
export async function briefingSource<T>(
  name: string,
  degraded: string[],
  fallback: T,
  work: Promise<T>,
  timeoutMs: number = BRIEFING_SOURCE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race<T | '__briefing_timeout__'>([
      work,
      new Promise<'__briefing_timeout__'>((resolve) => {
        timer = setTimeout(() => resolve('__briefing_timeout__'), timeoutMs);
      }),
    ]);
    if (result === '__briefing_timeout__') {
      degraded.push(name);
      return fallback;
    }
    return result as T;
  } catch (err) {
    console.warn(`[assistant-briefing] source '${name}' failed: ${String((err as Error)?.message || err)}`);
    degraded.push(name);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Compact relative age for speech ("12 min", "3 h", "2 days"). */
export function relAgeShort(iso: string | null | undefined): string {
  if (!iso) return 'unknown age';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown age';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}
