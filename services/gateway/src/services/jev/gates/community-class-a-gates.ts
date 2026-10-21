/**
 * VTID-04879: community Class A decisions in shadow (docs/JEV-INTEGRATION-PLAN.md §8.3).
 *
 *   community_intent_kind          C1  beside classifyIntentKind (Bedrock)      JEV_COMMUNITY_INTENT_KIND_MODE
 *   community_marketplace_intent   C3  beside the classify_marketplace_intent heuristic
 *                                                                             JEV_COMMUNITY_MARKETPLACE_INTENT_MODE
 *   community_worth_remembering    C10 before the per-turn memory extractor    JEV_COMMUNITY_WORTH_REMEMBERING_MODE
 *   community_ticket_triage        C19 beside pick_specialist_for_text          JEV_COMMUNITY_TICKET_TRIAGE_MODE
 *
 * Every gate is fire-and-forget: the existing logic has already decided and
 * keeps deciding; nothing here changes a return value, and nothing here
 * throws. A gate runs only when its mode is shadow (or enforce — there is no
 * enforce path yet, it behaves as shadow), the member plane is open
 * (JEV_COMMUNITY_ENABLED) and a tenant is known. Member rules then still apply
 * inside decide(): the tenant flag must list 'member' with a budget, spend is
 * counted as member (VTID-04857), the community rate share applies
 * (VTID-04874). Class A has no per-member quota.
 *
 * A shadow row never holds member text: the subject is a hash of the session
 * or turn ids, the verdict is the class and its probability next to what the
 * existing logic decided.
 */

import { createHash } from 'crypto';
import { decide, DecideOptions } from '../jev-decision-service';
import { isJevCommunityEnabled } from '../jev-access';
import { jevGateMode, recordJevShadowDecision, recordJevShadowOutcome } from '../jev-shadow';

export const COMMUNITY_INTENT_GATE = 'community_intent_kind';
export const COMMUNITY_MARKETPLACE_GATE = 'community_marketplace_intent';
export const COMMUNITY_MEMORY_GATE = 'community_worth_remembering';
export const COMMUNITY_TICKET_GATE = 'community_ticket_triage';
export const COMMUNITY_CLASS_A_GATES = [COMMUNITY_INTENT_GATE, COMMUNITY_MARKETPLACE_GATE, COMMUNITY_MEMORY_GATE, COMMUNITY_TICKET_GATE] as const;

const ACTOR = 'community-class-a';
const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** A stable, non-reversible subject reference: never the member id or text. */
export function subjectRef(...parts: Array<string | null | undefined>): string {
  return createHash('sha256').update(parts.map((p) => p ?? '').join('|')).digest('hex').slice(0, 32);
}

export interface CommunityGateDeps {
  env?: NodeJS.ProcessEnv;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
  /** Test seams for the shadow table. */
  record?: typeof recordJevShadowDecision;
  recordOutcome?: typeof recordJevShadowOutcome;
}

interface ShadowCall {
  gate: string;
  decision: string;
  input: Record<string, unknown>;
  tenantId: string | null | undefined;
  memberId: string | null | undefined;
  subjectType: string;
  subjectRef: string;
  /** The existing logic's class; null when it gave none (compare later or never). */
  existing: string | null;
  /** Agreement on Jev's primary answer; default: equality with `existing`. */
  agree?: (jevValue: string) => boolean | null;
}

export function isCommunityGateOn(gate: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(gate, env) !== 'off' && isJevCommunityEnabled(env);
}

async function runShadow(c: ShadowCall, d: CommunityGateDeps): Promise<string | null> {
  const env = d.env ?? process.env;
  try {
    const mode = jevGateMode(c.gate, env);
    if (mode === 'off' || !isJevCommunityEnabled(env) || !c.tenantId) return null;
    const r = await decide(
      c.decision,
      c.input,
      { actor_id: ACTOR, system: true, system_plane: 'system_autopilot', tenant_id: c.tenantId },
      { ...(d.decideOptions || {}), source: `gate:${c.gate}`, env, ...(c.memberId ? { member_id: c.memberId } : {}) },
    );
    const value = r.ok && r.outcome === 'decided' ? String(r.verdict.value) : null;
    const agreed = value === null ? null : c.agree ? c.agree(value) : c.existing === null ? null : value === c.existing;
    const extra = r.ok
      ? Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, { value: a.value, probability: (a as any).probability ?? null, confidence: a.confidence }]))
      : null;
    return await (d.record ?? recordJevShadowDecision)({
      gate: c.gate,
      decision: c.decision,
      mode,
      plane: 'member',
      tenant_id: c.tenantId,
      subject_type: c.subjectType,
      subject_ref: c.subjectRef,
      jev_outcome: r.outcome,
      jev_verdict: r.ok ? { value, answers: extra, existing: c.existing } : { reason: r.reason, existing: c.existing },
      jev_confidence: r.ok ? r.verdict.confidence : null,
      system_action: c.existing === null ? 'existing_none' : `existing_${c.existing}`,
      cost_usd: r.ok ? r.cost_usd : 0,
      agreed,
      outcome: agreed === null ? null : 'compared_with_existing',
      outcome_at: agreed === null ? null : new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn(`[jev] ${c.gate} shadow failed: ${err?.message || err}`);
    return null;
  }
}

/** C1: Jev beside classifyIntentKind. `existingKind` null = the classifier gave no confident kind. */
export function shadowIntentKind(
  a: { utterance: string; existingKind: string | null; existingConfidence: number; tenantId: string | null | undefined; userId?: string | null; sessionId?: string | null; source: string },
  d: CommunityGateDeps = {},
): Promise<string | null> {
  const confident = a.existingKind && a.existingConfidence >= 0.7 ? a.existingKind : null;
  return runShadow(
    {
      gate: COMMUNITY_INTENT_GATE,
      decision: 'community_intent_kind',
      input: { utterance: cut(a.utterance, 1000) },
      tenantId: a.tenantId,
      memberId: a.userId,
      subjectType: 'community_utterance',
      subjectRef: subjectRef(a.source, a.sessionId, a.utterance),
      existing: confident ?? 'none',
    },
    d,
  );
}

/** C3: Jev beside the marketplace keyword heuristic (five labels, no 'none'). */
export function shadowMarketplaceIntent(
  a: { need: string; existingIntent: string; tenantId: string | null | undefined; userId?: string | null },
  d: CommunityGateDeps = {},
): Promise<string | null> {
  return runShadow(
    {
      gate: COMMUNITY_MARKETPLACE_GATE,
      decision: 'community_marketplace_intent',
      input: { need: cut(a.need, 1000) },
      tenantId: a.tenantId,
      memberId: a.userId,
      subjectType: 'community_marketplace_need',
      subjectRef: subjectRef('marketplace', a.need),
      existing: a.existingIntent,
    },
    d,
  );
}

/**
 * C10: Jev before the memory extractor. Agreement is unknown until the
 * extractor reports how many facts it stored; call `settle` with that count.
 */
export function shadowWorthRemembering(
  a: { conversation: string; tenantId: string | null | undefined; userId?: string | null; sessionId: string },
  d: CommunityGateDeps = {},
): { settle: (persisted: number) => Promise<void> } {
  let jevWorth: boolean | null = null;
  const row = runShadow(
    {
      gate: COMMUNITY_MEMORY_GATE,
      decision: 'community_worth_remembering',
      // The extractor sees the whole text; Jev sees the most recent part.
      input: { conversation: a.conversation.length > 2000 ? a.conversation.slice(-2000) : a.conversation },
      tenantId: a.tenantId,
      memberId: a.userId,
      subjectType: 'community_memory_turn',
      subjectRef: subjectRef('memory', a.sessionId, a.conversation),
      existing: null,
      agree: (v) => {
        jevWorth = v === 'true';
        return null;
      },
    },
    d,
  );
  return {
    settle: async (persisted: number) => {
      try {
        const id = await row;
        if (!id || jevWorth === null) return;
        const stored = persisted > 0;
        await (d.recordOutcome ?? recordJevShadowOutcome)(id, stored ? 'extractor_stored_facts' : 'extractor_stored_nothing', jevWorth === stored);
      } catch (err: any) {
        console.warn(`[jev] ${COMMUNITY_MEMORY_GATE} outcome failed: ${err?.message || err}`);
      }
    },
  };
}

/** C19: Jev beside pick_specialist_for_text. `existingDecision` is the RPC's decision ('answer_inline' or other/null). */
export function shadowTicketTriage(
  a: { summary: string; existingDecision: string | null; personaPicked: boolean; tenantId: string | null | undefined; userId?: string | null; sessionId?: string | null },
  d: CommunityGateDeps = {},
): Promise<string | null> {
  // The RPC either keeps the member inline or routes to a specialist (a ticket);
  // no decision and no persona means the kind fallback files a ticket.
  const existing = a.existingDecision === 'answer_inline' ? 'answer_inline' : 'file_ticket';
  return runShadow(
    {
      gate: COMMUNITY_TICKET_GATE,
      decision: 'community_ticket_triage',
      input: { summary: cut(a.summary, 1500) },
      tenantId: a.tenantId,
      memberId: a.userId,
      subjectType: 'community_ticket',
      subjectRef: subjectRef('ticket', a.sessionId, a.summary),
      existing,
    },
    d,
  );
}
