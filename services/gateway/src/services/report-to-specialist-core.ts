/**
 * VTID-03024 — shared core of the `report_to_specialist` voice tool.
 *
 * Vertex's orb-live.ts case arm and the LiveKit shared dispatcher
 * (orb-tools-shared.ts:tool_report_to_specialist) both need IDENTICAL
 * behaviour for the ticket-creation half of bug-reporting:
 *
 *   - vague-summary block (the LLM tried to file with a 6-word placeholder)
 *   - two-gate routing via pick_specialist_for_text[_tenant] RPC
 *   - kind → persona fallback via persona registry
 *   - INSERT into `feedback_tickets`
 *   - INSERT into `feedback_handoff_events` (so the Live Handoffs panel sees it)
 *   - OASIS `feedback.ticket.created` event
 *
 * What stays out of this module (Vertex-only, WebSocket-state-coupled):
 *   - swapCount + swapCooldownUntil loop guards
 *   - persona swap onto the live session (pendingPersonaSwap,
 *     personaSystemOverride, personaVoiceOverride, SSE/WS persona_swap
 *     message to the frontend)
 *   - transcript-based gate input construction
 *   - persona-first-utterance flag reset
 *
 * The audible persona/voice swap on LiveKit (Devon answers in Devon's
 * voice) is a separate concern — handled by `perform_handoff` in the
 * orb-agent's session.py and gated behind the next VTID. This file is
 * the DATA layer only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  pickPersonaForKind as registryPickPersonaForKind,
  pickPersonaForKindForTenant as registryPickPersonaForKindForTenant,
} from './persona-registry';
import { emitOasisEvent } from './oasis-event-service';
import * as repo from './report-to-specialist-core-repository';

export interface ReportToSpecialistArgs {
  kind?: string;
  summary?: string;
  specialist_hint?: string;
}

export interface ReportToSpecialistIdentity {
  user_id: string;
  tenant_id: string | null;
  vitana_id?: string | null;
  lang?: string | null;
}

export interface ReportToSpecialistOptions {
  /**
   * Text fed to the `pick_specialist_for_text[_tenant]` two-gate RPC.
   * Vertex passes a transcript-enhanced string (raw user words) so the
   * gate can see phrases like "how does X work" that the LLM compresses
   * out of `summary`. LiveKit has no equivalent transcript yet, so it
   * defaults to `summary`.
   */
  gate_input?: string;
  /**
   * Source identifier surfaced in OASIS event metadata + Live Handoffs
   * panel. Use 'orb-voice-tool' (Vertex), 'orb-livekit-tool' (LiveKit),
   * or 'text-chat' if a future caller wires it up.
   */
  source?: string;
  /**
   * Screen the user was on when they hit "report a bug". '/orb/voice'
   * for Vertex, '/orb/livekit-voice' for LiveKit.
   */
  screen_path?: string;
  /**
   * VTID-04332: feedback_tickets.surface for this ticket. Voice callers
   * derive it from the session's route via {@link feedbackSurfaceForOrb};
   * when omitted the ticket is pinned to 'community' — never left null,
   * because a null surface lets the classifier guess from `screen_path`,
   * which for voice is always the synthetic '/orb/voice'.
   */
  surface?: FeedbackTicketSurface;
  /**
   * VTID-04332: live session id, stored in structured_fields.session_id so
   * the ticket can be correlated with the session's OASIS events.
   */
  session_id?: string | null;
  /** VTID-04332: the screen the member was on (session.current_route). */
  current_route?: string | null;
}

/**
 * VTID-04332 — values accepted by the feedback_tickets_surface_check
 * constraint (migration 20260604123000_support_surface_human_only_queue.sql).
 */
export type FeedbackTicketSurface =
  | 'community'
  | 'admin'
  | 'command-hub'
  | 'mobile-only'
  | 'marketplace'
  | 'infrastructure'
  | 'support';

/**
 * VTID-04332 — map the ORB surface (orb/live/surface.ts) to the
 * feedback_tickets.surface enum. The ticket table has no 'backoffice'
 * value, so the BackOffice surface files under 'admin' (both are
 * operator-facing work surfaces). Anything unknown is the community app.
 */
export function feedbackSurfaceForOrb(orbSurface: string | null | undefined): FeedbackTicketSurface {
  switch (orbSurface) {
    case 'command-hub':
      return 'command-hub';
    case 'admin':
    case 'backoffice':
      return 'admin';
    default:
      return 'community';
  }
}

/**
 * VTID-04332 — the minimum number of words a summary needs before a ticket
 * is filed. Was 12, which rejected ordinary spoken reports ("the diary save
 * button does nothing") and pushed the model toward never calling the tool.
 * Five words is enough to say what broke and where; the VAGUE_PATTERNS below
 * still reject the placeholder summaries the old limit was aimed at.
 */
export const REPORT_TO_SPECIALIST_MIN_SUMMARY_WORDS = 5;

/**
 * VTID-04332 — the STATUS contract of the report_to_specialist tool reply.
 *
 * live-system-instruction.ts carries the VTID-03033 HARD RULE: the model may
 * only announce a hand-off when the tool reply begins with
 * "STATUS: handoff_created." and must treat every other STATUS as "the
 * hand-off did NOT happen". Until VTID-04332 no gateway handler returned any
 * STATUS text at all, so after a successful call the model was told the
 * hand-off had not happened. Every report_to_specialist reply is now built
 * through {@link buildReportToSpecialistToolMessage}, and
 * test/vtid-04332-report-to-specialist-status-contract.test.ts pins this list
 * against the rule's own STATUS list so the two cannot drift apart again.
 */
export const REPORT_TO_SPECIALIST_STATUSES = [
  'handoff_created',
  'stay_inline',
  'vague',
  'failed',
  'failed_network',
  'ticket_filed_no_handoff',
] as const;

export type ReportToSpecialistStatus = (typeof REPORT_TO_SPECIALIST_STATUSES)[number];

/** `STATUS: <status>. ACTION: <intent>` — the one shape every reply takes. */
export function buildReportToSpecialistToolMessage(
  status: ReportToSpecialistStatus,
  action: string,
): string {
  return `STATUS: ${status}. ACTION: ${action}`;
}

/**
 * ACTION intents for each branch. These are INTENT for the model, written in
 * English (CLAUDE.md NEVER-rule 41) — never a finished sentence to recite.
 */
export const REPORT_TO_SPECIALIST_ACTIONS = {
  handoff_created: (roleLabel: string, ticketNumber: string | null) =>
    `The ticket ${ticketNumber ?? '(number pending)'} is filed and the hand-off to ${roleLabel} is queued. ` +
    `In the user's language and in your own words, briefly tell them you are bringing in ${roleLabel}. ` +
    `Refer to the colleague by that role only, never by an internal persona name. ` +
    `Do not introduce the colleague or speak for them — they greet the user in their own voice. ` +
    `After that one short turn, stop talking.`,
  ticket_filed_no_handoff: (ticketNumber: string | null) =>
    `The report is filed as ticket ${ticketNumber ?? '(number pending)'}, but no colleague is joining this call. ` +
    `Stay with the user yourself. In their language and your own words, tell them the report is filed, ` +
    `give them the ticket number so they can refer to it, and that the team will follow up. ` +
    `Do not say or imply that you are connecting them to anyone.`,
  vague: (summary: string) =>
    `Nothing was filed — the summary "${summary}" does not yet say what went wrong. ` +
    `Ask the user one short follow-up question in their language about what exactly is broken ` +
    `(which screen or feature, what they did, what happened). ` +
    `When they answer, call the same tool again with their description. ` +
    `Do not mention this internal check.`,
  stay_inline: (reason: string) =>
    `Nothing was filed and no colleague is joining (${reason}). ` +
    `Stay with the user and help them yourself as Vitana. Do not mention the routing decision.`,
  failed: () =>
    `The report could not be filed. No ticket exists and no colleague is joining. ` +
    `Stay with the user; in their language and your own words, tell them honestly it did not go through ` +
    `and offer to try once more. Do not say it was filed or that anyone is joining.`,
  failed_network: () =>
    `The report could not be filed because a connection to the ticket system failed. No ticket exists and ` +
    `no colleague is joining. Stay with the user; in their language and your own words, tell them honestly ` +
    `it did not go through and offer to try once more. Do not say it was filed or that anyone is joining.`,
} as const;

export type ReportToSpecialistResult =
  | {
      decision: 'vague';
      llm_instruction: string;
      word_count: number;
    }
  | {
      decision: 'stay_inline';
      llm_instruction: string;
      rpc_gate: string | null;
    }
  | {
      decision: 'created';
      ticket: {
        id: string;
        ticket_number: string | null;
      };
      persona: string | null; // 'devon' | 'sage' | 'atlas' | 'mira' | null when unrouted
      matched_keyword: string | null;
      confidence: number | null;
      rpc_decision: string | null;
      rpc_gate: string | null;
    }
  | {
      decision: 'failed';
      error: string;
    };

const VAGUE_PATTERNS: RegExp[] = [
  /^user (wants|would like|wishes) to report (a|an|the)?\s*(technical |bug|issue|problem|claim|complaint|account|support)?\s*(report|issue|problem|claim|bug|complaint|question|something)\.?$/i,
  /^user has (a|an|the)?\s*(bug|issue|problem|claim|complaint|account|support|technical)\s*(report|issue|problem|claim|bug|complaint|question|matter)\.?$/i,
  /^report a (bug|issue|problem|claim|complaint|technical)\s*\.?$/i,
  /^bug report\.?$/i,
  /^something is broken\.?$/i,
  /^(user|customer)\s+(needs help|wants help|has a question)\.?$/i,
];

const VAGUE_INSTRUCTION = (summary: string) =>
  buildReportToSpecialistToolMessage('vague', REPORT_TO_SPECIALIST_ACTIONS.vague(summary));

function buildStayInlineInstruction(rpcGate: string | null): string {
  const gateLabel = rpcGate === 'stay_inline'
    ? 'stay-inline override'
    : rpcGate === 'unrouted'
      ? 'no enabled specialist'
      : 'no explicit forward request';
  return buildReportToSpecialistToolMessage(
    'stay_inline',
    REPORT_TO_SPECIALIST_ACTIONS.stay_inline(`this is not a customer-support hand-off: ${gateLabel}`),
  );
}

export async function executeReportToSpecialist(
  args: ReportToSpecialistArgs,
  identity: ReportToSpecialistIdentity,
  sb: SupabaseClient,
  options: ReportToSpecialistOptions = {},
): Promise<ReportToSpecialistResult> {
  const kind = String(args.kind ?? 'feedback').trim() || 'feedback';
  const summary = String(args.summary ?? '').trim();
  const specialistHint = String(args.specialist_hint ?? '').trim();

  if (!summary) {
    return { decision: 'failed', error: 'summary is required' };
  }

  const wordCount = summary.split(/\s+/).filter(Boolean).length;
  const isVague =
    wordCount < REPORT_TO_SPECIALIST_MIN_SUMMARY_WORDS || VAGUE_PATTERNS.some((re) => re.test(summary));
  if (isVague) {
    return {
      decision: 'vague',
      llm_instruction: VAGUE_INSTRUCTION(summary),
      word_count: wordCount,
    };
  }

  // Two-gate routing. Tenant-aware variant when we have tenant context.
  const gateInput = options.gate_input ?? summary;
  let pickedPersona = specialistHint;
  let matchedKeyword: string | null = null;
  let confidence: number | null = null;
  let rpcDecision: string | null = null;
  let rpcGate: string | null = null;
  const tenantId = identity.tenant_id;

  if (!pickedPersona) {
    try {
      const rpcName = tenantId
        ? 'pick_specialist_for_text_tenant'
        : 'pick_specialist_for_text';
      const rpcArgs: Record<string, unknown> = { p_text: gateInput };
      if (tenantId) rpcArgs.p_tenant_id = tenantId;
      const { data: rpcData, error: rpcError } = await repo.pickSpecialistForText(sb, rpcName, rpcArgs);
      if (rpcError) {
        // Gate failure isn't fatal — fall through to the kind→persona
        // fallback. We log on the caller side; here we just surface
        // null gate metadata in the result so traces stay honest.
      } else {
        const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
        rpcDecision = row?.decision ?? null;
        rpcGate = row?.gate ?? null;
        if (row?.persona_key) {
          pickedPersona = row.persona_key;
          // The two-gate RPC returns `matched_phrase`; legacy/tenant
          // variant returns `matched_keyword`.
          matchedKeyword = row.matched_phrase ?? row.matched_keyword ?? null;
          confidence = row.confidence ?? null;
        }
      }
    } catch {
      /* keep empty hint, fall through to kind-based fallback */
    }
  }

  // Gate A says stay-inline → don't file a ticket, don't swap. Vitana
  // keeps the user. Return the LLM the instruction string Vertex used.
  if (rpcDecision === 'answer_inline') {
    return {
      decision: 'stay_inline',
      llm_instruction: buildStayInlineInstruction(rpcGate),
      rpc_gate: rpcGate,
    };
  }

  // Kind→persona fallback when gate didn't pick one.
  if (!pickedPersona) {
    try {
      pickedPersona = tenantId
        ? ((await registryPickPersonaForKindForTenant(kind, tenantId)) ?? '')
        : ((await registryPickPersonaForKind(kind)) ?? '');
    } catch {
      pickedPersona = '';
    }
  }

  // Ticket insert.
  const source = options.source ?? 'orb-voice-tool';
  const screenPath = options.screen_path ?? '/orb/voice';
  const triagedAt = pickedPersona ? new Date().toISOString() : null;
  const { data: created, error: insertError } = await repo.insertFeedbackTicket(sb, {
    user_id: identity.user_id,
    vitana_id: identity.vitana_id ?? null,
    kind,
    status: pickedPersona ? 'triaged' : 'new',
    // VTID-04332: never null for voice — see ReportToSpecialistOptions.surface.
    surface: options.surface ?? 'community',
    raw_transcript: summary,
    intake_messages: [
      {
        agent: 'vitana',
        role: 'user',
        content: summary,
        ts: new Date().toISOString(),
      },
    ],
    structured_fields: {
      specialist_hint: specialistHint || null,
      voice_origin: true,
      source,
      // VTID-04332: feedback_tickets has no tenant_id or language column
      // (see the table in 20260428200000_vtid_02047_unified_feedback_pipeline_init.sql),
      // so both ride in structured_fields. session_id lets a supervisor join
      // the ticket to the session's OASIS events.
      tenant_id: tenantId ?? null,
      language: identity.lang ?? null,
      session_id: options.session_id ?? null,
      current_route: options.current_route ?? null,
    },
    screen_path: screenPath,
    resolver_agent: pickedPersona || null,
    triaged_at: triagedAt,
  });

  if (insertError || !created) {
    return {
      decision: 'failed',
      error: `feedback_tickets insert failed: ${insertError?.message ?? 'no row returned'}`,
    };
  }

  const ticket = created as { id: string; ticket_number: string | null };

  // Live Handoffs panel event — only when a specialist was picked.
  if (pickedPersona) {
    try {
      await repo.insertFeedbackHandoffEvent(sb, {
        ticket_id: ticket.id,
        user_id: identity.user_id,
        vitana_id: identity.vitana_id ?? null,
        from_agent: 'vitana',
        to_agent: pickedPersona,
        reason: 'off_domain_intent',
        detected_intent: kind,
        matched_keyword: matchedKeyword,
        confidence,
      });
    } catch {
      /* non-blocking — the ticket is the source of truth */
    }
  }

  // OASIS event so cockpit Feedback Inbox + KPIs pick it up.
  try {
    await emitOasisEvent({
      vtid: 'VTID-02047',
      type: 'feedback.ticket.created' as never,
      source,
      status: 'info',
      message: `Voice tool report_to_specialist created ticket ${ticket.ticket_number ?? '(pending)'} (${kind}) → ${pickedPersona || 'unrouted'}`,
      payload: {
        ticket_id: ticket.id,
        ticket_number: ticket.ticket_number,
        kind,
        specialist: pickedPersona,
        voice_origin: true,
        source,
        surface: options.surface ?? 'community',
        language: identity.lang ?? null,
        session_id: options.session_id ?? null,
      },
      actor_id: identity.user_id,
      actor_role: 'user',
      surface: 'orb',
      vitana_id: identity.vitana_id ?? undefined,
    });
  } catch {
    /* non-blocking */
  }

  return {
    decision: 'created',
    ticket: {
      id: ticket.id,
      ticket_number: ticket.ticket_number,
    },
    persona: pickedPersona || null,
    matched_keyword: matchedKeyword,
    confidence,
    rpc_decision: rpcDecision,
    rpc_gate: rpcGate,
  };
}

/**
 * VTID-04332 — the model-facing tool message for one executeReportToSpecialist
 * result. `handoffQueued` says whether the caller actually queued a persona
 * hand-off for a 'created' ticket: a ticket without a queued hand-off is
 * `ticket_filed_no_handoff`, never `handoff_created`. `roleLabel` is the
 * user-language role name of the colleague (never the persona key).
 */
export function reportToSpecialistToolMessage(
  result: ReportToSpecialistResult,
  opts: { handoffQueued: boolean; roleLabel?: string; network?: boolean },
): { status: ReportToSpecialistStatus; text: string } {
  switch (result.decision) {
    case 'vague':
      return { status: 'vague', text: result.llm_instruction };
    case 'stay_inline':
      return { status: 'stay_inline', text: result.llm_instruction };
    case 'failed': {
      const status: ReportToSpecialistStatus = opts.network ? 'failed_network' : 'failed';
      return {
        status,
        text: buildReportToSpecialistToolMessage(status, REPORT_TO_SPECIALIST_ACTIONS[status]()),
      };
    }
    case 'created': {
      const ticketNumber = result.ticket.ticket_number;
      if (opts.handoffQueued && result.persona) {
        return {
          status: 'handoff_created',
          text: buildReportToSpecialistToolMessage(
            'handoff_created',
            REPORT_TO_SPECIALIST_ACTIONS.handoff_created(opts.roleLabel || 'our support team', ticketNumber),
          ),
        };
      }
      return {
        status: 'ticket_filed_no_handoff',
        text: buildReportToSpecialistToolMessage(
          'ticket_filed_no_handoff',
          REPORT_TO_SPECIALIST_ACTIONS.ticket_filed_no_handoff(ticketNumber),
        ),
      };
    }
  }
}

// ===========================================================================
// VTID-04332 — append_to_ticket: the specialist enriches the ticket
// ===========================================================================

export const APPEND_TO_TICKET_MAX_NOTE_CHARS = 2000;

export type AppendToTicketFailureReason =
  | 'not_specialist'
  | 'no_handoff_ticket'
  | 'empty_note'
  | 'not_found'
  | 'not_owner'
  | 'failed';

export type AppendToTicketResult =
  | { ok: true; ticket_id: string; ticket_number: string | null; message_count: number }
  | { ok: false; reason: AppendToTicketFailureReason; error?: string };

/**
 * Append one note to a ticket's intake_messages. Allowed only for a
 * specialist persona (never Vitana) that took over this session through a
 * hand-off, and only on a ticket owned by the session's user. `ticket_id`
 * "current" (or empty) means the ticket this session's hand-off created.
 */
export async function executeAppendToTicket(
  args: { ticket_id?: unknown; note?: unknown },
  ctx: {
    user_id: string;
    active_persona: string | null | undefined;
    handoff_ticket_id: string | null | undefined;
  },
  sb: SupabaseClient,
): Promise<AppendToTicketResult> {
  const persona = String(ctx.active_persona || 'vitana');
  if (persona === 'vitana') {
    return { ok: false, reason: 'not_specialist' };
  }
  if (!ctx.handoff_ticket_id) {
    return { ok: false, reason: 'no_handoff_ticket' };
  }
  const note = String(args.note ?? '').trim().slice(0, APPEND_TO_TICKET_MAX_NOTE_CHARS);
  if (!note) return { ok: false, reason: 'empty_note' };

  const requested = String(args.ticket_id ?? '').trim();
  const ticketId =
    !requested || requested.toLowerCase() === 'current' ? ctx.handoff_ticket_id : requested;

  try {
    const { data, error } = await repo.fetchTicketForAppend(sb, ticketId);
    if (error) return { ok: false, reason: 'failed', error: error.message };
    const row = data as
      | { id: string; user_id: string; ticket_number: string | null; intake_messages: unknown }
      | null;
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.user_id !== ctx.user_id) return { ok: false, reason: 'not_owner' };

    const existing = Array.isArray(row.intake_messages) ? (row.intake_messages as unknown[]) : [];
    const messages = [
      ...existing,
      { agent: persona, role: 'assistant', content: note, ts: new Date().toISOString() },
    ];
    const { error: updErr } = await repo.updateTicketIntakeMessages(sb, row.id, ctx.user_id, messages);
    if (updErr) return { ok: false, reason: 'failed', error: updErr.message };
    return {
      ok: true,
      ticket_id: row.id,
      ticket_number: row.ticket_number,
      message_count: messages.length,
    };
  } catch (err) {
    return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : 'append failed' };
  }
}

/** Model-facing text for an append_to_ticket result (intent, not speech). */
export function appendToTicketToolMessage(r: AppendToTicketResult): string {
  if (r.ok) {
    return `STATUS: appended. ACTION: The note is saved on ticket ${r.ticket_number ?? r.ticket_id}. Continue the conversation; do not read the note back to the user.`;
  }
  switch (r.reason) {
    case 'not_specialist':
      return 'STATUS: not_allowed. ACTION: Only the support colleague who took over after a hand-off can add notes to a ticket. To file a new report, use report_to_specialist.';
    case 'no_handoff_ticket':
      return 'STATUS: not_allowed. ACTION: This session has no ticket from a hand-off, so there is nothing to add to. Keep helping the user.';
    case 'empty_note':
      return 'STATUS: empty_note. ACTION: Nothing was saved. Call again with the detail you want recorded in the note.';
    case 'not_found':
    case 'not_owner':
      return 'STATUS: not_found. ACTION: That ticket is not one of this user\'s tickets. Use ticket_id "current" for the ticket of this hand-off.';
    default:
      return 'STATUS: failed. ACTION: The note could not be saved. Keep helping the user and do not claim it was saved.';
  }
}
