/**
 * VTID-04525 (Conversation hub B3) — tool, guard and opening aggregates over
 * a bounded window of OASIS events, for the Overview and Tools tabs.
 *
 * Sources (all already emitted by the live session; nothing new is written):
 *   - `orb.live.tool.executed`             one row per tool execution
 *                                          (tool_name, success, elapsed_ms, env)
 *   - `orb.live.diag` stage `greeting_sent` the opening: wake_opener, the
 *                                          winning provider, whether it was spoken
 *   - `orb.live.diag` guard stages         loop guard, opening-turn refusal, reply
 *                                          cap, backend-data mute, tool-catalog trim,
 *                                          instruction budget (VTID-04525 B2)
 *
 * Both stacks write to the same `oasis_events`. Tool rows carry `env`, so tool
 * counts are split by it; diag rows do not carry a reliable env (it is
 * hardcoded on the emitter), so guard and opening counts are for both stacks
 * together and the response says so.
 *
 * Pure summarizers here; the reads live in the hub repository.
 */

export const AGGREGATE_MAX_HOURS = 24 * 14;
/** Rows read per source before the window is reported as truncated. */
export const AGGREGATE_MAX_ROWS = 20_000;

export const GUARD_STAGES = [
  'tool_loop_guard',
  'opening_action_refused',
  'loop_guard_reply_capped',
  'backend_data_speech_suppressed',
  'tool_catalog_trimmed',
  'instruction_budget',
] as const;
export type GuardStage = (typeof GUARD_STAGES)[number];

export interface AggregateRow {
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export interface ToolAggregate {
  tool: string;
  calls: number;
  failures: number;
  failure_rate: number;
  p50_ms: number | null;
  p90_ms: number | null;
  last_at: string | null;
  by_env: Record<string, number>;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function summarizeToolExecutions(rows: AggregateRow[]): { total_calls: number; total_failures: number; tools: ToolAggregate[] } {
  const acc = new Map<string, { calls: number; failures: number; ms: number[]; last: string | null; env: Record<string, number> }>();
  for (const r of rows) {
    const m = r.metadata || {};
    const tool = str(m.tool_name) ?? str(m.tool) ?? 'unknown';
    const a = acc.get(tool) ?? { calls: 0, failures: 0, ms: [], last: null, env: {} };
    a.calls += 1;
    if (m.success === false) a.failures += 1;
    const ms = num(m.elapsed_ms);
    if (ms != null) a.ms.push(ms);
    if (!a.last || r.created_at > a.last) a.last = r.created_at;
    const env = str(m.env) ?? 'unknown';
    a.env[env] = (a.env[env] ?? 0) + 1;
    acc.set(tool, a);
  }
  const tools: ToolAggregate[] = [...acc.entries()].map(([tool, a]) => {
    const sorted = [...a.ms].sort((x, y) => x - y);
    return {
      tool,
      calls: a.calls,
      failures: a.failures,
      failure_rate: a.calls ? Math.round((a.failures / a.calls) * 1000) / 1000 : 0,
      p50_ms: percentile(sorted, 50),
      p90_ms: percentile(sorted, 90),
      last_at: a.last,
      by_env: a.env,
    };
  });
  tools.sort((x, y) => y.calls - x.calls || x.tool.localeCompare(y.tool));
  return {
    total_calls: tools.reduce((s, t) => s + t.calls, 0),
    total_failures: tools.reduce((s, t) => s + t.failures, 0),
    tools,
  };
}

export interface GuardAggregate {
  counts: Record<GuardStage, number>;
  /** Loop-guard fires split by whether nothing had been said yet (VTID-04480). */
  loop_guard_opening: number;
  /** Tools the loop guard fired on, most frequent first. */
  loop_guard_tools: Array<{ tool: string; count: number }>;
  /** Backend-data mutes by detected kind. */
  backend_data_kinds: Record<string, number>;
  instruction_budget: {
    setups: number;
    trimmed: number;
    trimmed_rate: number | null;
    still_over_budget: number;
    trimmed_sections: Record<string, number>;
    bytes_before_p50: number | null;
    bytes_before_p90: number | null;
  };
  tool_catalog: { trims: number; by_provider: Record<string, number>; dropped_p50: number | null };
}

export function summarizeGuards(rows: AggregateRow[]): GuardAggregate {
  const counts = Object.fromEntries(GUARD_STAGES.map((s) => [s, 0])) as Record<GuardStage, number>;
  let loopOpening = 0;
  const loopTools = new Map<string, number>();
  const backendKinds: Record<string, number> = {};
  const trimmedSections: Record<string, number> = {};
  const budgetBytes: number[] = [];
  let budgetTrimmed = 0;
  let stillOver = 0;
  const catalogByProvider: Record<string, number> = {};
  const catalogDropped: number[] = [];

  for (const r of rows) {
    const m = r.metadata || {};
    const stage = str(m.stage) as GuardStage | null;
    if (!stage || !(stage in counts)) continue;
    counts[stage] += 1;
    switch (stage) {
      case 'tool_loop_guard': {
        // Emitted with { consecutive, dropped_tools, limit?, opening_turn? }.
        if (m.opening_turn === true) loopOpening += 1;
        const tools = Array.isArray(m.dropped_tools) ? (m.dropped_tools as unknown[]).map(String) : [];
        for (const t of tools) loopTools.set(t, (loopTools.get(t) ?? 0) + 1);
        break;
      }
      case 'backend_data_speech_suppressed': {
        const kind = str(m.kind) ?? 'unknown';
        backendKinds[kind] = (backendKinds[kind] ?? 0) + 1;
        break;
      }
      case 'instruction_budget': {
        const before = num(m.total_bytes_before);
        if (before != null) budgetBytes.push(before);
        if (m.trimmed === true) budgetTrimmed += 1;
        if (m.still_over_budget === true) stillOver += 1;
        if (Array.isArray(m.trimmed_sections)) {
          for (const s of m.trimmed_sections as unknown[]) trimmedSections[String(s)] = (trimmedSections[String(s)] ?? 0) + 1;
        }
        break;
      }
      case 'tool_catalog_trimmed': {
        const p = str(m.provider) ?? 'unknown';
        catalogByProvider[p] = (catalogByProvider[p] ?? 0) + 1;
        const d = num(m.dropped_count);
        if (d != null) catalogDropped.push(d);
        break;
      }
      default:
        break;
    }
  }

  const sortedBytes = [...budgetBytes].sort((a, b) => a - b);
  const sortedDropped = [...catalogDropped].sort((a, b) => a - b);
  const setups = counts.instruction_budget;
  return {
    counts,
    loop_guard_opening: loopOpening,
    loop_guard_tools: [...loopTools.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
    backend_data_kinds: backendKinds,
    instruction_budget: {
      setups,
      trimmed: budgetTrimmed,
      trimmed_rate: setups ? Math.round((budgetTrimmed / setups) * 1000) / 1000 : null,
      still_over_budget: stillOver,
      trimmed_sections: trimmedSections,
      bytes_before_p50: percentile(sortedBytes, 50),
      bytes_before_p90: percentile(sortedBytes, 90),
    },
    tool_catalog: { trims: counts.tool_catalog_trimmed, by_provider: catalogByProvider, dropped_p50: percentile(sortedDropped, 50) },
  };
}

export interface OpeningAggregate {
  greetings: number;
  by_wake_opener: Record<string, number>;
  by_winner: Array<{ provider: string; wins: number; spoken: number }>;
  outranked: number;
}

export function summarizeOpenings(rows: AggregateRow[]): OpeningAggregate {
  const byOpener: Record<string, number> = {};
  const winners = new Map<string, { wins: number; spoken: number }>();
  let outranked = 0;
  let greetings = 0;
  for (const r of rows) {
    const m = r.metadata || {};
    if (str(m.stage) !== 'greeting_sent') continue;
    greetings += 1;
    const opener = str(m.wake_opener) ?? 'none';
    byOpener[opener] = (byOpener[opener] ?? 0) + 1;
    const p = str(m.candidate_provider);
    if (p) {
      const w = winners.get(p) ?? { wins: 0, spoken: 0 };
      w.wins += 1;
      if (m.candidate_spoken === true) w.spoken += 1;
      winners.set(p, w);
    }
    if (str(m.candidate_outranked_by)) outranked += 1;
  }
  return {
    greetings,
    by_wake_opener: byOpener,
    by_winner: [...winners.entries()].map(([provider, w]) => ({ provider, ...w })).sort((a, b) => b.wins - a.wins || a.provider.localeCompare(b.provider)),
    outranked,
  };
}
