/**
 * VTID-01216: Tool Registry + Health (D4)
 *
 * Single registry for all tools available to both ORB and Operator Console.
 * Provides:
 * - Tool definitions with schemas
 * - Role-based allowlists
 * - Availability and latency tracking
 * - Health checks
 *
 * No arbitrary code execution allowed.
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { ToolDefinition, ToolHealthStatus, ToolHealthResponse, ToolRegistryResponse } from '../types/conversation';

// =============================================================================
// Tool Definitions
// =============================================================================

/**
 * All registered tools for the unified conversation layer
 */
const TOOL_REGISTRY: Map<string, ToolDefinition> = new Map([
  // ===== Autopilot Tools =====
  [
    'autopilot_create_task',
    {
      name: 'autopilot_create_task',
      description: 'Create a new Autopilot task in the Vitana system. This will create a VTID, register the task, and trigger planning.',
      parameters_schema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'A detailed description of the task to be created.',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
            description: 'Priority level for the task. Defaults to medium.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags to categorize the task.',
          },
        },
        required: ['description'],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'system'],
      enabled: true,
      category: 'autopilot',
      vtid: 'VTID-0536',
    },
  ],
  [
    'autopilot_get_status',
    {
      name: 'autopilot_get_status',
      description: 'Get the current status of an existing Autopilot task by its VTID.',
      parameters_schema: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID of the task to check. Format: VTID-XXXX.',
          },
        },
        required: ['vtid'],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'user', 'system'],
      enabled: true,
      category: 'autopilot',
      vtid: 'VTID-0536',
    },
  ],
  [
    'autopilot_list_recent_tasks',
    {
      name: 'autopilot_list_recent_tasks',
      description: 'List recent Autopilot tasks with optional filtering.',
      parameters_schema: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Maximum number of tasks to return. Defaults to 10.',
          },
          status: {
            type: 'string',
            enum: ['pending', 'scheduled', 'planned', 'in-progress', 'completed', 'validated', 'failed', 'cancelled'],
            description: 'Filter tasks by status.',
          },
        },
        required: [],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'user', 'system'],
      enabled: true,
      category: 'autopilot',
      vtid: 'VTID-0536',
    },
  ],

  // ===== Knowledge Tools =====
  [
    'knowledge_search',
    {
      name: 'knowledge_search',
      description: 'Search the Vitana documentation and knowledge base to answer questions about Vitana concepts, architecture, features, and specifications.',
      parameters_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query or question about Vitana documentation.',
          },
        },
        required: ['query'],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'user', 'system'],
      enabled: true,
      category: 'knowledge',
      vtid: 'VTID-0538',
    },
  ],

  // ===== Memory Tools =====
  [
    'memory_write',
    {
      name: 'memory_write',
      description: 'Write a new memory item to the Memory Garden for the current user.',
      parameters_schema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The content to remember.',
          },
          category_key: {
            type: 'string',
            enum: ['conversation', 'health', 'relationships', 'community', 'preferences', 'goals', 'tasks', 'products_services', 'events_meetups', 'notes', 'personal'],
            description: 'Category for the memory item.',
          },
          importance: {
            type: 'integer',
            description: 'Importance score (1-100). Defaults to 10.',
          },
        },
        required: ['content'],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'user', 'system'],
      enabled: true,
      category: 'memory',
      vtid: 'VTID-01105',
    },
  ],
  [
    'memory_search',
    {
      name: 'memory_search',
      description: 'Search the Memory Garden for relevant memories.',
      parameters_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query for memories.',
          },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Categories to filter by.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results. Defaults to 10.',
          },
        },
        required: ['query'],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'user', 'system'],
      enabled: true,
      category: 'memory',
      vtid: 'VTID-01085',
    },
  ],
  [
    'recall_conversation_at_time',
    {
      name: 'recall_conversation_at_time',
      description:
        'Retrieve a past conversation by time reference. Call this when the user mentions a past conversation by time — e.g. "we talked yesterday morning about my company", "earlier today we discussed sleep", "last Tuesday afternoon you said...". Resolves the time hint to a window in the user\'s local timezone and returns the matching session summary, the actual conversation turns, and any facts extracted in that window. Use the returned excerpts to quote what was actually said — do not paraphrase from the summary alone.',
      parameters_schema: {
        type: 'object',
        properties: {
          time_hint: {
            type: 'string',
            description:
              'Free-text time reference exactly as the user phrased it. Examples: "yesterday morning", "this morning", "last Tuesday afternoon", "2 days ago", "yesterday", "tonight". German also supported: "gestern morgen", "heute abend", "letzten Montag", "vor 3 Tagen".',
          },
          topic_hint: {
            type: 'string',
            description:
              'Optional topic the user mentioned, used to disambiguate when multiple sessions match the time window. Examples: "my company", "sleep", "weight goal".',
          },
        },
        required: ['time_hint'],
      },
      // VTID-02052: Recall is a basic memory primitive — every authenticated
      // surface needs it, including community/mobile. Without 'community' here,
      // mobile (which is force-pinned to community role) gets the awareness
      // prompt advisory but no tool declaration → Gemini Live emits a call
      // for a tool that isn't declared → upstream WS closes → frontend shows
      // "internet issues".
      allowed_roles: ['operator', 'admin', 'developer', 'user', 'system', 'community'],
      enabled: true,
      category: 'memory',
      vtid: 'VTID-01990',
    },
  ],

  // ===== System Tools =====
  [
    'discover_oasis_tasks',
    {
      name: 'discover_oasis_tasks',
      description: 'Query pending tasks from OASIS. OASIS is the only source of truth for task discovery.',
      parameters_schema: {
        type: 'object',
        properties: {
          status_filter: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by task status.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of tasks to return.',
          },
        },
        required: [],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'system'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-01159',
    },
  ],

  // ===== VTID-01221: Autopilot Recommendation Sync Tools =====
  [
    'autopilot_get_recommendations',
    {
      name: 'autopilot_get_recommendations',
      description: `Fetch recommended next actions from Autopilot for the current context.
Call this tool BEFORE giving "next steps" advice when:
- User asks "what next", "what should I do", "what do we do now"
- A VTID is selected or being discussed
- A pipeline/deploy is in progress

Returns prioritized recommendations with rationale, suggested commands, and verification steps.
Autopilot is the single source of truth for "what to do next".`,
      parameters_schema: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: ['developer', 'infra', 'admin'],
            description: 'User role context for filtering recommendations.',
          },
          ui_context: {
            type: 'object',
            properties: {
              surface: { type: 'string', description: 'Current UI surface (e.g., command-hub, operator-console)' },
              screen: { type: 'string', description: 'Current screen/view name' },
              selection: { type: 'string', description: 'Currently selected item (if any)' },
            },
            description: 'Current UI context for contextual recommendations.',
          },
          vtid: {
            type: 'string',
            description: 'Optional VTID to get recommendations for a specific task.',
          },
          time_window_minutes: {
            type: 'integer',
            description: 'Look-back window for recent activity context. Default: 120.',
          },
        },
        required: [],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'system'],
      enabled: true,
      category: 'autopilot',
      vtid: 'VTID-01221',
    },
  ],

  // ===== VTID-01270: Matchmaking Tools =====
  [
    'get_user_matches',
    {
      name: 'get_user_matches',
      description: `Fetch the current user's match recommendations from the matchmaking engine.
Call this tool when:
- User asks about events, groups, people to meet, connections, or community
- User mentions loneliness, wanting to meet people, or looking for something to do
- User asks "what's new", "anything for me today", or describes criteria (e.g. "walking groups near me")
- User asks about recommendations, suggestions, or matches

Returns today's suggested matches with privacy-safe previews including:
- Score (0-100), display name, shared topics, match type, and deep link
- Person matches only show what the user has consented to reveal

CRITICAL — How to present results:
1. Pick the BEST single match for the user's specific request and present it with context — explain WHY it fits
2. Each match object has a "deep_link" field containing a full URL like "https://e.vitanaland.com/matches/uuid". You MUST copy this exact URL into your response on its own line. NEVER say you cannot find a link — deep_link IS the link.
3. Example response format:
   🎉 Morning Walk Group
   https://e.vitanaland.com/matches/abc-123
   I also found some alternatives — discover more:
   https://vitanaland.com/discover
4. Do NOT fabricate matches — only present what this tool returns
5. If no matches fit, acknowledge it and suggest https://vitanaland.com/discover or different criteria`,
      parameters_schema: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Date in YYYY-MM-DD format. Defaults to today.',
          },
          match_type: {
            type: 'string',
            enum: ['person', 'group', 'event', 'service', 'product', 'location', 'live_room'],
            description: 'Optional filter by match type.',
          },
          topic_filter: {
            type: 'string',
            description: 'Optional topic keyword to filter matches (e.g. "walking", "sleep", "nutrition").',
          },
          min_score: {
            type: 'integer',
            description: 'Minimum match score (0-100). Default: 0.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of matches to return. Default: 5.',
          },
        },
        required: [],
      },
      allowed_roles: ['user', 'operator', 'admin', 'developer', 'system'],
      enabled: true,
      category: 'matchmaking',
      vtid: 'VTID-01270',
    },
  ],

  // ===== VTID-02000: Marketplace Tools =====
  [
    'search_marketplace_products',
    {
      name: 'search_marketplace_products',
      description: `Search the Vitana marketplace for products matching the user's needs. Use when:
- User asks for a product (supplement, device, skincare, etc.)
- User describes a symptom or goal ("something for sleep", "I need more energy", "help with stress")
- User wants to see options, compare prices, or find alternatives

Extract filters from natural language:
- health_goals for WHY: 'better-sleep', 'stress-reduction', 'energy', 'muscle-recovery', 'focus', 'immunity', 'digestive-health', 'joint-mobility', 'mood-balance', 'menstrual-support', 'jet-lag-recovery'
- ingredients_any for WHAT they know they want: ['magnesium'], ['ashwagandha'], ['omega-3']
- dietary_tags for constraints: ['vegan'], ['gluten-free'], ['halal']
- price_max_cents when they mention a budget (always in minor units — €30 = 3000)
- user_condition when the user describes a condition matching one of: insomnia, low-hrv, chronic-stress, low-energy, poor-focus, post-workout-recovery, seasonal-immunity, menstrual-cramps, joint-pain, digestive-irritation, mild-low-mood, migraines, skin-inflammation, cold-flu-recovery, jet-lag
- q as free-text fallback for anything else

The user's country, region, scope preference, dietary/allergy restrictions, and past purchases are applied automatically — do NOT repeat them in args. Never ask the user to repeat their allergies or restrictions; the system already knows.

Each result carries match_score (0-1) and match_reasons[]. When presenting results, speak the match_reasons verbatim — they are user-specific and build trust.

If results are thin, the response includes suggested_expansions (e.g., "widen scope to international"). Suggest these only when the user seems open to broader options.`,
      parameters_schema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Free-text query (used when structured filters are not enough).' },
          user_condition: {
            type: 'string',
            description: 'Canonical condition key from the knowledge base (e.g. "insomnia", "low-hrv", "chronic-stress"). Omit unless you can map the user\'s description to one.',
          },
          health_goals: {
            type: 'array',
            items: { type: 'string' },
            description: 'Goals the product should support (e.g. ["better-sleep"]).',
          },
          ingredients_any: {
            type: 'array',
            items: { type: 'string' },
            description: 'Match-any ingredient filter (e.g. ["magnesium-glycinate"]).',
          },
          dietary_tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Required dietary tags (e.g. ["vegan","gluten-free"]). All must match.',
          },
          form: {
            type: 'string',
            enum: ['capsule', 'tablet', 'powder', 'liquid', 'gummy', 'softgel', 'spray', 'other'],
            description: 'Preferred supplement form.',
          },
          category: { type: 'string', description: 'Canonical category: supplements, wellness-services, skincare, devices, books.' },
          price_max_cents: { type: 'integer', description: 'Max price in minor units (€30 = 3000, $50 = 5000).' },
          limit: { type: 'integer', description: 'Number of results. Default 10, max 50.' },
          scope: {
            type: 'string',
            enum: ['local', 'regional', 'friendly', 'international'],
            description: 'Override the user\'s default scope (only if the user explicitly asks to widen).',
          },
        },
        required: [],
      },
      allowed_roles: ['user', 'operator', 'admin', 'developer', 'system'],
      enabled: true,
      category: 'matchmaking',
      vtid: 'VTID-02000',
    },
  ],
  [
    'open_discover_feed',
    {
      name: 'open_discover_feed',
      description: `Return the user's default Discover Marketplace feed — what MATTERS to them right now given lifecycle stage, region, limitations, and conditions. Use when:
- User says "show me the shop", "open Discover", "what do you have for me", "what\'s new"
- User asks for general browsing, not a specific product

Distinct from search_marketplace_products:
- This has NO query — it surfaces a ranked feed tailored to the user
- New users (onboarding) see admin-curated starter picks for their region
- Mature users see 90% personalized recommendations

The response includes feed_context.rationale — speak this verbatim to the user as framing (e.g. "Here is your feed, shaped by your last three months of sleep data").`,
      parameters_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional category narrow (supplements, skincare, devices).' },
          limit: { type: 'integer', description: 'Number of items. Default 20, max 30.' },
        },
        required: [],
      },
      allowed_roles: ['user', 'operator', 'admin', 'developer', 'system'],
      enabled: true,
      category: 'matchmaking',
      vtid: 'VTID-02000',
    },
  ],

  // ===== VTID-02100: Wearable tools =====
  [
    'get_wearable_metrics',
    {
      name: 'get_wearable_metrics',
      description: `Fetch the user's recent wearable metrics (sleep, activity, HRV, resting heart rate, workouts).
Call this tool when:
- User asks about their sleep, recovery, energy, workouts, HRV, resting heart rate
- User says things like "how did I sleep this week?", "am I recovering?", "why am I tired?"
- The assistant needs wearable signal to ground a recommendation (insomnia, low-hrv, etc.)

Returns:
- rollup_7d: averages over the last 7 days (sleep_avg_minutes, sleep_deep_pct, hrv_avg_ms, resting_hr, activity_minutes, workout_count, days_with_data, latest_date)
- recent_daily: last 30 days of daily rows per provider

If rollup_7d is null, the user has not connected a wearable yet — suggest /ecosystem/preferences or the Terra widget flow instead of fabricating numbers.`,
      parameters_schema: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: 'How many recent days of detail to include. Default 7, max 30.' },
        },
        required: [],
      },
      allowed_roles: ['user', 'operator', 'admin', 'developer', 'system'],
      enabled: true,
      category: 'matchmaking',
      vtid: 'VTID-02100',
    },
  ],

  // ===== VTID-DEV-ASSIST: Developer Assistant Tools (Task & Spec Lifecycle) =====
  [
    'dev_list_tasks',
    {
      name: 'dev_list_tasks',
      description: 'List all tasks from the VTID ledger with status, column, and terminal state. Use when the developer asks to see tasks, the board, or task status.',
      parameters_schema: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Maximum number of tasks to return. Defaults to 50.',
          },
          status: {
            type: 'string',
            description: 'Filter by ledger status (e.g., scheduled, in_progress, completed, failed).',
          },
          layer: {
            type: 'string',
            description: 'Filter by layer (e.g., platform, community).',
          },
        },
        required: [],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_get_task_detail',
    {
      name: 'dev_get_task_detail',
      description: 'Get full detail for a specific VTID including ledger data and recent OASIS events. Use when the developer asks about a specific task.',
      parameters_schema: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID to look up (e.g., VTID-01216).',
          },
        },
        required: ['vtid'],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_generate_spec',
    {
      name: 'dev_generate_spec',
      description: 'Generate an implementation spec from seed notes for a VTID. Calls the spec generation pipeline with LLM.',
      parameters_schema: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID to generate a spec for.',
          },
          seed_notes: {
            type: 'string',
            description: 'Additional context or notes for the spec generation.',
          },
        },
        required: ['vtid'],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_get_spec',
    {
      name: 'dev_get_spec',
      description: 'Get the current spec content and status for a VTID.',
      parameters_schema: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID to get the spec for.',
          },
        },
        required: ['vtid'],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_validate_spec',
    {
      name: 'dev_validate_spec',
      description: 'Run validation checks on a spec for a VTID. Checks required sections and governance rules.',
      parameters_schema: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID whose spec to validate.',
          },
        },
        required: ['vtid'],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_quality_check',
    {
      name: 'dev_quality_check',
      description: 'Run a quality check on a spec for a VTID. Uses the spec quality agent for deeper analysis.',
      parameters_schema: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID whose spec to quality-check.',
          },
        },
        required: ['vtid'],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_approve_spec',
    {
      name: 'dev_approve_spec',
      description: 'Approve a validated spec for a VTID, moving it to approved status.',
      parameters_schema: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID whose spec to approve.',
          },
        },
        required: ['vtid'],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],

  // ===== VTID-DEV-ASSIST: Developer Assistant Tools (Approvals & Events) =====
  [
    'dev_list_approvals',
    {
      name: 'dev_list_approvals',
      description: 'List pending approval items (PRs awaiting review). Returns approval queue with checks and governance status.',
      parameters_schema: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Maximum number of approvals to return. Defaults to 50.',
          },
        },
        required: [],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_approval_count',
    {
      name: 'dev_approval_count',
      description: 'Get the count of pending approvals.',
      parameters_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_approve_item',
    {
      name: 'dev_approve_item',
      description: 'Approve a pending approval item by its approval_id. Triggers safe merge.',
      parameters_schema: {
        type: 'object',
        properties: {
          approval_id: {
            type: 'string',
            description: 'The approval_id of the item to approve.',
          },
        },
        required: ['approval_id'],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_reject_item',
    {
      name: 'dev_reject_item',
      description: 'Reject a pending approval item by its approval_id.',
      parameters_schema: {
        type: 'object',
        properties: {
          approval_id: {
            type: 'string',
            description: 'The approval_id of the item to reject.',
          },
          reason: {
            type: 'string',
            description: 'Reason for rejection.',
          },
        },
        required: ['approval_id'],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_query_oasis_events',
    {
      name: 'dev_query_oasis_events',
      description: 'Query OASIS events with optional filtering by VTID, topic, or status. Returns recent events from the event ledger.',
      parameters_schema: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'Filter events by VTID.',
          },
          topic: {
            type: 'string',
            description: 'Filter events by topic pattern (e.g., deploy.*, cicd.*).',
          },
          status: {
            type: 'string',
            description: 'Filter events by status (e.g., success, error, info).',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of events to return. Defaults to 50.',
          },
        },
        required: [],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],

  // ===== VTID-DEV-ASSIST: Developer Assistant Tools (CI/CD & Deployment) =====
  [
    'dev_create_pr',
    {
      name: 'dev_create_pr',
      description: 'Create a GitHub pull request for a VTID branch.',
      parameters_schema: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID this PR is for.',
          },
          head_branch: {
            type: 'string',
            description: 'The branch to merge from.',
          },
          base_branch: {
            type: 'string',
            description: 'The branch to merge into. Defaults to main.',
          },
          title: {
            type: 'string',
            description: 'PR title. Defaults to "VTID: <task title>".',
          },
          body: {
            type: 'string',
            description: 'PR body/description.',
          },
        },
        required: ['vtid', 'head_branch'],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_merge_pr',
    {
      name: 'dev_merge_pr',
      description: 'Safe merge a pull request with CI gate checks. Merges only if CI passes.',
      parameters_schema: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID this merge is for.',
          },
          pr_number: {
            type: 'integer',
            description: 'The PR number to merge.',
          },
          merge_method: {
            type: 'string',
            enum: ['squash', 'merge', 'rebase'],
            description: 'Merge method. Defaults to squash.',
          },
        },
        required: ['vtid', 'pr_number'],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_deploy_service',
    {
      name: 'dev_deploy_service',
      description: 'Deploy a service via the CI/CD pipeline. Triggers the deployment workflow.',
      parameters_schema: {
        type: 'object',
        properties: {
          service: {
            type: 'string',
            description: 'Service to deploy (e.g., gateway, frontend).',
          },
          vtid: {
            type: 'string',
            description: 'The VTID triggering this deployment.',
          },
          environment: {
            type: 'string',
            enum: ['production', 'staging'],
            description: 'Target environment. Defaults to production.',
          },
        },
        required: ['service'],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_deployment_status',
    {
      name: 'dev_deployment_status',
      description: 'Check deployment history and status for services.',
      parameters_schema: {
        type: 'object',
        properties: {
          service: {
            type: 'string',
            description: 'Filter by service name.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of deployments to return. Defaults to 10.',
          },
        },
        required: [],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_cicd_health',
    {
      name: 'dev_cicd_health',
      description: 'Check CI/CD pipeline health — GitHub connectivity, deployment readiness, lock status.',
      parameters_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],
  [
    'dev_lock_status',
    {
      name: 'dev_lock_status',
      description: 'Check the current deploy concurrency lock status — who holds the lock, when it expires.',
      parameters_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
      allowed_roles: ['developer', 'admin'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-DEV-ASSIST',
    },
  ],

  // ===== VTID-01221: Deterministic Fallback Tools =====
  [
    'oasis_analyze_vtid',
    {
      name: 'oasis_analyze_vtid',
      description: `Analyze a VTID by querying OASIS events to build an evidence report.
Use this as a FALLBACK when Autopilot recommendations are unavailable.
Returns timeline of events, current status, and deterministic analysis.`,
      parameters_schema: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID to analyze (e.g., VTID-01216).',
          },
          include_events: {
            type: 'boolean',
            description: 'Include raw event timeline. Default: true.',
          },
          limit: {
            type: 'integer',
            description: 'Max events to include. Default: 50.',
          },
        },
        required: ['vtid'],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'system'],
      enabled: true,
      category: 'fallback',
      vtid: 'VTID-01221',
    },
  ],
  [
    'dev_verify_deploy_checklist',
    {
      name: 'dev_verify_deploy_checklist',
      description: `Run post-deploy verification checklist for a VTID.
Use this as a FALLBACK when Autopilot recommendations are unavailable.
Returns checklist items with pass/fail status based on OASIS evidence.`,
      parameters_schema: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID to verify deployment for.',
          },
          service: {
            type: 'string',
            description: 'Optional service name to filter checks.',
          },
        },
        required: ['vtid'],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'system'],
      enabled: true,
      category: 'fallback',
      vtid: 'VTID-01221',
    },
  ],

  // ===== BOOTSTRAP-VOICE-DEMO: Architecture Investigator voice tool =====
  [
    'investigate_failure',
    {
      name: 'investigate_failure',
      description: `Trigger a root-cause investigation of a recent system failure or error.
Calls the Architecture Investigator agent (DeepSeek-reasoner), which pulls recent OASIS
events into context, generates a structured root-cause hypothesis with a suggested fix
and at least two alternative hypotheses, persists the report to architecture_reports,
and returns the hypothesis. Use when the user says things like "investigate the last
failure", "what went wrong with X", "why did the deploy break", or asks for root-cause
analysis. The result is advisory — humans decide whether to act on it.`,
      parameters_schema: {
        type: 'object',
        properties: {
          incident_topic: {
            type: 'string',
            description: 'OASIS event topic to investigate (e.g. "vtid.error.failed", "deploy.gateway.failed", "orb.live.connection_failed"). If user says "the last failure", default to "vtid.error.failed".',
          },
          vtid: {
            type: 'string',
            description: 'Optional VTID to scope the investigation (e.g. "VTID-02715").',
          },
          notes: {
            type: 'string',
            description: 'Optional human-supplied context about the symptom (e.g. "iPhone users hear no audio").',
          },
          event_limit: {
            type: 'integer',
            description: 'How many recent OASIS events to pull as evidence. Default 50, max 200.',
          },
        },
        required: ['incident_topic'],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'system', 'community'],
      enabled: true,
      category: 'system',
      vtid: 'BOOTSTRAP-ARCH-INV',
    },
  ],
]);

// =============================================================================
// Tool Health Tracking
// =============================================================================

interface ToolHealthRecord {
  name: string;
  available: boolean;
  last_checked: string;
  latency_ms?: number;
  error?: string;
  check_count: number;
  success_count: number;
}

const toolHealthRecords: Map<string, ToolHealthRecord> = new Map();

/**
 * Update health record for a tool
 */
export function updateToolHealth(
  toolName: string,
  available: boolean,
  latency_ms?: number,
  error?: string
): void {
  const existing = toolHealthRecords.get(toolName) || {
    name: toolName,
    available: true,
    last_checked: new Date().toISOString(),
    check_count: 0,
    success_count: 0,
  };

  toolHealthRecords.set(toolName, {
    ...existing,
    available,
    latency_ms,
    error,
    last_checked: new Date().toISOString(),
    check_count: existing.check_count + 1,
    success_count: existing.success_count + (available ? 1 : 0),
  });
}

// =============================================================================
// Registry API
// =============================================================================

/**
 * Get all registered tools
 */
export function getAllTools(): ToolDefinition[] {
  return Array.from(TOOL_REGISTRY.values());
}

/**
 * Get tools allowed for a specific role
 */
export function getToolsForRole(role: string): ToolDefinition[] {
  return Array.from(TOOL_REGISTRY.values()).filter(
    tool => tool.enabled && tool.allowed_roles.includes(role)
  );
}

/**
 * Get tool by name
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.get(name);
}

/**
 * Check if tool is available for role
 */
export function isToolAvailableForRole(toolName: string, role: string): boolean {
  const tool = TOOL_REGISTRY.get(toolName);
  if (!tool) return false;
  return tool.enabled && tool.allowed_roles.includes(role);
}

/**
 * Get tool health status for all tools
 */
export function getToolHealthStatus(): ToolHealthStatus[] {
  const now = new Date().toISOString();
  const statuses: ToolHealthStatus[] = [];

  for (const [name, tool] of TOOL_REGISTRY) {
    const healthRecord = toolHealthRecords.get(name);

    statuses.push({
      name,
      available: tool.enabled && (!healthRecord || healthRecord.available),
      latency_ms: healthRecord?.latency_ms,
      last_checked: healthRecord?.last_checked || now,
      error: !tool.enabled ? 'Tool is disabled' : healthRecord?.error,
    });
  }

  return statuses;
}

/**
 * Build tool registry response
 */
export function buildToolRegistryResponse(): ToolRegistryResponse {
  const tools = getAllTools();

  return {
    ok: true,
    tools,
    total_count: tools.length,
    enabled_count: tools.filter(t => t.enabled).length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build tool health response
 */
export function buildToolHealthResponse(): ToolHealthResponse {
  const statuses = getToolHealthStatus();
  const healthyCount = statuses.filter(s => s.available).length;

  return {
    ok: true,
    tools: statuses,
    healthy_count: healthyCount,
    unhealthy_count: statuses.length - healthyCount,
    last_check: new Date().toISOString(),
  };
}

/**
 * Run health checks for all tools
 */
export async function runToolHealthChecks(): Promise<ToolHealthResponse> {
  const startTime = Date.now();

  // Check Supabase-dependent tools
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
  const supabaseAvailable = !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE;

  // Update health for Supabase-dependent tools
  const supabaseTools = ['autopilot_create_task', 'autopilot_get_status', 'autopilot_list_recent_tasks', 'knowledge_search', 'memory_write', 'memory_search', 'recall_conversation_at_time', 'discover_oasis_tasks', 'dev_list_tasks', 'dev_get_task_detail', 'dev_generate_spec', 'dev_get_spec', 'dev_validate_spec', 'dev_quality_check', 'dev_approve_spec', 'dev_list_approvals', 'dev_approval_count', 'dev_approve_item', 'dev_reject_item', 'dev_query_oasis_events'];
  for (const toolName of supabaseTools) {
    updateToolHealth(
      toolName,
      supabaseAvailable,
      undefined,
      supabaseAvailable ? undefined : 'Supabase not configured'
    );
  }

  // Log health check
  await emitOasisEvent({
    vtid: 'VTID-01216',
    type: 'conversation.tool.health_check',
    source: 'tool-registry',
    status: 'info',
    message: `Tool health check completed: ${supabaseAvailable ? 'healthy' : 'degraded'}`,
    payload: {
      duration_ms: Date.now() - startTime,
      supabase_available: supabaseAvailable,
    },
  }).catch(() => {});

  return buildToolHealthResponse();
}

/**
 * Get Gemini-compatible tool definitions for function calling
 */
export function getGeminiToolDefinitions(role: string): {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
} {
  const tools = getToolsForRole(role);

  return {
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters_schema,
    })),
  };
}

/**
 * Log tool execution to OASIS
 */
export async function logToolExecution(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  success: boolean,
  duration_ms: number,
  context: {
    tenant_id: string;
    user_id: string;
    thread_id: string;
    channel: string;
  }
): Promise<void> {
  // Update health record
  updateToolHealth(toolName, success, duration_ms, success ? undefined : 'Execution failed');

  // Emit OASIS event
  await emitOasisEvent({
    vtid: 'VTID-01216',
    type: 'conversation.tool.called',
    source: `conversation-${context.channel}`,
    status: success ? 'success' : 'error',
    message: `Tool ${toolName} ${success ? 'executed successfully' : 'failed'}`,
    payload: {
      tool_name: toolName,
      args_preview: JSON.stringify(args).substring(0, 200),
      success,
      duration_ms,
      ...context,
    },
  }).catch(err => {
    console.warn(`[VTID-01216] Failed to log tool execution: ${err.message}`);
  });
}
