/**
 * VTID-04503 (Community Autopilot CA-3): typed actions a member's Autopilot
 * suggestion can carry, and the one place they are executed.
 *
 * Before this, a community suggestion was a title and a summary. "Do it" could
 * only book a calendar slot and navigate; of 226 slots booked that way none was
 * ever started. A suggestion may now carry `autopilot_recommendations.action`:
 *
 *     { kind, params, risk? }
 *
 * `kind` comes from the closed registry below. Every kind reuses a handler that
 * already exists (the shared ORB tools, the reminders service) — nothing here
 * re-implements business logic. A row with no action stays informational.
 *
 * Policy (owner decision 1, 2026-09-24):
 *   - low-risk, user-own actions run on the member's confirmation: a Go click
 *     in the app or a spoken yes.
 *   - medium-risk actions (they reach another person or are visible to others)
 *     run from the app, and by voice only after Vitana has read the details back
 *     and the member confirmed (`confirmed: true`).
 *   - there is no high-risk kind in the community lane.
 *
 * Every execution is one `agent_runs` row (plane `community_autopilot`) keyed by
 * an idempotency key, so a double click or a repeated "yes" never runs twice.
 */
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type ActionRisk = 'low' | 'medium';
export type ActionChannel = 'app' | 'voice' | 'calendar' | 'system';

export interface RecommendationAction {
  kind: string;
  params?: Record<string, unknown>;
  risk?: ActionRisk;
}

export interface ActionContext {
  userId: string;
  tenantId: string | null;
  recommendationId: string;
  recommendationTitle: string;
  channel: ActionChannel;
  /** Voice only: the member confirmed after Vitana read the details back. */
  confirmed?: boolean;
  /** Calendar slot booked by the activation, when there is one. */
  slotStartIso?: string | null;
  calendarEventId?: string | null;
  lang?: string | null;
  userTz?: string | null;
}

export type ActionOutcome =
  | { status: 'executed'; kind: string; run_id: string | null; result?: unknown; text?: string }
  | { status: 'navigate'; kind: string; route: string; guided_topic_id?: string | null }
  | { status: 'needs_confirmation'; kind: string; readback: string }
  /** VTID-04504: this kind is only ever carried out in the app (public posts). */
  | { status: 'needs_app'; kind: string; readback: string; route: string }
  | { status: 'already_executed'; kind: string; run_id: string | null }
  | { status: 'invalid'; kind: string; error: string }
  | { status: 'failed'; kind: string; run_id: string | null; error: string };

interface ActionSpec {
  risk: ActionRisk;
  /** What the member is agreeing to, in plain English, for a voice read-back. */
  describe: (p: Record<string, unknown>, ctx: ActionContext) => string;
  /** null = valid; otherwise the reason the params are unusable. */
  validate: (p: Record<string, unknown>) => string | null;
  /** 'client' kinds are carried out by the app (navigation); 'server' kinds run here. */
  where: 'server' | 'client';
  /** VTID-04504: never carried out from voice; the member finishes it in the app. */
  appOnly?: boolean;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACTION_REGISTRY: Record<string, ActionSpec> = {
  log_water: {
    risk: 'low', where: 'server',
    validate: (p) => (num(p.amount_ml) && num(p.amount_ml)! > 0 && num(p.amount_ml)! <= 5000 ? null : 'amount_ml must be 1-5000'),
    describe: (p) => `log ${num(p.amount_ml)} ml of water`,
  },
  log_sleep: {
    risk: 'low', where: 'server',
    validate: (p) => (num(p.minutes) && num(p.minutes)! > 0 && num(p.minutes)! <= 1440 ? null : 'minutes must be 1-1440'),
    describe: (p) => `log ${num(p.minutes)} minutes of sleep`,
  },
  log_exercise: {
    risk: 'low', where: 'server',
    validate: (p) => (num(p.minutes) && num(p.minutes)! > 0 && num(p.minutes)! <= 600 ? null : 'minutes must be 1-600'),
    describe: (p) => `log ${num(p.minutes)} minutes of ${str(p.activity_type) || 'exercise'}`,
  },
  log_meditation: {
    risk: 'low', where: 'server',
    validate: (p) => (num(p.minutes) && num(p.minutes)! > 0 && num(p.minutes)! <= 600 ? null : 'minutes must be 1-600'),
    describe: (p) => `log ${num(p.minutes)} minutes of meditation`,
  },
  save_diary_entry: {
    risk: 'low', where: 'server',
    validate: (p) => (str(p.raw_text).length >= 3 ? null : 'raw_text is required'),
    describe: () => 'save today\'s diary entry',
  },
  set_reminder: {
    risk: 'low', where: 'server',
    validate: (p) => {
      const at = str(p.at_iso);
      if (at && Number.isNaN(Date.parse(at))) return 'at_iso is not a date';
      return null;
    },
    describe: (p, ctx) => `set a reminder for "${str(p.action_text) || ctx.recommendationTitle}"`,
  },
  rsvp_event: {
    risk: 'low', where: 'server',
    validate: (p) => (str(p.event_id) ? null : 'event_id is required'),
    describe: (p) => `sign you up for ${str(p.event_title) || 'the event'}`,
  },
  join_group: {
    // Visible to the group's members.
    risk: 'medium', where: 'server',
    validate: (p) => (str(p.group_id) ? null : 'group_id is required'),
    describe: (p) => `join the group ${str(p.group_name) || ''}`.trim(),
  },
  open_screen: {
    risk: 'low', where: 'client',
    validate: (p) => (str(p.route).startsWith('/') ? null : 'route must start with /'),
    describe: (p) => `open ${str(p.route)}`,
  },
  // VTID-04504 (CA-4): drafted kinds. The text lives in params (see drafts.ts).
  post_to_feed: {
    // Public: owner decision 1 — only ever from the app preview, never by voice.
    risk: 'medium', where: 'client', appOnly: true,
    validate: (p) => (str(p.draft).length <= 5000 ? null : 'draft is too long'),
    describe: () => 'open your post draft in the app',
  },
  media_upload: {
    risk: 'low', where: 'client', appOnly: true,
    validate: (p) => (str(p.caption).length <= 2000 ? null : 'caption is too long'),
    describe: () => 'open the Media Hub upload with your caption',
  },
  send_chat_message: {
    // Reaches another person: voice only after the draft was read back.
    risk: 'medium', where: 'server',
    validate: (p) => {
      if (!UUID_RE.test(str(p.recipient_user_id))) return 'recipient_user_id is required';
      if (!str(p.body)) return 'body is required';
      if (str(p.body).length > 2000) return 'body is too long';
      return null;
    },
    describe: (p) => `send ${str(p.recipient_label) || 'your contact'} this message: "${str(p.body)}"`,
  },
  start_guided_session: {
    risk: 'low', where: 'client',
    validate: (p) => (str(p.topic_id) ? null : 'topic_id is required'),
    describe: () => 'start the guided session',
  },
};

export function isKnownActionKind(kind: unknown): kind is string {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ACTION_REGISTRY, kind);
}

/** Parse the stored jsonb; anything malformed is treated as "no action". */
export function parseAction(raw: unknown): RecommendationAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (!isKnownActionKind(a.kind)) return null;
  const params = a.params && typeof a.params === 'object' ? (a.params as Record<string, unknown>) : {};
  return { kind: a.kind, params };
}

/** The registry's risk always wins over a risk written on the row. */
export function riskOf(action: RecommendationAction): ActionRisk {
  return ACTION_REGISTRY[action.kind]?.risk ?? 'medium';
}

/**
 * Pure policy: may this action run now on this channel?
 * Returns null when it may; otherwise the outcome to return instead.
 */
export function checkActionPolicy(action: RecommendationAction, ctx: ActionContext): ActionOutcome | null {
  const spec = ACTION_REGISTRY[action.kind];
  if (!spec) return { status: 'invalid', kind: action.kind, error: 'unknown action kind' };
  const invalid = spec.validate(action.params ?? {});
  if (invalid) return { status: 'invalid', kind: action.kind, error: invalid };
  if (spec.appOnly && ctx.channel === 'voice') {
    return {
      status: 'needs_app',
      kind: action.kind,
      route: clientRouteFor(action),
      readback: `This one is finished in the app: ${spec.describe(action.params ?? {}, ctx)}. It is waiting in the Autopilot.`,
    };
  }
  if (spec.risk === 'medium' && ctx.channel === 'voice' && ctx.confirmed !== true) {
    return {
      status: 'needs_confirmation',
      kind: action.kind,
      readback: `Before I do this, confirm: ${spec.describe(action.params ?? {}, ctx)}.`,
    };
  }
  return null;
}

/** Where the app carries out a client kind. Drafts travel as a query param. */
export function clientRouteFor(action: RecommendationAction): string {
  const p = action.params ?? {};
  if (action.kind === 'post_to_feed') {
    const d = str(p.draft);
    return d ? `/home?compose=1&draft=${encodeURIComponent(d)}` : '/home?compose=1';
  }
  if (action.kind === 'media_upload') {
    const c = str(p.caption);
    return c ? `/comm/media-hub?upload=1&caption=${encodeURIComponent(c)}` : '/comm/media-hub?upload=1';
  }
  if (action.kind === 'start_guided_session') return str(p.route) || '/journey';
  return str(p.route);
}

export function idempotencyKeyFor(recommendationId: string, kind: string): string {
  return `community_autopilot:${recommendationId}:${kind}`;
}

type Runner = (action: RecommendationAction, ctx: ActionContext, sb: SupabaseClient) => Promise<
  { ok: true; result?: unknown; text?: string } | { ok: false; error: string }
>;

/** Server-side executors: each delegates to an existing handler. */
const RUNNERS: Record<string, Runner> = {
  // VTID-04504: a message to another member. Test/service accounts are never a
  // target (CLAUDE.md rules 43-45), whatever produced the suggestion.
  send_chat_message: async (action, ctx, sb) => {
    const recipient = str(action.params?.recipient_user_id);
    if (recipient === ctx.userId) return { ok: false, error: 'cannot message yourself' };
    const { fetchExcludedTestServiceAccountIds } = await import('../../lib/excluded-test-service-accounts');
    const excluded = await fetchExcludedTestServiceAccountIds(sb);
    if (excluded.has(recipient)) return { ok: false, error: 'recipient is not a community member' };
    return runViaOrbTool(action, ctx, sb);
  },
  set_reminder: async (action, ctx, sb) => {
    const p = action.params ?? {};
    const at = str(p.at_iso) || ctx.slotStartIso || null;
    if (!at) return { ok: false, error: 'no time for the reminder' };
    if (!ctx.tenantId) return { ok: false, error: 'no tenant for the reminder' };
    const { createReminder } = await import('../reminders-service');
    const text = str(p.action_text) || ctx.recommendationTitle;
    const row = await createReminder(sb, {
      user_id: ctx.userId,
      tenant_id: ctx.tenantId,
      action_text: text,
      spoken_message: text,
      scheduled_for_iso: at,
      user_tz: ctx.userTz || 'UTC',
      created_via: ctx.channel === 'voice' ? 'voice' : 'ui',
      calendar_event_id: ctx.calendarEventId ?? null,
      lang: ctx.lang ?? undefined,
    });
    return { ok: true, result: { reminder_id: row.id, fire_at: at }, text: `Reminder set: ${text}` };
  },
};

/** Kinds that map 1:1 onto a shared ORB tool with the same params. */
const ORB_TOOL_KINDS = new Set([
  'log_water', 'log_sleep', 'log_exercise', 'log_meditation', 'save_diary_entry', 'rsvp_event', 'join_group',
]);

async function runViaOrbTool(action: RecommendationAction, ctx: ActionContext, sb: SupabaseClient) {
  const { dispatchOrbTool } = await import('../orb-tools-shared');
  const r = await dispatchOrbTool(
    action.kind,
    { ...(action.params ?? {}) },
    { user_id: ctx.userId, tenant_id: ctx.tenantId, role: 'community', vitana_id: null },
    sb,
  );
  if (r.ok === false) return { ok: false as const, error: r.error };
  return { ok: true as const, result: r.result, text: typeof r.text === 'string' ? r.text : undefined };
}

async function claimRun(sb: SupabaseClient, action: RecommendationAction, ctx: ActionContext): Promise<
  { claimed: true; runId: string } | { claimed: false; runId: string | null }
> {
  const runId = randomUUID();
  const key = idempotencyKeyFor(ctx.recommendationId, action.kind);
  const { error } = await sb.from('agent_runs').insert({
    id: runId,
    agent_id: 'community-autopilot',
    plane: 'community_autopilot',
    principal: { platform_role: 'community', channel: ctx.channel },
    user_id: ctx.userId,
    tenant_id: ctx.tenantId,
    intent: `${action.kind}: ${ctx.recommendationTitle}`.slice(0, 500),
    status: 'running',
    tier: 'commit',
    idempotency_key: key,
    created_via: ctx.channel === 'voice' ? 'voice' : ctx.channel === 'calendar' ? 'scheduler' : ctx.channel === 'system' ? 'system' : 'web',
    deliver_to: { role: 'community', user_id: ctx.userId },
    metadata: { recommendation_id: ctx.recommendationId, action_kind: action.kind, source: 'community_autopilot' },
  });
  if (!error) return { claimed: true, runId };
  // Unique idempotency key: this action already ran (or is running) for this suggestion.
  if (/duplicate|unique|23505/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
    const { data } = await sb.from('agent_runs').select('id,status').eq('idempotency_key', key).limit(1);
    const prior = (data as Array<{ id: string; status: string }> | null)?.[0] ?? null;
    // A failed attempt may be retried: reclaim it (only if it is still failed).
    if (prior && prior.status === 'failed') {
      const { data: reclaimed } = await sb.from('agent_runs')
        .update({ status: 'running', error: null, updated_at: new Date().toISOString() })
        .eq('id', prior.id).eq('status', 'failed').select('id');
      if ((reclaimed as unknown[] | null)?.length) return { claimed: true, runId: prior.id };
    }
    return { claimed: false, runId: prior?.id ?? null };
  }
  // The ledger is bookkeeping: an unavailable ledger must not block the member.
  console.warn(`[community-autopilot] agent_runs insert failed (${error.message}); running without a run record`);
  return { claimed: true, runId: '' };
}

async function finishRun(sb: SupabaseClient, runId: string, patch: Record<string, unknown>): Promise<void> {
  if (!runId) return;
  const { error } = await sb.from('agent_runs')
    .update({ ...patch, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', runId);
  if (error) console.warn(`[community-autopilot] agent_runs finish failed for ${runId}: ${error.message}`);
}

/**
 * Execute a suggestion's action once. Policy first (never writes when it says
 * no), then an idempotent run claim, then the existing handler.
 */
export async function executeRecommendationAction(
  sb: SupabaseClient,
  action: RecommendationAction,
  ctx: ActionContext,
): Promise<ActionOutcome> {
  const blocked = checkActionPolicy(action, ctx);
  if (blocked) return blocked;

  const spec = ACTION_REGISTRY[action.kind];
  if (spec.where === 'client') {
    const p = action.params ?? {};
    if (action.kind === 'start_guided_session') {
      return { status: 'navigate', kind: action.kind, route: str(p.route) || '/journey', guided_topic_id: str(p.topic_id) };
    }
    return { status: 'navigate', kind: action.kind, route: clientRouteFor(action) };
  }

  const claim = await claimRun(sb, action, ctx);
  if (!claim.claimed) return { status: 'already_executed', kind: action.kind, run_id: claim.runId };

  try {
    const runner = RUNNERS[action.kind] ?? (ORB_TOOL_KINDS.has(action.kind) ? runViaOrbTool : null);
    if (!runner) throw new Error(`no executor for ${action.kind}`);
    const out = await runner(action, ctx, sb);
    if (!out.ok) {
      await finishRun(sb, claim.runId, { status: 'failed', error: out.error.slice(0, 1000) });
      return { status: 'failed', kind: action.kind, run_id: claim.runId || null, error: out.error };
    }
    await finishRun(sb, claim.runId, { status: 'succeeded', result_ref: { result: out.result ?? null } });
    return { status: 'executed', kind: action.kind, run_id: claim.runId || null, result: out.result, text: out.text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishRun(sb, claim.runId, { status: 'failed', error: msg.slice(0, 1000) });
    return { status: 'failed', kind: action.kind, run_id: claim.runId || null, error: msg };
  }
}

/**
 * The action an older template row gets when it has no typed action of its own:
 * a template that books a calendar slot also gets a reminder at that slot, so
 * the slot actually prompts the member instead of sitting unused (226 slots
 * booked before this, none ever started). Member-initiated (they pressed Go or
 * said yes), so it is not an automation notification.
 */
export function defaultActionForTemplate(hasCalendarSlot: boolean): RecommendationAction | null {
  return hasCalendarSlot ? { kind: 'set_reminder', params: {} } : null;
}
