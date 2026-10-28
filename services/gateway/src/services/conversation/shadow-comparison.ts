/**
 * VTID-04422 (Plan v1 WS-2.2) — old ranking vs shadow ranking, over sessions.
 *
 * Each voice opening records a `continuation_shadow_ranked` event in its wake
 * timeline (`orb_wake_timelines`, one row per session, indexed by started_at).
 * This reads a bounded window of those rows and reports how often the weighted
 * score agrees with the fixed-priority ranker, and where it would differ — the
 * evidence the owner needs before the score is allowed to take over.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const SHADOW_MAX_DAYS = 30;
export const SHADOW_MAX_ROWS = 1000;

export interface ShadowComparisonSummary {
  days: number;
  sessions_read: number;
  sessions_ranked: number;
  agree: number;
  agree_rate: number | null;
  weights_versions: Record<string, number>;
  /** VTID-04435: sessions ranked with the user's own weights, and how often that changed the shadow winner. */
  personalized: number;
  personal_changed_winner: number;
  /** VTID-04454: sessions whose opening the score chose (BRAIN_SCORED_OPENING), and how many of those it changed. */
  scored_openings: number;
  scored_changed_opening: number;
  /** "live → shadow" winner pairs where they differ, most frequent first. */
  disagreements: Array<{ live: string; shadow: string; count: number }>;
  /** Per provider: how often each ranking picked it. */
  wins: Array<{ provider: string; live: number; shadow: number }>;
  recent_disagreements: Array<{
    session_id: string;
    started_at: string | null;
    live: string | null;
    shadow: string | null;
    top: Array<{ provider: string; score: number; priority: number }>;
  }>;
}

interface TimelineRow {
  session_id: string;
  started_at?: string | null;
  events?: unknown;
}

export function summarizeShadowComparisons(rows: TimelineRow[], days: number): ShadowComparisonSummary {
  let ranked = 0;
  let agree = 0;
  let personalized = 0;
  let personalChanged = 0;
  let scoredOpenings = 0;
  let scoredChanged = 0;
  const versions: Record<string, number> = {};
  const pairs = new Map<string, number>();
  const wins = new Map<string, { live: number; shadow: number }>();
  const recent: ShadowComparisonSummary['recent_disagreements'] = [];
  const bump = (p: string | null, side: 'live' | 'shadow') => {
    if (!p) return;
    const w = wins.get(p) ?? { live: 0, shadow: 0 };
    w[side] += 1;
    wins.set(p, w);
  };

  for (const row of rows) {
    const events = Array.isArray(row.events) ? (row.events as Array<Record<string, unknown>>) : [];
    const ev = events.find((e) => e?.name === 'continuation_shadow_ranked');
    if (!ev) continue;
    const m = (ev.metadata ?? {}) as Record<string, unknown>;
    const live = typeof m.live_winner === 'string' ? m.live_winner : null;
    const shadow = typeof m.shadow_winner === 'string' ? m.shadow_winner : null;
    ranked += 1;
    if (m.ranking_mode === 'scored') {
      scoredOpenings += 1;
      if (typeof m.served_winner === 'string' && m.served_winner !== live) scoredChanged += 1;
    }
    const pa = (m.personal ?? null) as Record<string, unknown> | null;
    if (pa && pa.applied === true) {
      personalized += 1;
      if (typeof m.shadow_winner_shared_weights === 'string' && m.shadow_winner_shared_weights !== shadow) personalChanged += 1;
    }
    const v = String(m.weights_version ?? '?');
    versions[v] = (versions[v] ?? 0) + 1;
    bump(live, 'live');
    bump(shadow, 'shadow');
    if (live === shadow) {
      agree += 1;
      continue;
    }
    const key = `${live ?? 'none'} → ${shadow ?? 'none'}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
    if (recent.length < 20) {
      const cands = Array.isArray(m.candidates) ? (m.candidates as Array<Record<string, unknown>>) : [];
      recent.push({
        session_id: row.session_id,
        started_at: row.started_at ?? null,
        live,
        shadow,
        top: cands.slice(0, 4).map((c) => ({
          provider: String(c.provider ?? '?'),
          score: Number(c.score) || 0,
          priority: Number(c.priority) || 0,
        })),
      });
    }
  }

  return {
    days,
    sessions_read: rows.length,
    sessions_ranked: ranked,
    agree,
    agree_rate: ranked > 0 ? Math.round((agree / ranked) * 1000) / 1000 : null,
    weights_versions: versions,
    personalized,
    personal_changed_winner: personalChanged,
    scored_openings: scoredOpenings,
    scored_changed_opening: scoredChanged,
    disagreements: [...pairs.entries()]
      .map(([k, count]) => {
        const [live, shadow] = k.split(' → ');
        return { live, shadow, count };
      })
      .sort((a, b) => b.count - a.count),
    wins: [...wins.entries()]
      .map(([provider, w]) => ({ provider, ...w }))
      .sort((a, b) => (b.live + b.shadow) - (a.live + a.shadow)),
    recent_disagreements: recent,
  };
}

export async function readShadowComparison(
  sb: SupabaseClient,
  opts: { days: number; nowMs?: number },
): Promise<{ summary: ShadowComparisonSummary; error: string | null }> {
  const days = Math.min(Math.max(Math.round(opts.days) || 7, 1), SHADOW_MAX_DAYS);
  const since = new Date((opts.nowMs ?? Date.now()) - days * 86_400_000).toISOString();
  const { data, error } = await sb
    .from('orb_wake_timelines')
    .select('session_id, started_at, events')
    .gte('started_at', since)
    .order('started_at', { ascending: false })
    .limit(SHADOW_MAX_ROWS);
  if (error) return { summary: summarizeShadowComparisons([], days), error: error.message };
  return { summary: summarizeShadowComparisons((data || []) as TimelineRow[], days), error: null };
}
