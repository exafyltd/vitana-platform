/**
 * VTID-04026 — byte budget for the tool catalog the Vertex Serbian bridge
 * declares in its `setup` envelope.
 *
 * WHY THIS EXISTS. Authenticated Serbian sessions on the Vertex bridge
 * (VTID-04000) closed with `upstream_ws_close code:1007 "Request contains an
 * invalid argument."` on ~80% of sessions — never at setup (`setup_complete`
 * always arrived) but ~300 ms after the FIRST generation request (the greeting
 * `client_content`, or the user's first utterance on the sessions whose
 * greeting happened to survive). Anonymous sessions never failed. Three
 * greeting-directive rewordings (VTID-04010/04014/04015) did not move the
 * rate. Measured on 2026-09-17: an authenticated community-surface session
 * declares 290 function declarations = 226 KB of JSON (65 "core" tools =
 * 96 KB, 225 domain tools = 130 KB) on top of a ~30 KB system instruction,
 * while an anonymous session declares 2 (4.9 KB). A controlled live run of
 * the SAME account, SAME language, SAME deployment with only the ORB surface
 * changed to `/admin` (134 declarations, 45 KB) produced zero 1007 closes.
 * `live-system-instruction.ts` records the identical failure shape from the
 * pre-shutdown era ("a code=1007 'invalid argument' close on the very first
 * client_content send (setup itself is accepted)") when the aggregate
 * instruction grew past what Gemini Live accepts — the instruction has had a
 * byte guard since (`instruction-budget.ts`); the tool catalog, which is now
 * 7x that guard's whole budget, never did.
 *
 * WHAT IT DOES. A pure, deterministic first-fit packer over the catalog's
 * `function_declarations`: every tool named in {@link VERTEX_BRIDGE_PRIORITY_TOOLS}
 * is kept first, in that order (navigation, ending the conversation, memory,
 * diary, reminders, the guided-journey / teacher flow, persona hand-off,
 * calendar, messaging, the daily logs); the remaining declarations are then
 * added in their original catalog order while they fit. Non-declaration
 * groups (`google_search` grounding) pass through untouched. Nothing here
 * inspects the model, the language, or the session — the CALLER decides
 * when to apply it (orb-live.ts applies it only when
 * `session.upstreamProvider === 'vertex'`; Nova Sonic and the cascade keep
 * the full catalog exactly as before).
 *
 * WHY A BYTE BUDGET AND NOT A TOKEN COUNT. The gateway has no Gemini
 * tokenizer; UTF-8 bytes of the wire JSON are what the socket actually
 * carries and are what `instruction-budget.ts` already budgets, so the two
 * guards compose (instruction ≤ 30 KB, tools ≤ this budget). The default is
 * deliberately inside the range measured to work (45 KB on the admin
 * surface), not extrapolated from a documented limit — none is documented
 * for this failure. `VERTEX_TOOL_CATALOG_BYTE_BUDGET` overrides it per task
 * definition so the ceiling can be raised on staging once a larger value is
 * observed to hold; `0` disables the guard entirely (full catalog again).
 */

export const VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT = 48 * 1024;

export const VERTEX_TOOL_CATALOG_BYTE_BUDGET_ENV = 'VERTEX_TOOL_CATALOG_BYTE_BUDGET';

/**
 * Kept first, in this order, when the catalog must be trimmed. Names not
 * present in a given catalog are simply skipped (the anonymous catalog has
 * two of these; the admin/backoffice surfaces have their own allowlists).
 */
export const VERTEX_BRIDGE_PRIORITY_TOOLS: readonly string[] = [
  // Navigation + session lifecycle
  'get_current_screen',
  'navigate',
  'navigate_to_screen',
  'end_conversation',
  'search_knowledge',
  // Memory / diary / reminders
  'search_memory',
  'save_diary_entry',
  'set_reminder',
  'find_reminders',
  'delete_reminder',
  // Guided journey / teacher flow (My Journey taps depend on these)
  'narrate_guided_session',
  'record_journey_answer',
  'teacher_event',
  'end_teaching_session',
  'end_guided_topic_teaching',
  // Persona hand-off
  'switch_persona',
  'report_to_specialist',
  // Day / calendar
  'get_day_summary',
  'get_schedule',
  'search_calendar',
  'create_calendar_event',
  'add_to_calendar',
  // Community / messaging
  'search_events',
  'search_community',
  'find_community_member',
  'view_messages',
  'send_chat_message',
  'resolve_recipient',
  // Daily logs / index
  'log_water',
  'log_sleep',
  'log_exercise',
  'log_meditation',
  'get_pillar_subscores',
  'get_vitana_index',
  'explain_feature',
];

export interface ToolCatalogBudgetResult {
  /** The catalog to send. Same array instance as the input when nothing was trimmed. */
  tools: object[];
  trimmed: boolean;
  budgetBytes: number;
  declarationsBefore: number;
  declarationsAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Names dropped, in catalog order. */
  dropped: string[];
}

type Declaration = { name?: unknown } & Record<string, unknown>;
type Group = { function_declarations?: unknown } & Record<string, unknown>;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function declarationsOf(group: Group): Declaration[] | null {
  return Array.isArray(group.function_declarations) ? (group.function_declarations as Declaration[]) : null;
}

/** Total UTF-8 bytes of every `function_declarations` array in the catalog. */
export function toolCatalogDeclarationBytes(tools: object[]): number {
  let total = 0;
  for (const group of tools as Group[]) {
    const decls = declarationsOf(group);
    if (decls) total += jsonBytes(decls);
  }
  return total;
}

/** Count of function declarations across every group. */
export function toolCatalogDeclarationCount(tools: object[]): number {
  let n = 0;
  for (const group of tools as Group[]) {
    const decls = declarationsOf(group);
    if (decls) n += decls.length;
  }
  return n;
}

/**
 * Resolve the budget from the environment. Unset / unparsable → the default;
 * `0` or a negative number → 0, meaning "disabled" (callers must skip the
 * guard when the budget is 0 — {@link enforceToolCatalogBudget} also returns
 * the input untouched in that case, so either check is safe).
 */
export function resolveVertexToolCatalogByteBudget(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = (env[VERTEX_TOOL_CATALOG_BYTE_BUDGET_ENV] || '').trim();
  if (raw === '') return VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT;
  return n <= 0 ? 0 : Math.floor(n);
}

/**
 * Trim `tools` so its function declarations total at most `budgetBytes`
 * (UTF-8 bytes of each group's `function_declarations` JSON). Pure: never
 * mutates the input; returns the same array instance when nothing changes.
 */
export function enforceToolCatalogBudget(
  tools: object[],
  budgetBytes: number,
  priority: readonly string[] = VERTEX_BRIDGE_PRIORITY_TOOLS,
): ToolCatalogBudgetResult {
  const declarationsBefore = toolCatalogDeclarationCount(tools);
  const bytesBefore = toolCatalogDeclarationBytes(tools);
  const unchanged: ToolCatalogBudgetResult = {
    tools,
    trimmed: false,
    budgetBytes,
    declarationsBefore,
    declarationsAfter: declarationsBefore,
    bytesBefore,
    bytesAfter: bytesBefore,
    dropped: [],
  };
  if (!Array.isArray(tools) || !Number.isFinite(budgetBytes) || budgetBytes <= 0) return unchanged;
  if (bytesBefore <= budgetBytes) return unchanged;

  // Each group's array carries its own `[]` + separators on the wire; charge
  // 2 bytes per group and 1 byte per separator so `bytesAfter` is the real
  // JSON size, never an under-count.
  let remaining = budgetBytes;
  const dropped: string[] = [];
  const out: object[] = [];
  const priorityRank = new Map<string, number>();
  priority.forEach((name, i) => priorityRank.set(name, i));

  for (const group of tools as Group[]) {
    const decls = declarationsOf(group);
    if (!decls) {
      out.push(group);
      continue;
    }
    remaining -= 2;
    // Priority first (in priority order), then the rest in catalog order.
    const ordered = decls
      .map((d, idx) => ({ d, idx, rank: priorityRank.get(String(d?.name ?? '')) }))
      .sort((a, b) => {
        const ar = a.rank ?? Number.POSITIVE_INFINITY;
        const br = b.rank ?? Number.POSITIVE_INFINITY;
        return ar === br ? a.idx - b.idx : ar - br;
      });
    const keptIdx = new Set<number>();
    let keptCount = 0;
    for (const { d, idx } of ordered) {
      const cost = jsonBytes(d) + (keptCount > 0 ? 1 : 0);
      if (cost <= remaining) {
        remaining -= cost;
        keptIdx.add(idx);
        keptCount += 1;
      }
    }
    // Emit in ORIGINAL catalog order so relative ordering the model sees is
    // stable across sessions regardless of what was dropped.
    const kept: Declaration[] = [];
    decls.forEach((d, idx) => {
      if (keptIdx.has(idx)) kept.push(d);
      else dropped.push(String(d?.name ?? `#${idx}`));
    });
    if (kept.length > 0) out.push({ ...group, function_declarations: kept });
  }

  return {
    tools: out,
    trimmed: true,
    budgetBytes,
    declarationsBefore,
    declarationsAfter: toolCatalogDeclarationCount(out),
    bytesBefore,
    bytesAfter: toolCatalogDeclarationBytes(out),
    dropped,
  };
}
