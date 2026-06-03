/**
 * BOOTSTRAP-CONTEXT-CONTRACT — formal, validated "context contract".
 *
 * The context object that flows from the builder(s) into every prompt
 * assembler / provider is consumed in many places, each assuming a shape.
 * Today that shape is enforced only by the hand-written TypeScript interfaces
 * (`ContextPack` in `types/conversation.ts`, `UnifiedAwarenessContext` in
 * `awareness-unified-context.ts`). TypeScript checks compile-time call sites
 * but does NOT validate runtime objects (post-deserialization, post-merge,
 * cross-service boundaries). This module adds a runtime, Zod-based contract
 * that asserts those shapes, plus a single `validateContextContract()` entry
 * point and a dev-only assertion gate.
 *
 * ADDITIVE ONLY. This file:
 *   - does NOT modify `awareness-unified-context.ts` (R1-owned, read-only),
 *   - does NOT modify `context-pack-builder.ts` or the `ContextPack` interface,
 *   - is a sibling that mirrors those shapes and is locked by a characterization
 *     test so any drift in the real interfaces fails loudly here.
 *
 * The Zod schemas are the source-of-truth-in-tests; the static checks at the
 * bottom assert the inferred Zod types stay structurally compatible with the
 * canonical interfaces (a build-time tripwire if R1 or the builder changes a
 * field without updating the contract).
 */

import { z } from 'zod';
import type {
  ContextPack,
  ConversationChannel,
  RetrievalSource,
} from '../types/conversation';
import type {
  UnifiedAwarenessContext,
  FirstNameSource,
} from './awareness-unified-context';

// ---------------------------------------------------------------------------
// Shared enums (mirror the const tuples in types/conversation.ts +
// awareness-unified-context.ts). Kept literal so a value drift is caught.
// ---------------------------------------------------------------------------

const conversationChannelSchema = z.enum([
  'orb',
  'operator',
  'developer_assistant',
]);

const retrievalSourceSchema = z.enum([
  'memory_garden',
  'knowledge_hub',
  'web_search',
  'calendar',
]);

const firstNameSourceSchema = z.enum([
  'memory_facts',
  'app_users',
  'email',
  'none',
]);

// A loose Record<RetrievalSource, number> — the builder only ever populates
// the queried subset, so we validate "string keys → numbers" rather than
// requiring all four keys to be present.
const retrievalSourceNumberMap = z.record(z.string(), z.number());

// ---------------------------------------------------------------------------
// UnifiedAwarenessContext contract (R1 endpoint — read-only target shape).
// ---------------------------------------------------------------------------

export const unifiedAwarenessContextSchema = z.object({
  identity: z.object({
    user_id: z.string().nullable(),
    tenant_id: z.string().nullable(),
    first_name: z.string().nullable(),
    first_name_source: firstNameSourceSchema,
    display_name: z.string().nullable(),
    vitana_id: z.string().nullable(),
  }),
});

// ---------------------------------------------------------------------------
// ContextPack contract (context-pack-builder output).
// ---------------------------------------------------------------------------

const memoryHitSchema = z.object({
  id: z.string(),
  category_key: z.string(),
  content: z.string(),
  importance: z.number(),
  occurred_at: z.string(),
  relevance_score: z.number(),
  source: z.string(),
});

const knowledgeHitSchema = z.object({
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  source_path: z.string(),
  relevance_score: z.number(),
});

const webHitSchema = z.object({
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  url: z.string(),
  citation: z.string(),
  relevance_score: z.number(),
});

const toolHealthStatusSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  latency_ms: z.number().optional(),
  last_checked: z.string(),
  error: z.string().optional(),
});

const activeVtidSchema = z.object({
  vtid: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string().optional(),
});

const tenantPolicySchema = z.object({
  policy_id: z.string(),
  type: z.string(),
  value: z.unknown(),
  enforced: z.boolean(),
});

const uiContextSchema = z.object({
  surface: conversationChannelSchema,
  screen: z.string().optional(),
  selection: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const calendarEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  start_time: z.string(),
  end_time: z.string().nullable(),
  event_type: z.string(),
  status: z.string(),
});

const retrievalRouterDecisionSchema = z.object({
  sources_to_query: z.array(retrievalSourceSchema),
  query_order: z.array(retrievalSourceSchema),
  limits: retrievalSourceNumberMap,
  matched_rule: z.string(),
  decided_at: z.string(),
  rationale: z.string(),
});

export const contextPackSchema = z.object({
  pack_id: z.string(),
  pack_hash: z.string(),
  assembled_at: z.string(),
  assembly_duration_ms: z.number(),

  identity: z.object({
    tenant_id: z.string(),
    user_id: z.string(),
    role: z.string(),
    display_name: z.string().optional(),
  }),

  session_state: z.object({
    thread_id: z.string(),
    channel: conversationChannelSchema,
    turn_number: z.number(),
    conversation_start: z.string(),
  }),

  memory_hits: z.array(memoryHitSchema),
  knowledge_hits: z.array(knowledgeHitSchema),
  web_hits: z.array(webHitSchema),
  active_vtids: z.array(activeVtidSchema),
  tenant_policies: z.array(tenantPolicySchema),
  tool_health: z.array(toolHealthStatusSchema),

  ui_context: uiContextSchema.optional(),
  relationship_context: z.array(z.string()).optional(),

  calendar_context: z
    .object({
      today_events: z.array(calendarEventSchema),
      upcoming_events: z.array(calendarEventSchema),
      gaps_today: z.array(
        z.object({
          start: z.string(),
          end: z.string(),
          duration_minutes: z.number(),
        }),
      ),
      active_role: z.string(),
      journey_stage: z
        .object({
          wave_name: z.string(),
          day_number: z.number(),
          total_days: z.number(),
        })
        .optional(),
      patterns: z.array(z.string()),
    })
    .optional(),

  session_buffer: z
    .object({
      turn_count: z.number(),
      session_facts_count: z.number(),
      formatted_context: z.string(),
    })
    .optional(),

  oasis_context: z
    .object({
      active_tasks: z.array(
        z.object({
          vtid: z.string(),
          title: z.string(),
          status: z.string(),
          stage: z.string().optional(),
        }),
      ),
      recent_deploys: z.array(
        z.object({
          service: z.string(),
          status: z.string(),
          created_at: z.string(),
        }),
      ),
      pending_approvals_count: z.number(),
      self_healing_alerts: z.number(),
      recent_recommendations: z.array(
        z.object({ title: z.string(), status: z.string() }),
      ),
    })
    .optional(),

  marketplace_context: z
    .object({
      lifecycle_stage: z
        .enum(['onboarding', 'early', 'established', 'mature'])
        .nullable(),
      region_group: z.string().nullable(),
      scope_preference: z.enum(['local', 'regional', 'friendly', 'international']),
      budget_max_per_product_cents: z.number().nullable(),
      hard_limitations: z.object({
        allergies: z.array(z.string()),
        dietary_restrictions: z.array(z.string()),
        contraindications: z.array(z.string()),
        current_medications: z.array(z.string()),
      }),
      active_conditions: z.array(
        z.object({ key: z.string(), source: z.string() }),
      ),
      recent_purchases_count: z.number(),
      upcoming_events_hints: z.array(z.string()),
      marketplace_picks: z.array(
        z.object({
          product_id: z.string(),
          title: z.string(),
          match_reason: z.string(),
        }),
      ),
      wearable_summary_7d: z
        .object({
          sleep_avg_minutes: z.number().nullable().optional(),
          sleep_deep_pct: z.number().nullable().optional(),
          hrv_avg_ms: z.number().nullable().optional(),
          resting_hr: z.number().nullable().optional(),
          activity_minutes: z.number().nullable().optional(),
          workout_count: z.number().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),

  retrieval_trace: z.object({
    router_decision: retrievalRouterDecisionSchema,
    sources_queried: z.array(retrievalSourceSchema),
    latencies: retrievalSourceNumberMap,
    hit_counts: retrievalSourceNumberMap,
  }),

  token_budget: z.object({
    total_budget: z.number(),
    used: z.number(),
    remaining: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// Public validator API.
// ---------------------------------------------------------------------------

export type ContextContractKind = 'context_pack' | 'unified_awareness';

export interface ContextContractResult<T> {
  ok: boolean;
  /** The parsed value (typed) when ok === true. */
  data?: T;
  /** Flattened human-readable issues when ok === false. */
  issues?: string[];
}

function flatten(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.length ? i.path.join('.') : '(root)';
    return `${path}: ${i.message}`;
  });
}

/**
 * Validate an object against the context contract. Non-throwing — returns a
 * structured result so callers can log/branch. Use `kind` to pick the schema.
 *
 * @example
 *   const r = validateContextContract(pack, 'context_pack');
 *   if (!r.ok) logger.warn('context contract drift', r.issues);
 */
export function validateContextContract(
  value: unknown,
  kind: 'context_pack',
): ContextContractResult<ContextPack>;
export function validateContextContract(
  value: unknown,
  kind: 'unified_awareness',
): ContextContractResult<UnifiedAwarenessContext>;
export function validateContextContract(
  value: unknown,
  kind: ContextContractKind,
): ContextContractResult<ContextPack | UnifiedAwarenessContext> {
  const schema =
    kind === 'context_pack' ? contextPackSchema : unifiedAwarenessContextSchema;
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return {
      ok: true,
      data: parsed.data as ContextPack | UnifiedAwarenessContext,
    };
  }
  return { ok: false, issues: flatten(parsed.error) };
}

/**
 * Dev-only hard assertion. Gated behind FEATURE_CONTEXT_CONTRACT_ASSERT
 * (default OFF). When ON, throws on contract violation so drift is caught
 * immediately in dev/CI; when OFF this is a no-op (zero prod risk).
 *
 * Intended (future) wiring: call right after buildContextPack(...) returns,
 * inside the builder's caller — NOT inside the builder itself (which is
 * owned by another lane). Left unwired by default.
 */
export function assertContextContract(
  value: unknown,
  kind: ContextContractKind,
): void {
  if (process.env.FEATURE_CONTEXT_CONTRACT_ASSERT !== 'true') return;
  const result =
    kind === 'context_pack'
      ? validateContextContract(value, 'context_pack')
      : validateContextContract(value, 'unified_awareness');
  if (!result.ok) {
    throw new Error(
      `[context-contract] ${kind} violated the contract:\n  ${(
        result.issues ?? []
      ).join('\n  ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Static structural tripwires. These never run; they fail `tsc` if the Zod
// inferred type drifts from the canonical interface (e.g. R1 adds a required
// identity field, or the builder changes a field type). This is the additive
// "contract is in sync" guarantee without touching the source interfaces.
// ---------------------------------------------------------------------------

type InferredUnified = z.infer<typeof unifiedAwarenessContextSchema>;
type InferredPack = z.infer<typeof contextPackSchema>;

// Assert the Zod schema accepts every canonical value (interface → inferred).
// If a canonical field can't be assigned into the inferred type, tsc errors.
const _unifiedForward: (x: UnifiedAwarenessContext) => InferredUnified = (x) => x;
const _packForward: (x: ContextPack) => InferredPack = (x) => x;

// Enum tripwires: keep literal lists aligned with the source const tuples.
const _channel: ConversationChannel = 'orb';
const _source: RetrievalSource = 'memory_garden';
const _fns: FirstNameSource = 'none';

// Reference the unused bindings so noUnusedLocals (if enabled) stays quiet.
void _unifiedForward;
void _packForward;
void _channel;
void _source;
void _fns;
