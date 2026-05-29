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
}

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
  `ASK_FOR_SPECIFICS: Your summary "${summary}" is too vague. Do NOT call this tool again until you have a concrete description. Speak ONE follow-up question to the user IN THEIR LANGUAGE asking what specifically broke (which screen / feature / error message / what they were doing). Vary your phrasing every call. Then wait for their answer. Only after you have specifics, call this tool again with a real description (>= 12 words, in the user's own words). Do NOT mention this internal routing — just ask the question naturally.`;

function buildStayInlineInstruction(rpcGate: string | null): string {
  const gateLabel = rpcGate === 'stay_inline'
    ? 'stay-inline override'
    : rpcGate === 'unrouted'
      ? 'no enabled specialist'
      : 'no explicit forward request';
  return `Stay with the user — this is not a customer-support handoff (${gateLabel}). Answer the question yourself as Vitana, the user's life companion. Do NOT mention this routing decision out loud.`;
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
    wordCount < 12 || VAGUE_PATTERNS.some((re) => re.test(summary));
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
      const { data: rpcData, error: rpcError } = await sb.rpc(
        rpcName,
        rpcArgs as never,
      );
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
  const { data: created, error: insertError } = await sb
    .from('feedback_tickets')
    .insert({
      user_id: identity.user_id,
      vitana_id: identity.vitana_id ?? null,
      kind,
      status: pickedPersona ? 'triaged' : 'new',
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
      },
      screen_path: screenPath,
      resolver_agent: pickedPersona || null,
      triaged_at: triagedAt,
    })
    .select('id, ticket_number')
    .single();

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
      await sb.from('feedback_handoff_events').insert({
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
