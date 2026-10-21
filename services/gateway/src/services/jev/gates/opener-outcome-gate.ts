/**
 * VTID-04817: Jev P3 gate C4 — voice opener / next-step outcome learning.
 * (docs/JEV-INTEGRATION-PLAN.md §10.4 C4)
 *
 *   voice_opener_outcomes   (JEV_VOICE_OPENER_OUTCOMES_MODE = off | shadow | enforce)
 *
 * Every voice session starts with an opener (`greeting_sent`: wake_opener —
 * conv_resume, resume_thread, newday_overview, … — and the next-step
 * candidate it offers — wake_brief, feature_discovery, next_step, …). Nobody
 * compares them. In the 14 days to 2026-10-01 production ran conv_resume +
 * wake_brief 436 times with 9% of sessions engaged (≥ 2 member turns), while
 * resume_thread + wake_brief engaged 63% and conv_resume + next_step 21%.
 *
 * Once per UTC day (an hourly tick, like C2/C3) the last 7 days of this
 * environment's openers are joined to their sessions' finalized counts
 * (`conversation.session.finalized`: user turns, duration) and grouped by
 * opener + candidate kind. Each group with at least MIN_SESSIONS sessions
 * goes to Jev `opener_effectiveness` (working? keep / reword / reposition /
 * drop) — counts only (`pii: 'forbid'`). A rule calls a group under-performing
 * when its engaged share is below 70% of the overall share; agreement is
 * written at once. One row per group per day. Changing the openers is a
 * product decision after the data; there is no enforce behaviour.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { VITANA_ENV } from '../../../env';
import { decide, DecideOptions } from '../jev-decision-service';
import * as repo from '../jev-repository';
import { jevGateMode, recordJevShadowDecision } from '../jev-shadow';

export const OPENER_GATE = 'voice_opener_outcomes';
export const WINDOW_DAYS = 7;
export const MIN_SESSIONS = 10;
export const MAX_GROUPS_PER_DAY = 12;
/** Under-performing: engaged share below this fraction of the overall share. */
export const UNDER_RATIO = 0.7;
const SYSTEM_CALLER = { actor_id: 'orb-voice-telemetry', system: true } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;

type Meta = Record<string, unknown>;
const str = (v: unknown, max = 80): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

export interface OpenerGroup {
  wake_opener: string;
  candidate_kind: string;
  sessions: number;
  finalized: number;
  engaged: number;
  engaged_pct: number;
  avg_user_turns: number;
  avg_duration_s: number;
}

/** Join openers to finalized sessions and group them. Engaged = ≥ 2 member turns. Pure. */
export function groupOpeners(greetings: Array<{ metadata?: Meta | null }>, finals: Array<{ metadata?: Meta | null }>, env: string): { groups: OpenerGroup[]; overall_engaged_pct: number } {
  const fin = new Map<string, { turns: number; duration: number }>();
  for (const f of finals) {
    const m = f.metadata || {};
    const sid = str(m.session_id, 160);
    const turns = num(m.user_turns);
    if (sid && turns !== null) fin.set(sid, { turns, duration: num(m.duration_ms) ?? 0 });
  }
  const seen = new Set<string>();
  const map = new Map<string, { wake_opener: string; candidate_kind: string; sessions: number; finalized: number; engaged: number; turns: number; duration: number }>();
  let allFinal = 0;
  let allEngaged = 0;
  for (const g of greetings) {
    const m = g.metadata || {};
    if (m.env && m.env !== env) continue;
    const sid = str(m.session_id, 160);
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    const wake_opener = str(m.wake_opener) ?? 'none';
    const candidate_kind = str(m.candidate_kind) ?? 'none';
    const key = `${wake_opener}|${candidate_kind}`;
    const c = map.get(key) ?? { wake_opener, candidate_kind, sessions: 0, finalized: 0, engaged: 0, turns: 0, duration: 0 };
    c.sessions++;
    const f = fin.get(sid);
    if (f) {
      c.finalized++;
      c.turns += f.turns;
      c.duration += f.duration;
      allFinal++;
      if (f.turns >= 2) { c.engaged++; allEngaged++; }
    }
    map.set(key, c);
  }
  const round1 = (x: number) => Math.round(x * 10) / 10;
  const groups = [...map.values()]
    .map((c) => ({
      wake_opener: c.wake_opener,
      candidate_kind: c.candidate_kind,
      sessions: c.sessions,
      finalized: c.finalized,
      engaged: c.engaged,
      engaged_pct: c.finalized ? round1((100 * c.engaged) / c.finalized) : 0,
      avg_user_turns: c.finalized ? round1(c.turns / c.finalized) : 0,
      avg_duration_s: c.finalized ? round1(c.duration / c.finalized / 1000) : 0,
    }))
    .sort((a, b) => b.sessions - a.sessions);
  return { groups, overall_engaged_pct: allFinal ? round1((100 * allEngaged) / allFinal) : 0 };
}

/** The rule: under-performing when the engaged share is below 70% of overall. Null when there is too little to tell. */
export function ruleUnderperforming(g: OpenerGroup, overallPct: number): boolean | null {
  if (g.finalized < MIN_SESSIONS || overallPct <= 0) return null;
  return g.engaged_pct < UNDER_RATIO * overallPct;
}

export function openerKey(env: string, day: string, g: Pick<OpenerGroup, 'wake_opener' | 'candidate_kind'>): string {
  return `${env}:${day}:${g.wake_opener}:${g.candidate_kind}`;
}

export function isOpenerOutcomesOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(OPENER_GATE, env) !== 'off';
}

/**
 * Judge the 7 days ending at the end of `day` (UTC, YYYY-MM-DD). Never
 * throws. Returns the number of rows written.
 */
export async function runOpenerOutcomesDay(
  day: string,
  opts: { env?: NodeJS.ProcessEnv; vitanaEnv?: string; sb?: SupabaseClient | null; decideOptions?: Omit<DecideOptions, 'source' | 'env'> } = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const mode = jevGateMode(OPENER_GATE, env);
  if (mode === 'off') return 0;
  const sb = opts.sb === undefined ? getSupabase() : opts.sb;
  if (!sb) return 0;
  const vitanaEnv = opts.vitanaEnv ?? VITANA_ENV;
  try {
    const until = new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString();
    const since = new Date(Date.parse(until) - WINDOW_DAYS * DAY_MS).toISOString();
    const [g, f] = await Promise.all([
      repo.fetchVoiceDiagEvents(sb, ['greeting_sent'], since, until, 20000),
      repo.fetchFinalizedSessions(sb, since, new Date(Date.parse(until) + 2 * 60 * 60 * 1000).toISOString()),
    ]);
    if (g.error || !g.data || f.error || !f.data) return 0;
    const { groups, overall_engaged_pct } = groupOpeners(g.data as Array<{ metadata?: Meta }>, f.data as Array<{ metadata?: Meta }>, vitanaEnv);
    let written = 0;
    for (const grp of groups.filter((x) => x.sessions >= MIN_SESSIONS).slice(0, MAX_GROUPS_PER_DAY)) {
      const key = openerKey(vitanaEnv, day, grp);
      const seen = await repo.fetchRecentShadowBySubject(sb, OPENER_GATE, key, new Date(Date.parse(until) - DAY_MS).toISOString());
      if (!seen.error && seen.data) continue;
      const rule = ruleUnderperforming(grp, overall_engaged_pct);
      const r = await decide(
        'opener_effectiveness',
        {
          wake_opener: grp.wake_opener, candidate_kind: grp.candidate_kind, sessions: grp.sessions, finalized: grp.finalized,
          engaged_pct: grp.engaged_pct, avg_user_turns: grp.avg_user_turns, avg_duration_s: grp.avg_duration_s,
          overall_engaged_pct, window_days: WINDOW_DAYS,
        },
        SYSTEM_CALLER,
        { ...(opts.decideOptions || {}), source: `gate:${OPENER_GATE}`, env },
      );
      const working = r.ok && r.outcome === 'decided' ? r.verdict.value === true : null;
      const agreed = working === null || rule === null ? null : working === !rule;
      const id = await recordJevShadowDecision(
        {
          gate: OPENER_GATE,
          decision: 'opener_effectiveness',
          mode,
          plane: 'internal',
          tenant_id: null,
          subject_type: 'voice_opener',
          subject_ref: key,
          jev_outcome: r.outcome,
          jev_verdict: r.ok
            ? { working, probability: r.answers.working?.probability ?? null, next_step: r.answers.next_step?.value ?? null, rule_underperforming: rule, overall_engaged_pct, ...grp, day }
            : { reason: r.reason, rule_underperforming: rule, overall_engaged_pct, ...grp, day },
          jev_confidence: r.ok ? r.verdict.confidence : null,
          system_action: 'opener_unchanged',
          cost_usd: r.ok ? r.cost_usd : 0,
          agreed,
          outcome: agreed === null ? null : 'compared_with_engagement_rule',
          outcome_at: agreed === null ? null : new Date().toISOString(),
        },
        sb,
      );
      if (id) written++;
    }
    return written;
  } catch (err: any) {
    console.warn(`[jev] ${OPENER_GATE} day ${day} failed: ${err?.message || err}`);
    return 0;
  }
}

let timerId: ReturnType<typeof setInterval> | null = null;
let lastDay: string | null = null;

/** Hourly tick, judges the 7 days to yesterday (UTC) once a day. Off unless the gate's mode is set. */
export function startOpenerOutcomesScheduler(env: NodeJS.ProcessEnv = process.env): boolean {
  if (timerId || !isOpenerOutcomesOn(env)) return false;
  const tick = async () => {
    const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
    if (lastDay === yesterday) return;
    await runOpenerOutcomesDay(yesterday);
    lastDay = yesterday;
  };
  timerId = setInterval(() => { void tick(); }, TICK_MS);
  timerId.unref?.();
  void tick();
  return true;
}

export function stopOpenerOutcomesSchedulerForTest(): void {
  if (timerId) clearInterval(timerId);
  timerId = null;
  lastDay = null;
}
