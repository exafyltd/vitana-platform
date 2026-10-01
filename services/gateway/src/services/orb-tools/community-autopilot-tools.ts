/**
 * VTID-04493 (Community Autopilot CA-1): the member's Autopilot queue by voice,
 * on the shared ORB tool registry.
 *
 * Before this, `get_autopilot_recommendations` / `activate_autopilot_recommendations`
 * lived only as inline `case` arms in routes/orb-live.ts, remembering the
 * read-out ids in the WebSocket session object. LiveKit and `/api/v1/orb/tool`
 * could not reach them at all, and the LiveKit `activate_recommendation`
 * wrapper posted to the REST route without `role=community`, which sent a
 * member's "yes" down the Dev Autopilot activation path.
 *
 * Now every surface (popup Go button, all voice transports, the single-offer
 * `activate_recommendation` tool) runs the one canonical activation,
 * `activateCommunityAutopilotRecommendation` (routes/autopilot-recommendations.ts):
 * owner + community + status checks, calendar slot, OASIS event, notification.
 * The "which items did Vitana just read out" memory moved from the session
 * object to `orb_session_state` (key `autopilot_listed_ids`) so it works on
 * any transport and survives a reconnect.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

/** How long "activate those" can refer back to a read-out list. */
export const LISTED_IDS_TTL_MINUTES = 10;
/** Upper bound on how many items one voice call may activate. */
export const MAX_ACTIVATE_PER_CALL = 5;

export interface ListedAutopilotIds {
  ids: string[];
  listed_at: string;
}

export interface VoiceActivationOutcome {
  ok: boolean;
  id: string;
  title: string | null;
  already_active: boolean;
  calendar_event_id: string | null;
  error?: string;
  /** VTID-04503: a medium-risk typed action waits for a read-back confirmation. */
  needs_confirmation?: boolean;
  readback?: string;
  /** VTID-04503: what the typed action did, when the suggestion has one. */
  action_result?: unknown;
  /** VTID-04504: finished in the app, never by voice (a public post). */
  needs_app?: boolean;
}

/**
 * Map the canonical activation's HTTP-shaped failure onto the stable error
 * codes the voice tools have always returned.
 */
export function mapActivationError(httpStatus: number, error: string | undefined): string {
  const msg = error ?? '';
  if (httpStatus === 401) return 'not_signed_in';
  if (httpStatus === 404) return 'recommendation_not_found';
  if (httpStatus === 403 && /not a community/i.test(msg)) return 'not_a_community_recommendation';
  if (httpStatus === 403) return 'recommendation_belongs_to_another_user';
  const status = /in status:\s*([a-z_]+)/i.exec(msg);
  if (httpStatus === 400 && status) return `recommendation_not_activatable:${status[1]}`;
  if (httpStatus === 503) return 'service_unavailable';
  return msg || 'activation_failed';
}

/**
 * The one activation every voice path calls. Replenishment is skipped inline
 * for voice latency; the popup refills on its next open.
 */
export async function activateForVoice(
  userId: string,
  recId: string,
  tenantId: string | null,
  opts: { confirmed?: boolean } = {},
): Promise<VoiceActivationOutcome> {
  const { activateCommunityAutopilotRecommendation } = await import('../../routes/autopilot-recommendations');
  const r = await activateCommunityAutopilotRecommendation(userId, recId, {
    tenantId: tenantId || undefined,
    skipReplenish: true,
    channel: 'voice',
    confirmed: opts.confirmed === true,
  });
  if (!r.ok) {
    return {
      ok: false,
      id: recId,
      title: null,
      already_active: false,
      calendar_event_id: null,
      error: mapActivationError(r.httpStatus, r.error),
    };
  }
  return {
    ok: true,
    id: recId,
    title: r.title ?? null,
    already_active: !!r.already_activated,
    calendar_event_id: r.calendar_event_id ?? null,
    needs_confirmation: r.needs_confirmation === true,
    needs_app: r.needs_app === true,
    readback: r.readback,
    action_result: r.action_result ?? null,
  };
}

// ---------------------------------------------------------------------------
// get_autopilot_recommendations
// ---------------------------------------------------------------------------

export async function tool_get_autopilot_recommendations(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'not_signed_in' };
  try {
    const { listCommunityAutopilotRecommendations, summarizeAutopilotForVoice } = await import(
      '../../routes/autopilot-recommendations'
    );
    const raw = typeof args.limit === 'number' ? args.limit : Number(args.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 10) : 5;
    // autoGenerate: "what's in my Autopilot?" must match opening the popup.
    const recs = await listCommunityAutopilotRecommendations(id.user_id, limit, { autoGenerate: true });
    const summary = summarizeAutopilotForVoice(recs);

    const { writeOrbSessionState } = await import('../orb/orb-session-state');
    const listed: ListedAutopilotIds = { ids: summary.ids, listed_at: new Date().toISOString() };
    await writeOrbSessionState(sb, id.user_id, 'autopilot_listed_ids', listed, LISTED_IDS_TTL_MINUTES);

    return {
      ok: true,
      result: {
        count: summary.count,
        items: recs.map((r, i) => ({ position: i + 1, id: r.id, title: r.title })),
      },
      text: summary.spoken,
    };
  } catch (err) {
    return { ok: false, error: `get_autopilot_recommendations failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// activate_autopilot_recommendations
// ---------------------------------------------------------------------------

function explicitIds(args: OrbToolArgs): string[] {
  if (!Array.isArray(args.ids)) return [];
  return (args.ids as unknown[])
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim());
}

/** 1-based positions ("the second one") resolved against the read-out list. */
function positions(args: OrbToolArgs): number[] {
  if (!Array.isArray(args.positions)) return [];
  return (args.positions as unknown[])
    .map((p) => Number(p))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export async function tool_activate_autopilot_recommendations(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'not_signed_in' };
  try {
    const { readOrbSessionState, clearOrbSessionState } = await import('../orb/orb-session-state');
    const stored = await readOrbSessionState<ListedAutopilotIds>(sb, id.user_id, 'autopilot_listed_ids');
    const listed = Array.isArray(stored?.value?.ids) ? stored!.value.ids : [];

    let targets = explicitIds(args);
    if (targets.length === 0) {
      const pos = positions(args);
      targets = pos.length > 0 ? pos.map((p) => listed[p - 1]).filter((x): x is string => !!x) : listed;
    }
    targets = Array.from(new Set(targets)).slice(0, MAX_ACTIVATE_PER_CALL);

    if (targets.length === 0) {
      return {
        ok: true,
        result: { activated: 0, failed: 0, nothing_listed: true },
        text:
          'Nothing is queued to activate: no Autopilot list was read out in the last few minutes. ' +
          'Call get_autopilot_recommendations first.',
      };
    }

    // Sequential: calendar slotting reads the live calendar, so parallel runs
    // could double-book the same slot.
    const outcomes: VoiceActivationOutcome[] = [];
    for (const recId of targets) {
      try {
        outcomes.push(await activateForVoice(id.user_id, recId, id.tenant_id, { confirmed: args.confirm === true }));
      } catch (err) {
        outcomes.push({
          ok: false,
          id: recId,
          title: null,
          already_active: false,
          calendar_event_id: null,
          error: (err as Error).message,
        });
      }
    }

    // A used list can't be replayed by a stray repeat call — unless something is
    // still waiting for the member's read-back confirmation.
    if (listed.length > 0 && !outcomes.some((o) => o.needs_confirmation)) {
      await clearOrbSessionState(sb, id.user_id, 'autopilot_listed_ids');
    }

    const waiting = outcomes.filter((o) => o.ok && o.needs_confirmation);
    const inApp = outcomes.filter((o) => o.ok && o.needs_app);
    const done = outcomes.filter((o) => o.ok && !o.needs_confirmation && !o.needs_app);
    const failed = outcomes.filter((o) => !o.ok);
    return {
      ok: true,
      result: {
        activated: done.length,
        failed: failed.length,
        awaiting_confirmation: waiting.length,
        finish_in_app: inApp.length,
        items: outcomes.map((o) => ({
          id: o.id,
          ok: o.ok,
          title: o.title,
          already_active: o.already_active,
          calendar_event_id: o.calendar_event_id,
          needs_confirmation: o.needs_confirmation === true,
          needs_app: o.needs_app === true,
          readback: o.readback ?? null,
          action_result: o.action_result ?? null,
          error: o.error ?? null,
        })),
      },
      text: [
        done.length > 0 ? `Activated: ${done.map((d) => `"${d.title ?? d.id}"`).join('; ')}.` : '',
        waiting.length > 0
          ? `Needs the member's confirmation first — read this back and call again with confirm=true if they agree: ${waiting.map((w) => w.readback).join(' ')}`
          : '',
        inApp.length > 0
          ? `Waiting in the app for the member to review and publish (never publish these by voice; tell them in your own words where to find the draft): ${inApp.map((w) => `"${w.title ?? w.id}"`).join('; ')}.`
          : '',
        failed.length > 0 ? `${failed.length} could not be activated (${failed.map((f) => f.error).join(', ')}).` : '',
      ].filter(Boolean).join(' ') || 'Nothing was activated.',
    };
  } catch (err) {
    return { ok: false, error: `activate_autopilot_recommendations failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// confirm_pending_action (VTID-04503)
// ---------------------------------------------------------------------------

/**
 * "Okay, do it." Runs exactly the offer Vitana just made — the one stored in
 * orb_session_state `pending_cta` with its expiry — so the model never has to
 * carry an id across turns. Only offers a spoken yes may commit are run here:
 * `activate_recommendation`, or a tool the orchestrator catalog classifies as a
 * user-own self commit. Anything else is refused with a reason.
 *
 * `confirm: true` is passed through for a medium-risk action the member agreed
 * to after the read-back.
 */
export async function tool_confirm_pending_action(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'not_signed_in' };
  const { readOrbSessionState, clearOrbSessionState } = await import('../orb/orb-session-state');
  const pending = await readOrbSessionState<{ tool?: string; payload?: Record<string, unknown>; offer_id?: string }>(
    sb, id.user_id, 'pending_cta',
  );
  const offer = pending?.value ?? null;
  const tool = typeof offer?.tool === 'string' ? offer.tool : '';
  if (!offer || !tool) {
    return {
      ok: true,
      result: { executed: false, reason: 'no_pending_offer' },
      text: 'There is no open offer to confirm (it may have expired). Ask the member what they would like to do.',
    };
  }
  const wantedOfferId = typeof args.offer_id === 'string' ? args.offer_id.trim() : '';
  if (wantedOfferId && offer.offer_id && wantedOfferId !== offer.offer_id) {
    return { ok: true, result: { executed: false, reason: 'offer_changed' }, text: 'That offer is no longer the open one; nothing was run.' };
  }

  let allowed = tool === 'activate_recommendation';
  if (!allowed) {
    const { classifyOrbTool } = await import('../orchestrator/tool-catalog');
    const cap = classifyOrbTool(tool);
    allowed = cap.tier === 'read' || (cap.tier === 'commit' && cap.self === true);
  }
  if (!allowed) {
    return {
      ok: true,
      result: { executed: false, reason: 'not_voice_confirmable', tool },
      text: `The open offer (${tool}) cannot be run on a spoken yes; point the member to the app to confirm it.`,
    };
  }

  const { dispatchOrbTool } = await import('../orb-tools-shared');
  const payload = { ...(offer.payload ?? {}), ...(args.confirm === true ? { confirm: true } : {}) };
  const r = await dispatchOrbTool(tool, payload, id, sb);
  const waiting = r.ok === true && (r.result as { awaiting_confirmation?: boolean } | undefined)?.awaiting_confirmation === true;
  // Consume the offer only once it actually ran; a read-back keeps it open.
  if (r.ok === true && !waiting) await clearOrbSessionState(sb, id.user_id, 'pending_cta');
  return r;
}

// ---------------------------------------------------------------------------
// start_autopilot_slot (VTID-04506)
// ---------------------------------------------------------------------------

/**
 * The member agreed to start an Autopilot slot that is due now (offered by the
 * autopilot-slot-due wake provider). Completes the slot and the suggestion it
 * came from, and returns the screen to open. Own data only.
 */
export async function tool_start_autopilot_slot(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'not_signed_in' };
  const eventId = typeof args.event_id === 'string' ? args.event_id.trim() : '';
  if (!eventId) return { ok: false, error: 'event_id is required' };
  const { startAutopilotSlot } = await import('../community-autopilot/slot-due');
  const r = await startAutopilotSlot(id.user_id, eventId);
  if (!r.ok) return { ok: false, error: r.error ?? 'slot_start_failed' };
  return {
    ok: true,
    result: r,
    text: r.route
      ? `Started and marked done. If they want to go there now, open ${r.route} with navigate_to_screen.`
      : 'Started and marked done.',
  };
}

export const COMMUNITY_AUTOPILOT_TOOL_HANDLERS: Record<string, Handler> = {
  confirm_pending_action: tool_confirm_pending_action,
  start_autopilot_slot: tool_start_autopilot_slot,
  get_autopilot_recommendations: tool_get_autopilot_recommendations,
  activate_autopilot_recommendations: tool_activate_autopilot_recommendations,
};
