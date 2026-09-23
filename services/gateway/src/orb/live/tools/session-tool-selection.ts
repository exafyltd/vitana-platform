/**
 * VTID-04426 (Plan v1 WS-3.4) — tool choice per session.
 *
 * WHY. The per-provider catalog budget (VTID-04026 / VTID-04097) keeps a
 * fixed priority list and then fills the rest of the byte budget in catalog
 * order. Measured against the real authenticated community catalog, Nova
 * declares 43 of 291 tools and silently drops the other 248: the health
 * logs beyond water/sleep, the wallet, shopping, goals, diary history, and
 * `get_next_best_action` (WS-2.3). A user on the Wallet screen asking about
 * their balance reached a model that had no wallet tool at all.
 *
 * WHAT. Two things, both behind `ORB_TOOL_SELECTION_ENABLED` (exact 'true'):
 *
 *   1. Selection. The budget stays exactly as it is; only the ORDER the
 *      packer fills it in changes. First the two meta tools below, then the
 *      existing priority list, then `get_next_best_action`, then the tools
 *      that belong to the screen the session opened on (a small map from
 *      route to tool-name stems), then catalog order as before.
 *   2. Reach. Nova's tool list is fixed for the life of a stream (WS-3.1,
 *      VTID-04424: a second promptStart is rejected; ending the prompt ends
 *      the stream). So instead of adding declarations mid-session, two meta
 *      tools reach every tool the budget dropped:
 *        - `find_tool(query)` searches the dropped tools and returns their
 *          names, descriptions and parameters;
 *        - `use_tool(name, arguments_json)` runs one of them through the
 *          normal tool dispatcher (same timeouts, same auth, same handlers).
 *      Only tools that were in THIS session's catalog can be reached this
 *      way — the surface gating that built the catalog still applies.
 *
 * Pure except for the env read in `isToolSelectionEnabled`.
 */

export const TOOL_SELECTION_ENV = 'ORB_TOOL_SELECTION_ENABLED';
export const FIND_TOOL_NAME = 'find_tool';
export const USE_TOOL_NAME = 'use_tool';
export const FIND_TOOL_MAX_RESULTS = 6;
const DESCRIPTION_MAX_CHARS = 300;

export function isToolSelectionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[TOOL_SELECTION_ENV] === 'true';
}

/** Always kept right after the base priority list when selection is on. */
export const BRAIN_CORE_TOOLS: readonly string[] = ['get_next_best_action'];

/**
 * Screen → tool-name stems. A route matches a group when its first path
 * segment is one of the group's segments. A tool belongs to the group when
 * its name contains one of the stems. Stems are listed most important first:
 * the base priority list already uses ~58 of Nova's 64 KB, so only the first
 * few screen tools fit and the order decides which. Deliberately coarse:
 * this only decides the fill order; anything left out stays reachable
 * through find_tool.
 */
export const ROUTE_TOOL_GROUPS: ReadonlyArray<{ group: string; segments: readonly string[]; stems: readonly string[] }> = [
  { group: 'health', segments: ['health', 'vitals', 'longevity', 'biomarkers', 'lab', 'labs', 'vitana-index', 'index'], stems: ['log_meal', 'log_mood', 'log_vitals', 'lab_result', 'health_trend', 'health_streak', 'biomarker', 'health', 'lab_', 'condition', 'device', 'supplement', 'pillar', 'index'] },
  { group: 'wallet', segments: ['wallet', 'credits', 'rewards', 'earnings'], stems: ['wallet', 'payment', 'funds', 'reward', 'referral', 'commission', 'currency', 'exchange'] },
  { group: 'marketplace', segments: ['discover', 'shop', 'marketplace', 'products', 'services', 'store', 'cart'], stems: ['marketplace', 'product', 'cart', 'order', 'checkout', 'shopping', 'deal', 'discount', 'supplement', 'service', 'coach', 'doctor', 'provider'] },
  { group: 'community', segments: ['community', 'members', 'feed', 'groups', 'connect', 'matches', 'intents'], stems: ['member', 'follow', 'group', 'post', 'intent', 'match', 'news_feed', 'who_is', 'open_asks'] },
  { group: 'events', segments: ['events', 'meetups', 'live', 'live-rooms'], stems: ['event', 'meetup', 'rsvp', 'live_room', 'ticket', 'go_live', 'live_session'] },
  { group: 'messages', segments: ['messages', 'chat', 'inbox', 'conversations'], stems: ['conversation', 'message', 'chat', 'call'] },
  { group: 'calendar', segments: ['calendar', 'schedule', 'agenda'], stems: ['event', 'calendar', 'slot', 'reminder', 'alarm', 'timer', 'pomodoro'] },
  { group: 'memory', segments: ['diary', 'memory', 'memory-garden', 'journal'], stems: ['diary', 'memory', 'milestone', 'recall'] },
  { group: 'journey', segments: ['my-journey', 'journey', 'goals', 'autopilot', 'home', 'dashboard'], stems: ['goal', 'journey', 'autopilot', 'recommendation', 'checkpoint', 'index_improvement'] },
  { group: 'account', segments: ['profile', 'settings', 'account', 'subscription', 'billing'], stems: ['profile', 'privacy', 'visibility', 'block', 'language', 'theme', 'voice_preferences', 'connected_app', 'subscription', 'billing', 'voice_minutes'] },
];

export function routeToolGroups(route: string | null | undefined): string[] {
  if (!route || typeof route !== 'string') return [];
  const segs = route.split(/[?#]/)[0].split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (!segs.length) return [];
  // The first segment decides; a known second segment (e.g. /app/wallet) also counts.
  const probe = new Set(segs.slice(0, 2));
  return ROUTE_TOOL_GROUPS.filter((g) => g.segments.some((s) => probe.has(s))).map((g) => g.group);
}

type Declaration = { name?: unknown; description?: unknown; parameters?: unknown } & Record<string, unknown>;

function allDeclarations(tools: object[]): Declaration[] {
  const out: Declaration[] = [];
  for (const g of tools as Array<{ function_declarations?: unknown }>) {
    if (Array.isArray(g?.function_declarations)) out.push(...(g.function_declarations as Declaration[]));
  }
  return out;
}

/**
 * The fill order for the budget packer: meta tools, the base priority list,
 * the brain's core tools, then the current screen's tools ranked by stem.
 * Tools not named here follow in catalog order (the packer's own rule).
 */
export function buildSessionToolPriority(
  tools: object[],
  basePriority: readonly string[],
  route: string | null | undefined,
): { priority: string[]; groups: string[]; contextual: string[] } {
  const groups = routeToolGroups(route);
  const stems = ROUTE_TOOL_GROUPS.filter((g) => groups.includes(g.group)).flatMap((g) => g.stems);
  const head = [FIND_TOOL_NAME, USE_TOOL_NAME, ...basePriority, ...BRAIN_CORE_TOOLS];
  const seen = new Set(head);
  // Ranked by the first stem the name matches (stems are most important
  // first), then catalog order.
  const ranked: Array<{ name: string; rank: number; idx: number }> = [];
  if (stems.length) {
    allDeclarations(tools).forEach((d, idx) => {
      const name = typeof d.name === 'string' ? d.name : '';
      if (!name || seen.has(name)) return;
      const rank = stems.findIndex((st) => name.includes(st));
      if (rank >= 0) {
        ranked.push({ name, rank, idx });
        seen.add(name);
      }
    });
  }
  const contextual = ranked.sort((a, b) => a.rank - b.rank || a.idx - b.idx).map((r) => r.name);
  return { priority: [...head, ...contextual], groups, contextual };
}

/** The two meta-tool declarations (Gemini / Vertex `function_declarations` shape). */
export function buildMetaToolDeclarations(): Declaration[] {
  return [
    {
      name: FIND_TOOL_NAME,
      description:
        'Finds more tools for this conversation. Only the most relevant tools are listed directly; many more exist '
        + '(wallet, shopping, orders, goals, health logs, diary history, groups, live rooms, subscriptions, and others). '
        + 'When the user asks for something none of your listed tools can do, call find_tool first with a few English '
        + 'words describing the action, then call use_tool with the tool it returns. Never tell the user you cannot do '
        + 'something before you have tried find_tool.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A few English words describing the action, e.g. "wallet balance" or "log a meal".' },
        },
        required: ['query'],
      },
    },
    {
      name: USE_TOOL_NAME,
      description:
        'Runs a tool that find_tool returned. Pass its exact name and its arguments as a JSON object string that '
        + 'matches the parameters find_tool showed. Tools listed directly are called directly, not through use_tool.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The exact tool name find_tool returned.' },
          arguments_json: { type: 'string', description: 'The tool arguments as a JSON object string, e.g. {"limit":5}. Use {} when it takes none.' },
        },
        required: ['name'],
      },
    },
  ];
}

/** Adds the meta tools to the first declaration group (or a new one). Never mutates the input. */
export function withMetaTools(tools: object[]): object[] {
  const meta = buildMetaToolDeclarations();
  const out = (tools as Array<Record<string, unknown>>).map((g) => ({ ...g }));
  const first = out.find((g) => Array.isArray(g.function_declarations));
  if (first) {
    const existing = (first.function_declarations as Declaration[]).filter(
      (d) => d.name !== FIND_TOOL_NAME && d.name !== USE_TOOL_NAME,
    );
    first.function_declarations = [...meta, ...existing];
  } else {
    out.unshift({ function_declarations: meta });
  }
  return out;
}

/** Declarations the budget dropped, by name — what find_tool/use_tool may reach. */
export function deferredDeclarationMap(tools: object[], droppedNames: readonly string[]): Map<string, Declaration> {
  const want = new Set(droppedNames);
  const map = new Map<string, Declaration>();
  for (const d of allDeclarations(tools)) {
    const name = typeof d.name === 'string' ? d.name : '';
    if (name && want.has(name) && name !== FIND_TOOL_NAME && name !== USE_TOOL_NAME) map.set(name, d);
  }
  return map;
}

const STOPWORDS = new Set(['a', 'an', 'the', 'my', 'me', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'with', 'i', 'please', 'want', 'can', 'do', 'get', 'show', 'tool']);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

export interface FoundTool {
  name: string;
  description: string;
  parameters: unknown;
  score: number;
}

/** Ranks the deferred tools against a free-text query. Name hits weigh 3x description hits. */
export function searchDeferredTools(
  deferred: Map<string, Declaration>,
  query: string,
  limit: number = FIND_TOOL_MAX_RESULTS,
): FoundTool[] {
  const q = [...new Set(tokens(query || ''))];
  if (!q.length) return [];
  const scored: FoundTool[] = [];
  for (const [name, d] of deferred) {
    const nameToks = new Set(tokens(name));
    const descToks = new Set(tokens(typeof d.description === 'string' ? d.description : ''));
    let score = 0;
    let matched = 0;
    for (const t of q) {
      let hit = false;
      if (nameToks.has(t)) { score += 3; hit = true; } else if ([...nameToks].some((n) => n.startsWith(t) || t.startsWith(n))) { score += 2; hit = true; }
      if (descToks.has(t)) { score += 1; hit = true; }
      if (hit) matched += 1;
    }
    // A tool must match at least half of the query's words: one incidental
    // word ("last" in "wallet transactions last week") is not a match.
    if (score > 0 && matched >= Math.ceil(q.length / 2)) {
      scored.push({
        name,
        description: (typeof d.description === 'string' ? d.description : '').slice(0, DESCRIPTION_MAX_CHARS),
        parameters: d.parameters ?? { type: 'object', properties: {} },
        score,
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, Math.max(0, limit));
}

export type ToolCallResult = { success: boolean; result: string; error?: string };

/** find_tool: pure over the session's deferred map. */
export function runFindTool(deferred: Map<string, Declaration> | undefined, args: Record<string, unknown>): ToolCallResult {
  const query = typeof args.query === 'string' ? args.query.slice(0, 200) : '';
  if (!deferred || deferred.size === 0) {
    return { success: true, result: JSON.stringify({ tools: [], note: 'Every tool for this conversation is already listed directly. Call it directly.' }) };
  }
  const found = searchDeferredTools(deferred, query);
  if (!found.length) {
    return { success: true, result: JSON.stringify({ tools: [], note: 'No tool matched. Try other English words for the action, or tell the user plainly that this is not something you can do here.' }) };
  }
  return {
    success: true,
    result: JSON.stringify({
      tools: found.map(({ name, description, parameters }) => ({ name, description, parameters })),
      note: 'To run one, call use_tool with its exact name and arguments_json matching its parameters.',
    }),
  };
}

/**
 * use_tool: validates the call and returns the inner tool to run, or an error
 * result. The caller runs the inner tool through its normal dispatcher.
 */
export function resolveUseTool(
  deferred: Map<string, Declaration> | undefined,
  declaredNames: ReadonlySet<string> | undefined,
  args: Record<string, unknown>,
): { ok: true; name: string; args: Record<string, unknown> } | { ok: false; result: ToolCallResult } {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const fail = (error: string): { ok: false; result: ToolCallResult } => ({
    ok: false,
    result: { success: false, result: JSON.stringify({ error }), error },
  });
  if (!name) return fail('use_tool needs the exact tool name find_tool returned.');
  if (name === FIND_TOOL_NAME || name === USE_TOOL_NAME) return fail('use_tool cannot run find_tool or itself.');
  if (!deferred || !deferred.has(name)) {
    if (declaredNames?.has(name)) return fail(`${name} is listed directly; call ${name} directly instead of through use_tool.`);
    return fail(`${name} is not available in this conversation. Call find_tool to see what is.`);
  }
  let inner: Record<string, unknown> = {};
  const raw = args.arguments_json ?? args.arguments;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('arguments_json must be a JSON object.');
      inner = parsed as Record<string, unknown>;
    } catch {
      return fail('arguments_json is not valid JSON.');
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    inner = raw as Record<string, unknown>;
  }
  return { ok: true, name, args: inner };
}
