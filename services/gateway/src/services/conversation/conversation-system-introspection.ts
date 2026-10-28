/**
 * VTID-04525 (Conversation hub B1) — what the conversation system is made of,
 * built from the same code a live session runs.
 *
 * `GET /api/v1/admin/conversation/system` serves this. It is the Command Hub's
 * source for "what is live": every tool and where it is declared, how each
 * provider's byte budget trims the catalog, which opening providers are
 * registered, the greeting rungs, and every conversation flag. Because the
 * screen reads the builders themselves (`buildLiveApiTools`,
 * `enforceToolCatalogBudget`, the provider registry), a new tool, provider or
 * flag appears here without anyone editing the Command Hub.
 *
 * The picture only changes with a deploy or an env change, so it is cached per
 * process and rebuilt on demand. `fingerprint` hashes everything except the
 * timestamp; a build whose fingerprint differs from the previous one has
 * changed the conversation system (Overview shows the diff, plan §5.2).
 *
 * Reads only. No database, no network.
 */

import { createHash } from 'crypto';
import { buildLiveApiTools } from '../../orb/live/tools/live-tool-catalog';
import {
  enforceToolCatalogBudget,
  resolveToolCatalogByteBudgetFor,
  toolCatalogDeclarationBytes,
  VERTEX_BRIDGE_PRIORITY_TOOLS,
  FLAG_GATED_PRIORITY_TOOLS,
} from '../../orb/live/tools/vertex-tool-catalog-budget';
import {
  buildSessionToolPriority,
  withMetaTools,
  isToolSelectionEnabled,
  ROUTE_TOOL_GROUPS,
} from '../../orb/live/tools/session-tool-selection';
import type { OrbSurface } from '../../orb/live/surface';
import { classifyOrbTool, type ToolCapability } from '../orchestrator/tool-catalog';
import { ORB_TOOL_NAMES } from '../orb-tools-shared';
import { defaultProviderRegistry } from '../assistant-continuation/provider-registry';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../assistant-continuation/decide-continuation';
import { ensureWakeBriefProviderRegistered, EXPLICIT_SELECTION_PROVIDER_TIMEOUT_MS } from '../wake-brief-wiring';
import { SCORED_OPENING_PINNED_PROVIDERS } from './scored-opening';
import { WAKE_OPENERS, wakeOpenerRungSwitches } from './compute-greeting-decision';
import { resolveConversationFlags, conversationFlagNotes, type ResolvedConversationFlag } from './conversation-flag-registry';

/**
 * The surface × role combinations a real session can have. Each is the exact
 * argument set `buildLiveApiTools` receives for such a session.
 */
export const INTROSPECTION_SESSIONS: ReadonlyArray<{
  key: string;
  mode: 'anonymous' | 'authenticated';
  surface: OrbSurface;
  role: string;
  route: string;
}> = [
  // Landing routes declare no tools on purpose (VTID-NAV-ANON-FIX); any other
  // route is a signed-in member whose token expired, who gets the navigator.
  { key: 'anonymous_landing', mode: 'anonymous', surface: 'vitanaland', role: 'community', route: '/' },
  { key: 'anonymous_app_page', mode: 'anonymous', surface: 'vitanaland', role: 'community', route: '/community' },
  { key: 'community', mode: 'authenticated', surface: 'vitanaland', role: 'community', route: '/' },
  { key: 'developer_on_vitanaland', mode: 'authenticated', surface: 'vitanaland', role: 'developer', route: '/' },
  { key: 'command_hub', mode: 'authenticated', surface: 'command-hub', role: 'developer', route: '/command-hub' },
  { key: 'admin', mode: 'authenticated', surface: 'admin', role: 'admin', route: '/admin' },
  { key: 'backoffice', mode: 'authenticated', surface: 'backoffice', role: 'admin', route: '/backoffice' },
  { key: 'commerce', mode: 'authenticated', surface: 'commerce', role: 'community', route: '/commerce' },
];

/** The upstreams that apply a tool-catalog byte budget (VTID-04097). */
const BUDGETED_PROVIDERS = ['nova_sonic', 'vertex'] as const;

export interface SessionCatalogView {
  key: string;
  mode: string;
  surface: string;
  role: string;
  route: string;
  declared: number;
  bytes: number;
  /** Per budgeted provider: what survives the budget at session start on this route. */
  budget: Record<string, {
    budget_bytes: number;
    trimmed: boolean;
    declared_after: number;
    bytes_after: number;
    dropped: number;
    /** With ORB_TOOL_SELECTION_ENABLED: dropped tools stay reachable via find_tool / use_tool. */
    reachable_via_find_tool: boolean;
  }>;
}

export interface ToolView extends ToolCapability {
  name: string;
  /** Session keys (INTROSPECTION_SESSIONS) whose catalog declares the tool. */
  declared_on: string[];
  /** Session keys where the Nova budget drops it from the setup. */
  trimmed_on_nova: string[];
  /** In the base keep-first list (VERTEX_BRIDGE_PRIORITY_TOOLS / FLAG_GATED_PRIORITY_TOOLS). */
  priority: boolean;
  /** Screen groups (ROUTE_TOOL_GROUPS) whose routes pull the tool forward when selection is on. */
  route_groups: string[];
  /** Has an ORB_TOOL_REGISTRY handler (community tools); admin/dev/backoffice tools are dispatched elsewhere. */
  in_orb_registry: boolean;
}

export interface ConversationSystemSnapshot {
  generated_at: string;
  fingerprint: string;
  build: { commit: string | null };
  tools: {
    total: number;
    orb_registry_total: number;
    by_domain_tier: Record<string, Record<string, number>>;
    sessions: SessionCatalogView[];
    items: ToolView[];
    warnings: {
      /** Classified only by the fallback rule — nobody decided its tier. */
      unclassified: string[];
      /** In ORB_TOOL_REGISTRY but declared on no surface. */
      declared_nowhere: string[];
      /**
       * Declared somewhere, but the Nova budget drops it from the setup on every
       * session that declares it. With ORB_TOOL_SELECTION_ENABLED such a tool is
       * still reachable through find_tool / use_tool; without it, never.
       */
      trimmed_everywhere: string[];
    };
    selection_enabled: boolean;
  };
  opening: {
    providers: Array<{ key: string; surfaces: string[]; pinned: boolean }>;
    ambient_timeout_ms: number;
    explicit_selection_timeout_ms: number;
    rungs: Array<{ name: string; switch: boolean | null }>;
  };
  flags: ResolvedConversationFlag[];
  flag_notes: Record<string, string>;
}

type Decl = { name?: unknown };
type Group = { function_declarations?: unknown };

function declaredNames(tools: object[]): string[] {
  const out: string[] = [];
  for (const g of tools as Group[]) {
    if (!Array.isArray(g.function_declarations)) continue;
    for (const d of g.function_declarations as Decl[]) if (typeof d?.name === 'string') out.push(d.name);
  }
  return out;
}

/** The budget as a live session applies it, including context selection when it is on. */
function packFor(catalog: object[], budgetBytes: number, route: string) {
  const base = [...VERTEX_BRIDGE_PRIORITY_TOOLS, ...FLAG_GATED_PRIORITY_TOOLS];
  let result = enforceToolCatalogBudget(catalog, budgetBytes);
  let selection = false;
  if (result.trimmed && isToolSelectionEnabled()) {
    const sel = buildSessionToolPriority(catalog, base, route);
    const selected = enforceToolCatalogBudget(withMetaTools(catalog), budgetBytes, sel.priority);
    const names = new Set(declaredNames(selected.tools));
    if (names.has('find_tool') && names.has('use_tool')) {
      result = selected;
      selection = true;
    }
  }
  return { result, selection };
}

export function buildConversationSystemSnapshot(now: Date = new Date()): ConversationSystemSnapshot {
  ensureWakeBriefProviderRegistered();

  const priority = new Set<string>([...VERTEX_BRIDGE_PRIORITY_TOOLS, ...FLAG_GATED_PRIORITY_TOOLS]);
  const declaredOn = new Map<string, string[]>();
  const trimmedOnNova = new Map<string, string[]>();
  const sessions: SessionCatalogView[] = [];

  for (const s of INTROSPECTION_SESSIONS) {
    const catalog = buildLiveApiTools(s.mode, s.route, s.role, s.surface) as object[];
    const names = declaredNames(catalog);
    for (const n of names) {
      if (!declaredOn.has(n)) declaredOn.set(n, []);
      declaredOn.get(n)!.push(s.key);
    }
    const budget: SessionCatalogView['budget'] = {};
    for (const provider of BUDGETED_PROVIDERS) {
      const { budgetBytes } = resolveToolCatalogByteBudgetFor(provider);
      const { result, selection } = packFor(catalog, budgetBytes, s.route);
      budget[provider] = {
        budget_bytes: budgetBytes,
        trimmed: result.trimmed,
        declared_after: result.declarationsAfter,
        bytes_after: result.bytesAfter,
        dropped: result.dropped.length,
        reachable_via_find_tool: selection,
      };
      if (provider === 'nova_sonic') {
        for (const n of result.dropped) {
          if (!trimmedOnNova.has(n)) trimmedOnNova.set(n, []);
          trimmedOnNova.get(n)!.push(s.key);
        }
      }
    }
    sessions.push({
      key: s.key, mode: s.mode, surface: s.surface, role: s.role, route: s.route,
      declared: names.length,
      bytes: toolCatalogDeclarationBytes(catalog),
      budget,
    });
  }

  const orbRegistry = new Set(ORB_TOOL_NAMES);
  const allNames = [...new Set([...declaredOn.keys(), ...orbRegistry])].sort();
  const groupsByTool = new Map<string, string[]>();
  for (const g of ROUTE_TOOL_GROUPS) {
    for (const n of allNames) {
      if (g.stems.some((stem) => n.includes(stem))) {
        if (!groupsByTool.has(n)) groupsByTool.set(n, []);
        groupsByTool.get(n)!.push(g.group);
      }
    }
  }

  const items: ToolView[] = allNames.map((name) => ({
    name,
    ...classifyOrbTool(name),
    declared_on: declaredOn.get(name) ?? [],
    trimmed_on_nova: trimmedOnNova.get(name) ?? [],
    priority: priority.has(name),
    route_groups: groupsByTool.get(name) ?? [],
    in_orb_registry: orbRegistry.has(name),
  }));

  const byDomainTier: Record<string, Record<string, number>> = {};
  for (const t of items) {
    byDomainTier[t.domain] = byDomainTier[t.domain] || {};
    byDomainTier[t.domain][t.tier] = (byDomainTier[t.domain][t.tier] || 0) + 1;
  }

  const warnings = {
    unclassified: items.filter((t) => t.source === 'default').map((t) => t.name),
    declared_nowhere: items.filter((t) => t.in_orb_registry && t.declared_on.length === 0).map((t) => t.name),
    trimmed_everywhere: items
      .filter((t) => t.declared_on.length > 0 && t.trimmed_on_nova.length === t.declared_on.length)
      .map((t) => t.name),
  };

  const switches = wakeOpenerRungSwitches();
  const rungs = WAKE_OPENERS.map((name) => ({
    name,
    switch: name === 'newday_overview' ? switches.newday_overview : name === 'day_close' ? switches.day_close : null,
  }));

  const providers = defaultProviderRegistry.list().map((key) => {
    const p = defaultProviderRegistry.get(key)!;
    return { key, surfaces: [...p.surfaces], pinned: SCORED_OPENING_PINNED_PROVIDERS.has(key) };
  });

  const flags = resolveConversationFlags();

  const body = {
    tools: {
      total: items.length,
      orb_registry_total: orbRegistry.size,
      by_domain_tier: byDomainTier,
      sessions,
      items,
      warnings,
      selection_enabled: isToolSelectionEnabled(),
    },
    opening: {
      providers,
      ambient_timeout_ms: DEFAULT_PROVIDER_TIMEOUT_MS,
      explicit_selection_timeout_ms: EXPLICIT_SELECTION_PROVIDER_TIMEOUT_MS,
      rungs,
    },
    flags,
    flag_notes: conversationFlagNotes(),
  };

  return {
    generated_at: now.toISOString(),
    fingerprint: fingerprintOf(body),
    build: { commit: process.env.GIT_COMMIT_SHA || process.env.COMMIT_SHA || null },
    ...body,
  };
}

/** Stable hash of the snapshot body (key order independent of insertion order). */
export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Per-process cache. The picture changes only with a deploy or an env change.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache: { at: number; snapshot: ConversationSystemSnapshot } | null = null;

export function getConversationSystemSnapshot(opts: { refresh?: boolean; now?: () => number } = {}): ConversationSystemSnapshot {
  const now = opts.now ? opts.now() : Date.now();
  if (!opts.refresh && _cache && now - _cache.at < CACHE_TTL_MS) return _cache.snapshot;
  const snapshot = buildConversationSystemSnapshot(new Date(now));
  _cache = { at: now, snapshot };
  return snapshot;
}

/** Tests only. */
export function _resetConversationSystemSnapshotCache(): void {
  _cache = null;
}

/** Diff two snapshots for the Overview "what changed since the last build" line. */
export function diffConversationSystems(prev: Pick<ConversationSystemSnapshot, 'tools' | 'opening' | 'flags'>, next: Pick<ConversationSystemSnapshot, 'tools' | 'opening' | 'flags'>) {
  const names = (s: typeof prev) => new Set(s.tools.items.map((t) => t.name));
  const prov = (s: typeof prev) => new Set(s.opening.providers.map((p) => p.key));
  const a = names(prev);
  const b = names(next);
  const pa = prov(prev);
  const pb = prov(next);
  const flagVal = (s: typeof prev) => new Map(s.flags.map((f) => [f.name, JSON.stringify(f.effective)]));
  const fa = flagVal(prev);
  const fb = flagVal(next);
  return {
    tools_added: [...b].filter((n) => !a.has(n)).sort(),
    tools_removed: [...a].filter((n) => !b.has(n)).sort(),
    providers_added: [...pb].filter((n) => !pa.has(n)).sort(),
    providers_removed: [...pa].filter((n) => !pb.has(n)).sort(),
    flags_changed: [...fb.keys()].filter((k) => fa.has(k) && fa.get(k) !== fb.get(k)).sort(),
  };
}


// ---------------------------------------------------------------------------
// Per-build snapshot event (plan §5.2). Recorded once per stack when the
// fingerprint differs from the last recorded one for the same env, so it is a
// state transition ("this build changed the conversation system"), never a
// heartbeat. The compact lists let the next build compute a diff.
// ---------------------------------------------------------------------------

export interface SnapshotEventPayload {
  fingerprint: string;
  commit: string | null;
  env: string;
  tool_names: string[];
  provider_keys: string[];
  flag_values: Record<string, string>;
  counts: { tools: number; providers: number; flags: number; warnings: Record<string, number> };
  diff: ReturnType<typeof diffConversationSystems> | null;
}

export function snapshotEventPayload(
  snap: ConversationSystemSnapshot,
  env: string,
  previous: Pick<SnapshotEventPayload, 'tool_names' | 'provider_keys' | 'flag_values'> | null,
): SnapshotEventPayload {
  const tool_names = snap.tools.items.map((t) => t.name);
  const provider_keys = snap.opening.providers.map((p) => p.key);
  const flag_values = Object.fromEntries(snap.flags.map((f) => [f.name, JSON.stringify(f.effective)]));
  const asSystem = (p: Pick<SnapshotEventPayload, 'tool_names' | 'provider_keys' | 'flag_values'>) => ({
    tools: { items: p.tool_names.map((name) => ({ name })) },
    opening: { providers: p.provider_keys.map((key) => ({ key })) },
    flags: Object.entries(p.flag_values).map(([name, v]) => ({ name, effective: v })),
  }) as unknown as Pick<ConversationSystemSnapshot, 'tools' | 'opening' | 'flags'>;
  return {
    fingerprint: snap.fingerprint,
    commit: snap.build.commit,
    env,
    tool_names,
    provider_keys,
    flag_values,
    counts: {
      tools: tool_names.length,
      providers: provider_keys.length,
      flags: snap.flags.length,
      warnings: Object.fromEntries(Object.entries(snap.tools.warnings).map(([k, v]) => [k, v.length])),
    },
    diff: previous ? diffConversationSystems(asSystem(previous), asSystem({ tool_names, provider_keys, flag_values })) : null,
  };
}

export interface SnapshotRecorderDeps {
  env: string;
  readLatest: (env: string) => Promise<Pick<SnapshotEventPayload, 'fingerprint' | 'tool_names' | 'provider_keys' | 'flag_values'> | null>;
  emit: (payload: SnapshotEventPayload) => Promise<{ ok: boolean; error?: string }>;
  build?: () => ConversationSystemSnapshot;
}

/** Returns what happened; never throws. */
export async function recordConversationSystemSnapshot(deps: SnapshotRecorderDeps): Promise<{ recorded: boolean; reason: string; fingerprint?: string }> {
  try {
    const snap = (deps.build ?? (() => getConversationSystemSnapshot({ refresh: true })))();
    const latest = await deps.readLatest(deps.env);
    if (latest && latest.fingerprint === snap.fingerprint) return { recorded: false, reason: 'unchanged', fingerprint: snap.fingerprint };
    const payload = snapshotEventPayload(snap, deps.env, latest && Array.isArray(latest.tool_names) ? latest : null);
    const res = await deps.emit(payload);
    return res.ok
      ? { recorded: true, reason: latest ? 'changed' : 'first', fingerprint: snap.fingerprint }
      : { recorded: false, reason: `emit_failed: ${res.error ?? 'unknown'}`, fingerprint: snap.fingerprint };
  } catch (e) {
    return { recorded: false, reason: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
