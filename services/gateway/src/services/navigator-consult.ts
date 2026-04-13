/**
 * Vitana Navigator — Consult Orchestration Service
 *
 * The composite "brain" that combines three intelligence sources to answer
 * the question "where should I send the user?":
 *
 *   1. Navigation Catalog scoring  — multilingual, fuzzy keyword match
 *   2. Knowledge Base               — runtime search + static topic anchors
 *   3. User context                 — identity, current page, recent routes,
 *                                     transcript excerpt, memory hints
 *
 * Returns a structured recommendation with:
 *   - primary screen (or null if confidence too low)
 *   - optional alternative for medium-confidence cases
 *   - a localized explanation Vitana can speak
 *   - KB excerpts she may quote
 *   - confirmation_needed flag + suggested clarification question
 *
 * Performance budget: 3 seconds (Gemini Live tool timeout). Memory hint
 * fetch and KB search run in parallel via Promise.all. If memory pack
 * exceeds its sub-budget it is skipped — catalog scoring still works.
 */

import {
  NAVIGATION_CATALOG,
  NavCatalogEntry,
  LangCode,
  getContent,
  searchCatalog,
  lookupScreen,
} from '../lib/navigation-catalog';
import {
  getCatalogForTenant,
  findOverrideTriggerMatch,
  searchCatalogEntries,
  isNavCatalogLoaded,
  type NavCatalogEntryWithRules,
} from '../lib/nav-catalog-db';
import { ContextLens, createContextLens } from '../types/context-lens';
import { searchKnowledgeDocs, KnowledgeDoc } from './knowledge-hub';
import { buildContextPack } from './context-pack-builder';
import { computeRetrievalRouterDecision } from './retrieval-router';
import { MemoryHit } from '../types/conversation';
import { writeMemoryItemWithIdentity } from './orb-memory-bridge';

// =============================================================================
// Public types
// =============================================================================

export interface NavigatorConsultIdentity {
  user_id: string;
  tenant_id: string;
  role?: string;
}

export interface NavigatorConsultInput {
  question: string;
  lang: LangCode;
  identity: NavigatorConsultIdentity | null;
  is_anonymous: boolean;
  current_route?: string;
  recent_routes?: string[];
  transcript_excerpt?: string;
  // Threading metadata for context pack — used for telemetry and caching
  session_id?: string;
  turn_number?: number;
  conversation_start?: string;
}

export interface NavigatorConsultPick {
  screen_id: string;
  route: string;
  title: string;
  // Attached when the pick comes from real catalog scoring; admins use the
  // score to debug near-misses in the /admin/navigator Coverage & Telemetry
  // views. Optional because synthetic picks (e.g. override-trigger matches)
  // don't have a score on the normal scale.
  score?: number;
}

export type ConsultConfidence = 'high' | 'medium' | 'low';

// VTID-NAV-02: How the winning pick was chosen. Surfaced in telemetry so
// admins can distinguish "LLM-scored win" from "exact-phrase override" from
// "tenant forced a custom screen".
export type ConsultDecisionSource = 'scoring' | 'override_trigger' | 'static_fallback';

export interface NavigatorConsultResult {
  confidence: ConsultConfidence;
  primary: NavigatorConsultPick | null;
  alternative?: NavigatorConsultPick;
  explanation: string;
  confirmation_needed: boolean;
  suggested_question?: string;
  kb_excerpts: string[];
  blocked_reason?: 'requires_auth' | 'no_match';
  // VTID-NAV-02: top-3 scored picks emitted in orb.navigator.consulted events
  // so the admin telemetry page can surface near-misses ("we picked A, but B
  // was at score-2") and dead triggers.
  top_picks: NavigatorConsultPick[];
  decision_source: ConsultDecisionSource;
  // Telemetry
  ms_elapsed: number;
  catalog_match_count: number;
  memory_hint_count: number;
  kb_excerpt_count: number;
}

// =============================================================================
// Configuration
// =============================================================================

const CONSULT_CONFIG = {
  // Score thresholds for confidence buckets — calibrated against the
  // routing-quality test rig. Tune as the catalog grows.
  HIGH_CONFIDENCE_MIN: 30,
  MEDIUM_CONFIDENCE_MIN: 12,
  // If 2nd-best is at least this fraction of the top score, treat as ambiguous
  AMBIGUITY_RATIO: 0.7,

  // Memory budget — we share the 3s Gemini Live tool timeout with KB search
  MEMORY_TIMEOUT_MS: 1500,
  KB_TIMEOUT_MS: 1500,

  // How many KB excerpts to include in the LLM-facing result
  MAX_KB_EXCERPTS: 3,
  KB_EXCERPT_MAX_CHARS: 220,

  // How many memory hits to consider for hint distillation
  MAX_MEMORY_HITS: 6,
};

// =============================================================================
// Memory hints
// =============================================================================

interface MemoryHints {
  goals: string[];          // distilled goal-related memories
  preferences: string[];    // distilled preference memories
  recent_topics: string[];  // distilled recent conversation topics
  recent_navigations: Array<{ screen_id: string; route: string }>;
}

const EMPTY_HINTS: MemoryHints = {
  goals: [],
  preferences: [],
  recent_topics: [],
  recent_navigations: [],
};

/**
 * Fetch memory hints for the consult call. Restricted to navigation-relevant
 * categories and capped at a tight time budget so it cannot starve KB search.
 *
 * Returns EMPTY_HINTS for anonymous sessions or on any failure — the consult
 * still produces a useful result without memory.
 */
async function fetchMemoryHints(input: NavigatorConsultInput): Promise<MemoryHints> {
  if (input.is_anonymous || !input.identity) return EMPTY_HINTS;

  const lens: ContextLens = createContextLens(
    input.identity.tenant_id,
    input.identity.user_id,
    {
      workspace_scope: 'product',
      active_role: input.identity.role,
      // Restrict to categories that actually shape navigation decisions
      allowed_categories: [
        'goals', 'preferences', 'health', 'community',
        'events_meetups', 'products_services', 'notes',
      ],
      max_age_hours: 168, // 7 days
    }
  );

  // Force memory_garden only — the consult does its own KB search separately
  const routerDecision = computeRetrievalRouterDecision(input.question, {
    channel: 'orb',
    force_sources: ['memory_garden'],
    limit_overrides: {
      memory_garden: CONSULT_CONFIG.MAX_MEMORY_HITS,
      knowledge_hub: 0,
      web_search: 0,
    },
  });

  try {
    const pack = await Promise.race([
      buildContextPack({
        lens,
        query: input.question,
        channel: 'orb',
        thread_id: input.session_id || 'navigator-consult',
        turn_number: input.turn_number || 0,
        conversation_start: input.conversation_start || new Date().toISOString(),
        role: input.identity.role || 'user',
        router_decision: routerDecision,
        session_id: input.session_id,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('memory_timeout')), CONSULT_CONFIG.MEMORY_TIMEOUT_MS)
      ),
    ]);

    return distillMemoryHints(pack.memory_hits || []);
  } catch (err: any) {
    console.warn(`[VTID-NAV-CONSULT] Memory hint fetch failed: ${err.message}`);
    return EMPTY_HINTS;
  }
}

/**
 * Reduce raw memory hits into navigation-relevant hint buckets.
 *
 * Looks at category_key, content_json mode, and content text to bucket each
 * hit. Navigator-action memories (mode='navigator_action') feed
 * recent_navigations so the consult service can avoid looping the user.
 */
function distillMemoryHints(hits: MemoryHit[]): MemoryHints {
  const out: MemoryHints = {
    goals: [],
    preferences: [],
    recent_topics: [],
    recent_navigations: [],
  };

  for (const hit of hits) {
    // category_key is the primary bucket signal
    const cat = (hit.category_key || '').toLowerCase();

    // Detect navigator-action memories so we can down-weight repeats. The
    // content_json shape is set by writeNavigatorActionMemory; we don't have
    // it on the MemoryHit interface today, so check the content prefix.
    const isNavAction = hit.content?.startsWith('Vitana navigated to');
    if (isNavAction) {
      // Extract route from content like "Vitana navigated to <Title> (<route>)"
      const m = hit.content.match(/\(([^)]+)\)/);
      if (m) {
        const route = m[1];
        const entry = NAVIGATION_CATALOG.find(e => e.route === route);
        if (entry) {
          out.recent_navigations.push({ screen_id: entry.screen_id, route });
        }
      }
      continue;
    }

    if (cat === 'goals') {
      out.goals.push(hit.content);
    } else if (cat === 'preferences') {
      out.preferences.push(hit.content);
    } else if (cat === 'conversation' || cat === 'notes') {
      out.recent_topics.push(hit.content);
    }
  }

  // Cap each bucket
  out.goals = out.goals.slice(0, 3);
  out.preferences = out.preferences.slice(0, 3);
  out.recent_topics = out.recent_topics.slice(0, 3);
  out.recent_navigations = out.recent_navigations.slice(0, 5);
  return out;
}

// =============================================================================
// Knowledge base search
// =============================================================================

async function fetchKnowledgeExcerpts(question: string): Promise<string[]> {
  try {
    const docs = await Promise.race([
      searchKnowledgeDocs(question, CONSULT_CONFIG.MAX_KB_EXCERPTS),
      new Promise<KnowledgeDoc[]>((_, reject) =>
        setTimeout(() => reject(new Error('kb_timeout')), CONSULT_CONFIG.KB_TIMEOUT_MS)
      ),
    ]);
    return docs
      .map(d => truncate(d.snippet || d.title, CONSULT_CONFIG.KB_EXCERPT_MAX_CHARS))
      .filter(s => s.length > 0)
      .slice(0, CONSULT_CONFIG.MAX_KB_EXCERPTS);
  } catch (err: any) {
    console.warn(`[VTID-NAV-CONSULT] KB search failed: ${err.message}`);
    return [];
  }
}

/**
 * Static KB topic anchors: catalog entries can declare related_kb_topics
 * which we resolve to short hint strings. This is the "guaranteed good"
 * explanation source — runtime KB search handles the long tail.
 *
 * Today this returns the related_kb_topics array as-is so the LLM can read
 * the anchor ids. When the KB exposes a topic-by-id resolver we will fetch
 * the actual topic content here.
 */
function staticKbAnchors(entry: NavCatalogEntry | null): string[] {
  if (!entry || !entry.related_kb_topics?.length) return [];
  return entry.related_kb_topics.slice(0, CONSULT_CONFIG.MAX_KB_EXCERPTS);
}

// =============================================================================
// Catalog scoring with memory bias
// =============================================================================

function scoreCatalogWithMemory(
  input: NavigatorConsultInput,
  hints: MemoryHints
): Array<{ entry: NavCatalogEntry; score: number }> {
  const excludeRoutes: string[] = [];
  if (input.current_route) excludeRoutes.push(input.current_route);

  // VTID-NAV-02: prefer the DB-backed tenant-aware catalog when the cache
  // has been warmed. Falls back transparently to the static scorer so that
  // the 77 navigation-catalog tests keep passing unchanged and first-boot
  // sessions still work before refreshNavCatalogCache completes.
  const tenantId = input.identity?.tenant_id || null;
  const baseResults: Array<{ entry: NavCatalogEntry; score: number }> =
    isNavCatalogLoaded()
      ? searchCatalogEntries(
          getCatalogForTenant(tenantId) as ReadonlyArray<NavCatalogEntry>,
          input.question,
          input.lang,
          { anonymous_only: input.is_anonymous, exclude_routes: excludeRoutes }
        )
      : searchCatalog(input.question, input.lang, {
          anonymous_only: input.is_anonymous,
          exclude_routes: excludeRoutes,
        });

  if (baseResults.length === 0) return baseResults;

  // Build a soft penalty set from recent navigations (in-session and from
  // memory). Don't hard-exclude — the user may legitimately want to revisit.
  const recentRouteSet = new Set<string>(input.recent_routes || []);
  for (const nav of hints.recent_navigations) recentRouteSet.add(nav.route);

  // Infer a category bias from goals + preferences. Cheap keyword scan.
  const memoryText = [...hints.goals, ...hints.preferences, ...hints.recent_topics]
    .join(' ')
    .toLowerCase();

  const businessBias = /\b(income|earn|money|monetize|business|sell|verkaufen|verdienen|geld|einkommen|nebeneinkommen)\b/.test(memoryText);
  const healthBias = /\b(health|biology|biomarker|fitness|nutrition|gesundheit|biomarker|ernährung)\b/.test(memoryText);
  const communityBias = /\b(meet|event|meetup|community|treffen|veranstaltung|gemeinschaft)\b/.test(memoryText);

  return baseResults.map(r => {
    let adjusted = r.score;
    if (recentRouteSet.has(r.entry.route)) {
      adjusted -= 8; // soft penalty for recently visited
    }
    if (businessBias && (r.entry.category === 'business' || r.entry.category === 'wallet')) {
      adjusted += 6;
    }
    if (healthBias && r.entry.category === 'health') {
      adjusted += 6;
    }
    if (communityBias && r.entry.category === 'community') {
      adjusted += 4;
    }
    return { entry: r.entry, score: adjusted };
  }).sort((a, b) => b.score - a.score);
}

// =============================================================================
// Public API
// =============================================================================

export async function consultNavigator(
  input: NavigatorConsultInput
): Promise<NavigatorConsultResult> {
  const startTime = Date.now();

  // ── VTID-NAV-02: override-trigger shortcut ─────────────────────────────
  // Before running scoring, check if an admin has registered an exact-match
  // phrase override for this utterance in this tenant's catalog. If so, we
  // short-circuit with synthetic high confidence — this is the escape hatch
  // for "wrong screen" bugs the scorer can't fix through tuning.
  const tenantIdForOverride = input.identity?.tenant_id || null;
  const overrideMatch = isNavCatalogLoaded()
    ? findOverrideTriggerMatch(input.question, input.lang, tenantIdForOverride)
    : null;
  if (overrideMatch && !input.is_anonymous) {
    const pick = entryToPick(overrideMatch as NavCatalogEntry, input.lang);
    const explanation = buildExplanation({
      primary: pick,
      confidence: 'high',
      hints: EMPTY_HINTS,
      lang: input.lang,
    });
    return {
      confidence: 'high',
      primary: pick,
      explanation,
      confirmation_needed: false,
      kb_excerpts: staticKbAnchors(overrideMatch as NavCatalogEntry),
      top_picks: [pick],
      decision_source: 'override_trigger',
      ms_elapsed: Date.now() - startTime,
      catalog_match_count: 1,
      memory_hint_count: 0,
      kb_excerpt_count: 0,
    };
  }
  // Anonymous sessions + override triggers: fall through to normal flow so
  // anonymous_safe gating still applies (an admin-set override must not leak
  // an authenticated-only screen to unauthenticated sessions).
  const decisionSource: ConsultDecisionSource = isNavCatalogLoaded() ? 'scoring' : 'static_fallback';

  // ── VTID-NAV-FAST: Fast path for high-confidence direct matches ────────
  // Score the catalog FIRST (instant, in-memory) WITHOUT memory hints.
  // If the top result is a clear high-confidence winner, return immediately
  // and skip the 1-2s memory + KB network calls entirely. Only fall through
  // to the slow path for ambiguous or low-confidence queries where richer
  // context actually helps.
  const excludeRoutes: string[] = [];
  if (input.current_route) excludeRoutes.push(input.current_route);
  const fastScored = searchCatalog(input.question, input.lang, {
    anonymous_only: input.is_anonymous,
    exclude_routes: excludeRoutes,
  });
  const fastTop = fastScored[0];
  const fastSecond = fastScored[1];

  if (fastTop && fastTop.score >= CONSULT_CONFIG.HIGH_CONFIDENCE_MIN) {
    const ratio = fastSecond ? fastSecond.score / fastTop.score : 0;
    if (ratio < CONSULT_CONFIG.AMBIGUITY_RATIO) {
      // Clear winner — skip memory/KB, return instantly
      const pick = entryToPick(fastTop.entry, input.lang);
      const topPicks = fastScored.slice(0, 3).map(s => ({
        ...entryToPick(s.entry, input.lang),
        score: s.score,
      }));

      // Anonymous gating
      if (input.is_anonymous) {
        const entry = lookupScreen(pick.screen_id);
        if (entry && !entry.anonymous_safe) {
          return {
            confidence: 'low',
            primary: null,
            explanation: buildExplanation({ primary: null, confidence: 'low', blockedReason: 'requires_auth', hints: EMPTY_HINTS, lang: input.lang }),
            confirmation_needed: false,
            kb_excerpts: [],
            blocked_reason: 'requires_auth',
            top_picks: topPicks,
            decision_source: decisionSource,
            ms_elapsed: Date.now() - startTime,
            catalog_match_count: fastScored.length,
            memory_hint_count: 0,
            kb_excerpt_count: 0,
          };
        }
      }

      const explanation = buildExplanation({
        primary: pick,
        confidence: 'high',
        hints: EMPTY_HINTS,
        lang: input.lang,
      });

      console.log(`[VTID-NAV-FAST] Fast path: ${pick.screen_id} (score ${fastTop.score}) in ${Date.now() - startTime}ms — skipped memory/KB`);

      return {
        confidence: 'high',
        primary: pick,
        explanation,
        confirmation_needed: false,
        kb_excerpts: staticKbAnchors(fastTop.entry),
        top_picks: topPicks,
        decision_source: decisionSource,
        ms_elapsed: Date.now() - startTime,
        catalog_match_count: fastScored.length,
        memory_hint_count: 0,
        kb_excerpt_count: 0,
      };
    }
  }
  // ── End fast path — fall through to full consult with memory + KB ──────

  // Run memory hints + KB search in parallel — they're the slow parts.
  const [hints, runtimeKbExcerpts] = await Promise.all([
    fetchMemoryHints(input),
    fetchKnowledgeExcerpts(input.question),
  ]);

  // Score catalog with memory bias applied
  const scored = scoreCatalogWithMemory(input, hints);
  const top = scored[0];
  const second = scored[1];

  // VTID-NAV-02: build the top-3 picks payload for telemetry. Attach the raw
  // score so the admin Telemetry view can surface near-misses and the admin
  // Simulator can show the full ranking.
  const topPicks: NavigatorConsultPick[] = scored.slice(0, 3).map(s => ({
    ...entryToPick(s.entry, input.lang),
    score: s.score,
  }));

  // ── Bucket by confidence ────────────────────────────────────────────────
  let confidence: ConsultConfidence;
  let primary: NavigatorConsultPick | null = null;
  let alternative: NavigatorConsultPick | undefined;
  let confirmationNeeded = false;
  let suggestedQuestion: string | undefined;
  let blockedReason: NavigatorConsultResult['blocked_reason'];

  if (!top || top.score < CONSULT_CONFIG.MEDIUM_CONFIDENCE_MIN) {
    confidence = 'low';
    blockedReason = 'no_match';
  } else if (top.score >= CONSULT_CONFIG.HIGH_CONFIDENCE_MIN) {
    // Strong winner — but if 2nd is close, downgrade to medium
    const ratio = second ? second.score / top.score : 0;
    if (second && ratio >= CONSULT_CONFIG.AMBIGUITY_RATIO) {
      confidence = 'medium';
      confirmationNeeded = true;
      primary = entryToPick(top.entry, input.lang);
      alternative = entryToPick(second.entry, input.lang);
      suggestedQuestion = buildClarification(top.entry, second.entry, input.lang);
    } else {
      confidence = 'high';
      primary = entryToPick(top.entry, input.lang);
      if (second && second.score >= CONSULT_CONFIG.MEDIUM_CONFIDENCE_MIN) {
        alternative = entryToPick(second.entry, input.lang);
      }
    }
  } else {
    // medium
    confidence = 'medium';
    primary = entryToPick(top.entry, input.lang);
    if (second && second.score >= CONSULT_CONFIG.MEDIUM_CONFIDENCE_MIN) {
      alternative = entryToPick(second.entry, input.lang);
      // Only ask for confirmation if the alternatives are close
      if (second.score / top.score >= CONSULT_CONFIG.AMBIGUITY_RATIO) {
        confirmationNeeded = true;
        suggestedQuestion = buildClarification(top.entry, second.entry, input.lang);
      }
    }
  }

  // ── Anonymous gating: rewrite to registration prompt ────────────────────
  if (primary && input.is_anonymous) {
    const entry = lookupScreen(primary.screen_id);
    if (entry && !entry.anonymous_safe) {
      blockedReason = 'requires_auth';
      primary = null;
      alternative = undefined;
      confirmationNeeded = false;
      confidence = 'low';
    }
  }

  // ── Compose KB excerpts: static anchors + runtime hits, deduped ────────
  const staticAnchors = staticKbAnchors(top?.entry || null);
  const kbExcerpts: string[] = [];
  const seen = new Set<string>();
  for (const x of [...staticAnchors, ...runtimeKbExcerpts]) {
    if (kbExcerpts.length >= CONSULT_CONFIG.MAX_KB_EXCERPTS) break;
    const key = x.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kbExcerpts.push(x);
  }

  // ── Build the explanation Vitana speaks ────────────────────────────────
  const explanation = buildExplanation({
    primary,
    alternative,
    confidence,
    blockedReason,
    hints,
    lang: input.lang,
  });

  return {
    confidence,
    primary,
    alternative,
    explanation,
    confirmation_needed: confirmationNeeded,
    suggested_question: suggestedQuestion,
    kb_excerpts: kbExcerpts,
    blocked_reason: blockedReason,
    top_picks: topPicks,
    decision_source: decisionSource,
    ms_elapsed: Date.now() - startTime,
    catalog_match_count: scored.length,
    memory_hint_count:
      hints.goals.length + hints.preferences.length + hints.recent_topics.length,
    kb_excerpt_count: kbExcerpts.length,
  };
}

// =============================================================================
// Result formatting for the LLM tool response
// =============================================================================

/**
 * Render a NavigatorConsultResult as a deterministic, easy-to-read text
 * block that gets sent back to Gemini Live as the tool result. The
 * structure is intentionally rigid so the model has consistent parsing
 * cues turn over turn.
 */
export function formatConsultResultForLLM(result: NavigatorConsultResult): string {
  const lines: string[] = [];
  lines.push(`RECOMMENDATION: ${result.confidence}`);
  if (result.blocked_reason) {
    lines.push(`BLOCKED_REASON: ${result.blocked_reason}`);
  }
  if (result.primary) {
    lines.push(`PRIMARY: ${result.primary.screen_id} (${result.primary.route}) — ${result.primary.title}`);
  } else {
    lines.push('PRIMARY: none');
  }
  if (result.alternative) {
    lines.push(`ALTERNATIVE: ${result.alternative.screen_id} (${result.alternative.route}) — ${result.alternative.title}`);
  }
  lines.push(`CONFIRMATION_NEEDED: ${result.confirmation_needed}`);
  if (result.suggested_question) {
    lines.push(`SUGGESTED_QUESTION: ${result.suggested_question}`);
  }
  lines.push(`EXPLANATION: ${result.explanation}`);
  if (result.kb_excerpts.length > 0) {
    lines.push('KB_EXCERPTS:');
    result.kb_excerpts.forEach((x, i) => lines.push(`  [${i + 1}] ${x}`));
  }
  return lines.join('\n');
}

// =============================================================================
// Helpers
// =============================================================================

function entryToPick(entry: NavCatalogEntry, lang: LangCode): NavigatorConsultPick {
  const content = getContent(entry, lang);
  return {
    screen_id: entry.screen_id,
    route: entry.route,
    title: content.title,
  };
}

function buildClarification(
  a: NavCatalogEntry,
  b: NavCatalogEntry,
  lang: LangCode
): string {
  const ta = getContent(a, lang).title;
  const tb = getContent(b, lang).title;
  if (lang.startsWith('de')) {
    return `Soll ich dich zu ${ta} oder zu ${tb} bringen?`;
  }
  return `Should I take you to ${ta} or to ${tb}?`;
}

function buildExplanation(args: {
  primary: NavigatorConsultPick | null;
  alternative?: NavigatorConsultPick;
  confidence: ConsultConfidence;
  blockedReason?: NavigatorConsultResult['blocked_reason'];
  hints: MemoryHints;
  lang: LangCode;
}): string {
  const { primary, confidence, blockedReason, hints, lang } = args;
  const isDe = lang.startsWith('de');

  if (blockedReason === 'requires_auth') {
    return isDe
      ? 'Diese Funktion ist nur für angemeldete Mitglieder der Maxina Community verfügbar. Möchtest du, dass ich dich zur Registrierung führe?'
      : 'That feature is only available to signed-in members of the Maxina community. Would you like me to take you to registration?';
  }

  if (!primary || confidence === 'low') {
    return isDe
      ? 'Ich bin mir nicht ganz sicher, wo das ist. Kannst du mir etwas mehr Kontext geben, was du suchst?'
      : "I'm not entirely sure where that is. Can you tell me a bit more about what you're looking for?";
  }

  // Build a contextual lead — does the user have a relevant goal?
  let lead = '';
  if (hints.goals.length > 0) {
    const goalSnippet = hints.goals[0];
    lead = isDe
      ? `Du hast erwähnt, dass du an deinen Zielen arbeitest. `
      : `You mentioned working toward your goals. `;
    // Optionally include a short reference to the goal text
    void goalSnippet;
  }

  if (confidence === 'medium') {
    return isDe
      ? `${lead}Ich denke, ${primary.title} ist der richtige Ort dafür, aber ich frage lieber kurz nach.`
      : `${lead}I think ${primary.title} is the right place for that, but let me check with you first.`;
  }

  return isDe
    ? `${lead}${primary.title} ist der richtige Ort dafür. Ich bringe dich gleich dort hin.`
    : `${lead}${primary.title} is exactly where you want to go. Let me take you there.`;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// =============================================================================
// Navigator action memory write
// =============================================================================

/**
 * Persist a memory item recording that Vitana navigated the user to a
 * specific screen. Used by the navigate_to_screen tool handler in orb-live.
 * Fire-and-forget — caller does not await.
 *
 * Stored under category 'notes' with content_json.mode = 'navigator_action'
 * so the consult service can later retrieve and down-weight repeats without
 * polluting the system-prompt memory context (which the formatMemoryForPrompt
 * filter excludes by mode).
 */
export async function writeNavigatorActionMemory(args: {
  identity: NavigatorConsultIdentity;
  screen: NavigatorConsultPick;
  reason: string;
  decision_source: 'consult' | 'direct';
  orb_session_id: string;
  conversation_id?: string;
  lang: LangCode;
}): Promise<void> {
  const { identity, screen, reason, decision_source, orb_session_id, conversation_id } = args;
  const content = `Vitana navigated to ${screen.title} (${screen.route}) — ${reason}`;
  try {
    await writeMemoryItemWithIdentity(
      { user_id: identity.user_id, tenant_id: identity.tenant_id, active_role: identity.role },
      {
        source: 'orb_voice',
        content,
        category_key: 'notes',
        skipFiltering: true, // bypass the user/assistant trivial filter
        content_json: {
          direction: 'system',
          channel: 'orb',
          mode: 'navigator_action',
          action: 'navigate',
          screen_id: screen.screen_id,
          screen_title: screen.title,
          route: screen.route,
          reason,
          decision_source,
          lang: args.lang,
          orb_session_id,
          conversation_id,
        },
      }
    );
  } catch (err: any) {
    console.warn(`[VTID-NAV-CONSULT] Failed to write navigator action memory: ${err.message}`);
  }
}
