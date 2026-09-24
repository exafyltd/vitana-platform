/**
 * VTID-04443 (Plan v1 WS-4.4) — conversation replay.
 *
 * A replay case is a recorded conversation reduced to the inputs the
 * conversation brain decides from: the opening context, the continuation
 * providers' results, and the turns that follow (screen, what the user said).
 * `replayConversation` runs those inputs through the real decision functions
 * — no I/O, no clock, no model — and returns a transcript of every decision.
 * The replay test (test/services/conversation/vtid-04443-conversation-replay)
 * checks each case's explicit expectations and snapshots the whole transcript,
 * so any change to conversation logic that changes a replayed decision fails
 * until the snapshot is deliberately updated.
 *
 * Cases are synthetic, or recorded from a real session with the member's
 * consent and sanitized by `caseSkeletonFromInspector` (no user id, no
 * session id, no transcript text). Stored under
 * test/fixtures/conversation-replay/cases/.
 */

import {
  decideConversationFlow,
  resolveCandidateOutcome,
  type CandidateOutcome,
} from '../decide-conversation-flow';
import type { GreetingDecisionContext } from '../compute-greeting-decision';
import { isVerbatimRecitationDirective } from '../phrasing-rule';
import {
  DEFAULT_SCORING_WEIGHTS,
  partOfDayForHour,
  rankInShadow,
  type ScorableCandidate,
} from '../candidate-scoring';
import { personalizeWeights, type UserOutcomeCounts } from '../personal-weights';
import { decideTurnCandidates, toStoredTurnCandidates } from '../turn-candidates';
import { applyContextUpdate, type ContextUpdateTarget } from '../../../orb/live/session/context-update';
import { buildLiveApiTools } from '../../../orb/live/tools/live-tool-catalog';
import {
  enforceToolCatalogBudget,
  FLAG_GATED_PRIORITY_TOOLS,
  NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT,
  VERTEX_BRIDGE_PRIORITY_TOOLS,
} from '../../../orb/live/tools/vertex-tool-catalog-budget';
import {
  buildSessionToolPriority,
  deferredDeclarationMap,
  searchDeferredTools,
  withMetaTools,
} from '../../../orb/live/tools/session-tool-selection';
import { isMeaningfulTurn } from '../live-advisor';

export const REPLAY_CASE_SCHEMA_VERSION = 1;

export interface ReplayProviderResult {
  providerKey: string;
  status: 'returned' | 'suppressed' | 'skipped' | 'errored';
  candidate?: {
    id: string;
    kind: string;
    dedupeKey?: string;
    priority?: number;
    userFacingLine?: string;
    privacyMode?: string;
    cta?: { type?: string; route?: string; onYesTool?: string; toolName?: string };
  };
}

export interface ReplayTurn {
  /** Screen the host reports before this turn (a context_update), if it changed. */
  route?: string;
  screen_title?: string;
  /** What the user said — synthetic text only. */
  user: string;
  /** A find_tool query the model would issue on this turn, if any. */
  find_tool?: string;
}

export interface ReplayCase {
  schema_version: number;
  id: string;
  description: string;
  /** 'synthetic', or 'recorded' with a consent reference. */
  source: { kind: 'synthetic' } | { kind: 'recorded'; consent_ref: string; recorded_at: string };
  role?: string;
  opening: {
    /** Overrides on the replay's default returning-user opening context. */
    greeting?: Partial<GreetingDecisionContext>;
    providers?: ReplayProviderResult[];
    /** providerKey of the ranker's winner, when one was selected. */
    winner?: string | null;
  };
  /** Per-provider accepted / declined / ignored history for this user. */
  outcomes?: Record<string, { accepted: number; declined: number; ignored: number }>;
  /** Mirrors BRAIN_PERSONAL_WEIGHTS=true (staging): the live leads use the user's own weights. */
  personal_weights_live?: boolean;
  turns?: ReplayTurn[];
  expect: ReplayExpectations;
}

export interface ReplayExpectations {
  opener_kind?: string;
  register?: string | null;
  silent_opening?: boolean;
  candidate_provider?: string | null;
  candidate_spoken?: boolean;
  shadow_winner?: string | null;
  /** Per turn index. */
  turns?: Array<{
    route_groups?: string[];
    declared_tools_include?: string[];
    reachable_tools_include?: string[];
    find_tool_top?: string;
    top_lead_provider?: string | null;
    advisor_eligible?: boolean;
  } | null>;
}

export interface ReplayTurnResult {
  index: number;
  route: string | null;
  route_groups: string[];
  declared_tool_count: number;
  declared_tools_sample: string[];
  deferred_tool_count: number;
  find_tool_results: string[] | null;
  leads: Array<{ provider: string; score: number }>;
  advisor_eligible: boolean;
  declared_tools: Set<string>;
  deferred_tools: Set<string>;
}

export interface ReplayTranscript {
  case_id: string;
  opening: {
    opener_kind: string;
    register: string | null;
    nba: string | null;
    silent: boolean;
    directive_chars: number;
    recital_directive: boolean;
    candidate: CandidateOutcome;
    shadow_winner: string | null;
    personal_weights_applied: boolean;
  };
  turns: ReplayTurnResult[];
}

/** The default opening: a signed-in returning user, context resolved, deterministic. */
export function defaultReplayGreeting(): GreetingDecisionContext {
  return {
    contextReadyResolved: true,
    isAnonymous: false,
    safeFastGreetingLive: false,
    reconnectCount: 0,
    lang: 'en',
    greetLang: 'en',
    bucket: 'today',
    timeAgo: 'earlier today',
    wasFailure: false,
    firstName: 'Alex',
    hasUserId: true,
    hasSupabase: true,
    hasPriorSession: true,
    greetingNeedsOnboarding: false,
    greetingIsFirstTime: false,
    lastFullBriefingDate: '2026-09-23',
    todayTz: '2026-09-23',
    localHour: 9,
    timezone: 'Europe/Berlin',
    timeOfDay: 'morning',
    proactiveLine: null,
    newdayOverview: null,
    resumeOverview: null,
    rotationSeed: 7,
    recentNbaKeys: [],
    currentRoute: null,
    currentScreenTitle: null,
    menuPhrases: ['Good to have you here.', 'Let us carry on.', 'I am listening.'],
    openDecision: { mode: 'speak', source: 'baseline_lead', line: null },
    guidedTopicNarrationContent: null,
    wakeBriefDecisionId: null,
    silenceOnSkipEnabled: true,
    wakeBriefHasSelectedContinuation: false,
    voiceWakeBriefReason: null,
    nowIso: '2026-09-23T07:00:00.000Z',
  } as GreetingDecisionContext;
}

const toolNames = (tools: object[]) =>
  (tools as Array<{ function_declarations?: Array<{ name: string }> }>).flatMap((g) => (g.function_declarations ?? []).map((d) => d.name));

function continuationDecision(c: ReplayCase) {
  const providers = c.opening.providers ?? [];
  const winner = c.opening.winner ? providers.find((p) => p.providerKey === c.opening.winner && p.candidate) : null;
  return {
    decisionId: `replay-${c.id}`,
    selectedContinuation: winner?.candidate ?? null,
    sourceProviderResults: providers.map((p) => ({ providerKey: p.providerKey, status: p.status, candidate: p.candidate })),
  };
}

function scorable(providers: ReplayProviderResult[]): ScorableCandidate[] {
  return providers
    .filter((p) => p.status === 'returned' && p.candidate && p.candidate.kind !== 'none_with_reason')
    .map((p) => ({
      provider: p.providerKey,
      kind: p.candidate!.kind,
      dedupeKey: p.candidate!.dedupeKey ?? null,
      priority: p.candidate!.priority ?? 0,
      ctaRoute: p.candidate!.cta?.type === 'navigate' && p.candidate!.cta.route ? p.candidate!.cta.route : null,
    }));
}

/** Run one case through the real decision functions. Pure and deterministic. */
export function replayConversation(c: ReplayCase): ReplayTranscript {
  const greeting = { ...defaultReplayGreeting(), ...(c.opening.greeting ?? {}) } as GreetingDecisionContext;
  const decision = decideConversationFlow({ transport: 'vertex', role: c.role ?? 'community', greeting });
  const cd = continuationDecision(c);
  const candidate = resolveCandidateOutcome(decision.opener_kind, cd as never);

  const outcomes: Record<string, UserOutcomeCounts> = {};
  for (const [p, o] of Object.entries(c.outcomes ?? {})) {
    outcomes[p] = { accepted: o.accepted, declined: o.declined, ignored: o.ignored, settled: o.accepted + o.declined + o.ignored };
  }
  const personal = personalizeWeights(DEFAULT_SCORING_WEIGHTS, outcomes);
  const partOfDay = partOfDayForHour(greeting.localHour);
  const cands = scorable(c.opening.providers ?? []);
  const shadow = cands.length
    ? rankInShadow(cands, candidate.candidate_provider, { recentlyServed: [], recentWindow: 5, currentRoute: greeting.currentRoute, partOfDay, outcomes }, personal.weights)
    : null;

  const stored = toStoredTurnCandidates(cd as never);
  const session: ContextUpdateTarget = { current_route: greeting.currentRoute ?? '/', recent_routes: [] };
  const turns: ReplayTurnResult[] = (c.turns ?? []).map((t, index) => {
    if (t.route || t.screen_title) applyContextUpdate(session, { current_route: t.route, screen_title: t.screen_title }, index + 1);
    const route = session.current_route ?? null;
    const catalog = buildLiveApiTools('authenticated', route ?? '/', c.role ?? 'community', null) as object[];
    const base = [...VERTEX_BRIDGE_PRIORITY_TOOLS, ...FLAG_GATED_PRIORITY_TOOLS];
    const sel = buildSessionToolPriority(catalog, base, route);
    const packed = enforceToolCatalogBudget(withMetaTools(catalog), NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT, sel.priority);
    const declared = new Set(toolNames(packed.tools));
    const deferred = deferredDeclarationMap(catalog, packed.dropped);
    const leads = decideTurnCandidates(stored, { recentlyServed: [], recentWindow: 5, currentRoute: route, partOfDay, outcomes },
      c.personal_weights_live ? personal.weights : DEFAULT_SCORING_WEIGHTS);
    return {
      index,
      route,
      route_groups: sel.groups,
      declared_tool_count: declared.size,
      declared_tools_sample: [...declared].sort().slice(0, 12),
      deferred_tool_count: deferred.size,
      find_tool_results: t.find_tool ? searchDeferredTools(deferred, t.find_tool).map((x) => x.name) : null,
      leads: leads.map((l) => ({ provider: l.provider, score: l.score })),
      advisor_eligible: isMeaningfulTurn(t.user),
      declared_tools: declared,
      deferred_tools: new Set(deferred.keys()),
    };
  });

  return {
    case_id: c.id,
    opening: {
      opener_kind: decision.opener_kind,
      register: decision.register,
      nba: decision.nba ? String((decision.nba as { key?: string }).key ?? decision.nba) : null,
      silent: decision.directive === null,
      directive_chars: decision.directive?.length ?? 0,
      recital_directive: isVerbatimRecitationDirective(decision.directive),
      candidate,
      shadow_winner: shadow?.shadow_winner ?? null,
      personal_weights_applied: personal.adjustment.applied,
    },
    turns,
  };
}

/** The transcript without the per-turn sets, for snapshots. */
export function transcriptForSnapshot(t: ReplayTranscript): Omit<ReplayTranscript, 'turns'> & { turns: Array<Omit<ReplayTurnResult, 'declared_tools' | 'deferred_tools'>> } {
  return { ...t, turns: t.turns.map(({ declared_tools: _d, deferred_tools: _r, ...rest }) => rest) };
}

/** Compare a transcript with the case's expectations. Returns failure messages. */
export function checkReplayExpectations(c: ReplayCase, t: ReplayTranscript): string[] {
  const e = c.expect;
  const f: string[] = [];
  const eq = (label: string, got: unknown, want: unknown) => {
    if (want !== undefined && JSON.stringify(got) !== JSON.stringify(want)) f.push(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };
  eq('opener_kind', t.opening.opener_kind, e.opener_kind);
  eq('register', t.opening.register, e.register);
  eq('silent_opening', t.opening.silent, e.silent_opening);
  eq('candidate_provider', t.opening.candidate.candidate_provider, e.candidate_provider);
  eq('candidate_spoken', t.opening.candidate.candidate_spoken, e.candidate_spoken);
  eq('shadow_winner', t.opening.shadow_winner, e.shadow_winner);
  // Standing rule for every case: no opening may ask the model to recite (NEVER-rule 41).
  if (t.opening.recital_directive) f.push('opening directive asks the model to recite text (NEVER-rule 41)');
  (e.turns ?? []).forEach((te, i) => {
    if (!te) return;
    const tr = t.turns[i];
    if (!tr) { f.push(`turn ${i}: missing from the transcript`); return; }
    eq(`turn ${i} route_groups`, tr.route_groups, te.route_groups);
    for (const n of te.declared_tools_include ?? []) if (!tr.declared_tools.has(n)) f.push(`turn ${i}: tool ${n} not declared`);
    for (const n of te.reachable_tools_include ?? []) if (!tr.declared_tools.has(n) && !tr.deferred_tools.has(n)) f.push(`turn ${i}: tool ${n} neither declared nor reachable`);
    if (te.find_tool_top !== undefined && (tr.find_tool_results ?? [])[0] !== te.find_tool_top) {
      f.push(`turn ${i}: find_tool top expected ${te.find_tool_top}, got ${(tr.find_tool_results ?? [])[0] ?? 'none'}`);
    }
    if (te.top_lead_provider !== undefined) eq(`turn ${i} top_lead_provider`, tr.leads[0]?.provider ?? null, te.top_lead_provider);
    eq(`turn ${i} advisor_eligible`, tr.advisor_eligible, te.advisor_eligible);
  });
  return f;
}

// ---------------------------------------------------------------------------
// Recording a case from a real session (consented, sanitized)
// ---------------------------------------------------------------------------

/**
 * Turn a brain-inspector session summary (GET /admin/conversation/sessions/:id/brain)
 * into a case skeleton. Refuses without a consent reference. Keeps only what
 * the brain decided from — language, route, opener, provider statuses — and
 * never the user id, the session id or any spoken text. Turns and expectations
 * are left for the author to fill with synthetic text.
 */
export function caseSkeletonFromInspector(
  summary: Record<string, unknown>,
  opts: { id: string; consentRef: string; recordedAt: string },
): ReplayCase {
  if (!opts.consentRef || !opts.consentRef.trim()) throw new Error('a consent reference is required to record a case from a real session');
  if (!/^[a-z0-9-]{3,60}$/.test(opts.id)) throw new Error('case id must be 3-60 characters of a-z, 0-9 and -');
  const user = (summary.user ?? {}) as Record<string, unknown>;
  const decisions = Array.isArray(summary.decision) ? (summary.decision as Array<Record<string, unknown>>) : [];
  const first = decisions[0] ?? {};
  const cand = (summary.candidates ?? {}) as Record<string, unknown>;
  const providers = Array.isArray(cand.providers) ? (cand.providers as Array<Record<string, unknown>>) : [];
  const lang = typeof user.lang === 'string' && /^[a-z]{2}$/.test(user.lang) ? user.lang : 'en';
  const route = typeof first.current_route === 'string' && first.current_route.startsWith('/') ? first.current_route.split('?')[0] : null;
  const allowedStatus = new Set(['returned', 'suppressed', 'skipped', 'errored']);
  const opener = typeof first.wake_opener === 'string' ? first.wake_opener : undefined;
  const winner = typeof first.candidate_provider === 'string' ? first.candidate_provider : null;
  // The opening decision is re-created from the opener, never from the spoken
  // line: a spoken override gets a synthetic placeholder line.
  const openDecision = opener === 'override_v2' && winner
    ? { openDecision: { mode: 'speak' as const, source: 'wake_brief', line: 'Recorded opening line removed; synthetic placeholder.' }, wakeBriefHasSelectedContinuation: true }
    : opener === 'silent_reconnect'
      ? { openDecision: { mode: 'silent' as const, source: 'native_resume', line: null }, reconnectCount: 1 }
      : {};
  return {
    schema_version: REPLAY_CASE_SCHEMA_VERSION,
    id: opts.id,
    description: 'Recorded from a consented session — fill in synthetic turns and expectations.',
    source: { kind: 'recorded', consent_ref: opts.consentRef.trim(), recorded_at: opts.recordedAt },
    opening: {
      greeting: { lang, greetLang: lang, currentRoute: route, ...openDecision },
      providers: providers
        .filter((p) => typeof p.key === 'string' && allowedStatus.has(String(p.status)))
        .map((p) => ({
          providerKey: String(p.key),
          status: String(p.status) as ReplayProviderResult['status'],
          ...(p.status === 'returned' ? { candidate: { id: `c-${String(p.key)}`, kind: 'wake_brief', dedupeKey: `${String(p.key)}:recorded`, priority: 50 } } : {}),
        })),
      winner,
    },
    turns: [],
    expect: {
      opener_kind: opener,
    },
  };
}
