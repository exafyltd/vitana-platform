/**
 * Assistant role registry — Phase 1 W3-E1 PR 3 (VTID-03240).
 *
 * Defines the canonical assistant profile for each user role. A user
 * with multiple roles gets a DIFFERENT assistant when switching roles
 * — different prompt policy, tool allowlist, memory policy, context
 * source policy, eval suite, and training dataset source.
 *
 * This file is the SOURCE OF TRUTH for role-aware behavior. Downstream
 * consumers (PR 4 role-aware context pack shadow, PR 5 cockpit spine,
 * future role-router fine-tune dataset, role leakage evals) read from
 * here.
 *
 * No runtime change: this file only DEFINES profiles. PR 4 emits
 * shadow telemetry about which profile WOULD apply per turn without
 * altering production behavior. A real cutover ships separately
 * behind FEATURE_ROLE_AWARE_ASSISTANT_ENV.
 */

// VTID-03240 ships independently from VTID-03238 (context-source-inventory).
// To keep the PRs landable in any order, the registry accepts the minimum
// structural shape it needs (just the `id` field). Once both have merged,
// PR 5 (cockpit spine) passes the full ContextSourceSpec into
// filterContextSourcesForRole; structural typing lets that work without any
// further code change.
interface MinContextSourceSpec {
  id: string;
}

export type AssistantRole =
  | 'community'
  | 'patient'
  | 'professional'
  | 'staff'
  | 'admin'
  | 'developer'
  | 'infra';

export const ASSISTANT_ROLES: readonly AssistantRole[] = [
  'community',
  'patient',
  'professional',
  'staff',
  'admin',
  'developer',
  'infra',
] as const;

/**
 * Per-role policy. Each role's assistant gets a distinct identity,
 * tool surface, memory window, context source filter, eval suite, and
 * training dataset source. Roles are NOT inherited — `admin` is not a
 * superset of `community`. Cross-role leakage is a test failure.
 */
export interface AssistantRoleProfile {
  role: AssistantRole;
  /** Human-readable label for cockpit / logs. */
  label: string;
  /** Short paragraph the assistant's system prompt opens with. */
  identity_summary: string;
  /** Conversation tone hint for the prompt-renderer. */
  tone: 'warm' | 'clinical' | 'professional' | 'operational' | 'technical' | 'terse';
  /** Tool names this role is allowed to dispatch. Wildcards via prefix. */
  tool_allowlist: readonly string[];
  /** Tool names this role MUST NOT dispatch. Explicit denial overrides allowlist prefix matches. */
  tool_denylist: readonly string[];
  /** Memory access policy. */
  memory_policy: {
    /** Read which memory categories? */
    read_categories: ReadonlyArray<'personal' | 'health' | 'professional' | 'community' | 'developer' | 'infra' | 'safety'>;
    /** Write which categories? */
    write_categories: ReadonlyArray<'personal' | 'health' | 'professional' | 'community' | 'developer' | 'infra'>;
    /** Time window for recent-memory retrieval. */
    recent_window_hours: number;
    /** Default top-k for memory retrieval ranking. */
    retrieval_top_k: number;
  };
  /** Context source filter — which inventory ids may be consulted? */
  context_source_allowlist: readonly string[];
  /** Context source filter — explicit deny (overrides allowlist). */
  context_source_denylist: readonly string[];
  /** Eval suite identifiers this role's behavior is gated by. */
  eval_suites: readonly string[];
  /** Source of training data when fine-tuning the role-router for this lane. */
  training_dataset_source: {
    table: string;
    filter: string;
    consent_required: boolean;
  };
  /** Free-form notes for cockpit / docs. */
  notes: string;
}

const BASE_MEMORY_RECENT_WINDOW = 24 * 7; // 1 week default

/**
 * Canonical role profiles.
 *
 * Hardening rule: when adding a new tool name to allowlists, prefer a
 * full match over a prefix wildcard so denylist exact-matches keep
 * working. Memory categories are intentionally narrow per role; the
 * community role MUST NOT read 'health' memory and the developer role
 * MUST NOT read 'personal' wellness memory.
 */
export const ROLE_PROFILES: Readonly<Record<AssistantRole, AssistantRoleProfile>> = {
  community: {
    role: 'community',
    label: 'Community',
    identity_summary:
      'You are Vitana for the community member. Tone is warm, encouraging, and grounded in their health journey. ' +
      'You see only the community member\'s own engagement, memory, journey stage, vitana index, and relationships.',
    tone: 'warm',
    tool_allowlist: [
      'get_today_plan',
      'get_recent_memory',
      'get_calendar_today',
      'get_calendar_week',
      'get_autopilot_recommendations',
      'get_pillar_status',
      'get_vitana_index_overview',
      'list_intents_board',
      'find_partner',
      'find_member',
      'send_chat_message',
      'remember',
      'create_calendar_event',
      'post_intent',
    ],
    tool_denylist: [
      // No developer/admin tools, no cross-tenant tools.
      'admin_*',
      'devops_*',
      'cicd_*',
      'self_heal_*',
      'autopilot_admin_*',
    ],
    memory_policy: {
      read_categories: ['personal', 'health', 'community'],
      write_categories: ['personal', 'community'],
      recent_window_hours: BASE_MEMORY_RECENT_WINDOW,
      retrieval_top_k: 8,
    },
    context_source_allowlist: [
      'orb_turns', 'orb_sessions', 'memory_facts', 'memory_writes_24h',
      'assistant_state', 'autopilot_recs', 'vitana_index', 'intent_created',
    ],
    context_source_denylist: [
      'safety_guardrails', // never expose guardrail flags to the user-facing assistant
    ],
    eval_suites: [
      'community-tone-eval-v1',
      'community-tool-routing-eval-v1',
      'role-leakage-eval-v1',
    ],
    training_dataset_source: {
      table: 'oasis_events',
      filter: 'topic=eq.orb.turn.responded&metadata->>actor_role=eq.community',
      consent_required: true,
    },
    notes:
      'Default role for user-facing Vitana surfaces (community-app + mobile). ' +
      'Cross-role leakage = test failure: community MUST NOT see developer / admin / system context.',
  },

  patient: {
    role: 'patient',
    label: 'Patient',
    identity_summary:
      'You are Vitana for the patient. Tone is calm, supportive, careful with medical language. ' +
      'You see the patient\'s own labs, vitals, wearable signals, diary, journey, plus their consented relationships with professionals.',
    tone: 'clinical',
    tool_allowlist: [
      'get_today_plan',
      'get_recent_memory',
      'get_calendar_today',
      'get_pillar_status',
      'get_vitana_index_overview',
      'log_symptom',
      'log_vital',
      'request_professional_consult',
      'send_chat_message',
      'remember',
    ],
    tool_denylist: [
      'admin_*', 'devops_*', 'cicd_*', 'self_heal_*',
      // Patient cannot dispatch tools that act on OTHER patients.
      'list_other_patients',
    ],
    memory_policy: {
      read_categories: ['personal', 'health', 'professional'],
      write_categories: ['personal', 'health'],
      recent_window_hours: 24 * 30, // longer health window
      retrieval_top_k: 10,
    },
    context_source_allowlist: [
      'orb_turns', 'orb_sessions', 'memory_facts', 'memory_writes_24h',
      'assistant_state', 'autopilot_recs', 'vitana_index',
    ],
    context_source_denylist: ['safety_guardrails'],
    eval_suites: [
      'patient-clinical-language-eval-v1',
      'patient-safety-eval-v1',
      'role-leakage-eval-v1',
    ],
    training_dataset_source: {
      table: 'oasis_events',
      filter: 'topic=eq.orb.turn.responded&metadata->>actor_role=eq.patient',
      consent_required: true,
    },
    notes:
      'Distinct from community even when the same user has both. Tone shifts toward clinical care; ' +
      'cross-patient leakage is a hard failure.',
  },

  professional: {
    role: 'professional',
    label: 'Professional',
    identity_summary:
      'You are Vitana for the credentialed health professional. You see ONLY the patients/clients who have ' +
      'explicitly granted access. Tone is professional + clinical + concise.',
    tone: 'professional',
    tool_allowlist: [
      'list_my_clients',
      'get_client_journey_summary',
      'get_client_vitana_index_overview',
      'send_chat_message',
      'create_clinical_note',
      'remember',
    ],
    tool_denylist: [
      'admin_*', 'devops_*', 'cicd_*',
      'list_all_patients',  // explicit denial; only granted-access path allowed
      'list_other_professionals',
    ],
    memory_policy: {
      read_categories: ['professional', 'community'],
      write_categories: ['professional'],
      recent_window_hours: 24 * 14,
      retrieval_top_k: 8,
    },
    context_source_allowlist: [
      'orb_turns', 'orb_sessions', 'memory_facts', 'assistant_state',
    ],
    context_source_denylist: ['safety_guardrails'],
    eval_suites: [
      'professional-access-eval-v1',
      'professional-clinical-eval-v1',
      'role-leakage-eval-v1',
    ],
    training_dataset_source: {
      table: 'oasis_events',
      filter: 'topic=eq.orb.turn.responded&metadata->>actor_role=eq.professional',
      consent_required: true,
    },
    notes:
      'Access boundary is explicit grant, never inferred. Cross-client leakage = hard failure. ' +
      'Tool allowlist is intentionally short; expand via separate PR after access-grant model formalized.',
  },

  staff: {
    role: 'staff',
    label: 'Staff',
    identity_summary:
      'You are Vitana for VitanaLand staff. Operational tone — community operations, content moderation, ' +
      'support tickets. You do NOT have developer or admin scope.',
    tone: 'operational',
    tool_allowlist: [
      'list_support_tickets',
      'get_ticket_detail',
      'reply_to_ticket',
      'moderate_community_post',
      'send_chat_message',
      'remember',
    ],
    tool_denylist: [
      'admin_*', 'devops_*', 'cicd_*', 'self_heal_*',
      // Staff cannot publish, canary, or revert prod.
      'publish_*', 'revert_*', 'canary_*',
    ],
    memory_policy: {
      read_categories: ['professional', 'community'],
      write_categories: ['professional', 'community'],
      recent_window_hours: 24 * 14,
      retrieval_top_k: 6,
    },
    context_source_allowlist: [
      'orb_turns', 'orb_sessions', 'memory_facts', 'autopilot_recs', 'intent_created',
    ],
    context_source_denylist: ['safety_guardrails'],
    eval_suites: [
      'staff-moderation-eval-v1',
      'role-leakage-eval-v1',
    ],
    training_dataset_source: {
      table: 'oasis_events',
      filter: 'topic=eq.orb.turn.responded&metadata->>actor_role=eq.staff',
      consent_required: true,
    },
    notes:
      'Operational lane. Distinct from admin — staff CANNOT publish, canary, revert, or touch CI/CD.',
  },

  admin: {
    role: 'admin',
    label: 'Admin',
    identity_summary:
      'You are Vitana for the platform admin. You see system health, finances, training, publish history, ' +
      'self-healing, and may execute canary/revert. Tone is operational + technical.',
    tone: 'operational',
    // VTID-ASSISTANT-ROLES: reconciled to REAL dispatchable ORB tool names
    // (ORB_TOOL_REGISTRY keys) so runtime enforcement can be turned on for
    // this role without denying legitimate tools. 'admin_*' covers the
    // admin voice tools (services/admin-voice-tools.ts) and the tenant-admin
    // action tools (services/orb-tools/admin-action-tools.ts). The shared
    // read tools below are the platform-neutral ones an admin session
    // legitimately uses. Roles are NOT inherited: the admin lane does NOT
    // include the dev_* developer plane (Command Hub) tools.
    tool_allowlist: [
      'admin_*',
      'search_memory',
      'search_knowledge',
      'search_web',
      'get_current_screen',
      'navigate',
      'navigate_to_screen',
      'recall_conversation_at_time',
      'explain_feature',
      'offer_action',
      'end_teaching_session',
    ],
    tool_denylist: [
      // Admin does not drive the developer plane by voice — that is the
      // developer lane (Command Hub). Explicit deny beats the closed world
      // so a future 'admin_dev_*' name can't accidentally widen it.
      'dev_publish_to_prod',
      'dev_revert_prod',
      // No community wellness/coaching tools in the admin lane.
      'ask_pillar_agent',
      'create_index_improvement_plan',
      'save_diary_entry',
      'find_match',
      'play_music',
    ],
    memory_policy: {
      read_categories: ['professional', 'community', 'developer', 'infra'],
      write_categories: ['professional'],
      recent_window_hours: 24 * 30,
      retrieval_top_k: 12,
    },
    context_source_allowlist: [
      'orb_turns', 'orb_sessions', 'memory_facts', 'assistant_state',
      'autopilot_recs', 'vitana_index', 'intent_created',
    ],
    context_source_denylist: [],
    eval_suites: [
      'admin-action-safety-eval-v1',
      'admin-publish-canary-eval-v1',
      'role-leakage-eval-v1',
    ],
    training_dataset_source: {
      table: 'oasis_events',
      filter: 'topic=eq.orb.turn.responded&metadata->>actor_role=eq.admin',
      consent_required: false, // admin role uses operator-side telemetry, not consented user data
    },
    notes:
      'Admin lane has canary/revert capability but does NOT touch source-code-level CI commands. ' +
      'Memory write surface is intentionally narrow — admin actions are evented, not memory-shaped.',
  },

  developer: {
    role: 'developer',
    label: 'Developer',
    identity_summary:
      'You are Vitana the engineering co-pilot. Tone is technical, terse, code-aware. You see code, CI runs, ' +
      'PRs, autopilot queue, gate dashboards, training status. You do NOT see end-user wellness memory.',
    tone: 'technical',
    // VTID-ASSISTANT-ROLES: reconciled to REAL dispatchable ORB tool names
    // (ORB_TOOL_REGISTRY keys). 'dev_*' covers the developer voice tools
    // (services/orb-tools/developer-tools.ts) and the developer action
    // tools (services/orb-tools/developer-action-tools.ts): VTID ledger,
    // approvals, self-healing supervision + approve/reject/rollback,
    // autopilot findings lifecycle, test runs, governance controls,
    // briefing. The shared read tools below are platform-neutral.
    tool_allowlist: [
      'dev_*',
      'search_memory',
      'search_knowledge',
      'search_web',
      'get_current_screen',
      'navigate',
      'navigate_to_screen',
      'recall_conversation_at_time',
      'explain_feature',
      'offer_action',
      'end_teaching_session',
    ],
    tool_denylist: [
      // Developer assistant MUST NOT receive community wellness tools —
      // explicit deny on the highest-risk ones; the closed world denies
      // the rest by default.
      'ask_pillar_agent',
      'create_index_improvement_plan',
      'save_diary_entry',
      'find_match',
      'find_community_member',
      'play_music',
      'send_chat_message',
      // Tenant-admin plane is the admin lane, not the developer lane.
      'admin_*',
    ],
    memory_policy: {
      read_categories: ['developer', 'infra'],
      write_categories: ['developer'],
      recent_window_hours: 24 * 14,
      retrieval_top_k: 10,
    },
    context_source_allowlist: [
      'orb_turns', 'orb_sessions', 'memory_facts', 'assistant_state',
    ],
    context_source_denylist: [
      'vitana_index',         // not relevant to dev tasks
      'safety_guardrails',
    ],
    eval_suites: [
      'developer-codepath-eval-v1',
      'developer-tone-eval-v1',
      'role-leakage-eval-v1',
    ],
    training_dataset_source: {
      table: 'oasis_events',
      filter: 'topic=eq.orb.turn.responded&metadata->>actor_role=eq.developer',
      consent_required: false,
    },
    notes:
      'Engineering co-pilot. Tone is technical not wellness. The VTID-03163 dev_orb voice override in W1 ' +
      'lives in this lane.',
  },

  infra: {
    role: 'infra',
    label: 'Infra',
    identity_summary:
      'You are Vitana for infrastructure operations. Tone is terse + diagnostic. You see Cloud Run, GCS, ' +
      'Vertex, AWS, secrets, IAM, gate state.',
    tone: 'terse',
    tool_allowlist: [
      'list_cloud_run_revisions',
      'describe_vertex_customjob',
      'list_gcs_objects',
      'list_aws_secrets',
      'read_gate_report',
      'read_canary_readiness',
      'send_chat_message',
    ],
    tool_denylist: [
      // Infra reads + diagnoses; it does NOT publish or promote.
      'publish_canary',
      'promote_canary',
      // No community wellness lane.
      'get_pillar_status',
      'find_partner',
    ],
    memory_policy: {
      read_categories: ['infra'],
      write_categories: ['infra'],
      recent_window_hours: 24 * 7,
      retrieval_top_k: 6,
    },
    context_source_allowlist: [
      'orb_turns', 'orb_sessions', 'assistant_state',
    ],
    context_source_denylist: [
      'memory_facts',
      'memory_writes_24h',
      'vitana_index',
      'autopilot_recs',
      'safety_guardrails',
    ],
    eval_suites: [
      'infra-diagnostic-eval-v1',
      'role-leakage-eval-v1',
    ],
    training_dataset_source: {
      table: 'oasis_events',
      filter: 'topic=eq.orb.turn.responded&metadata->>actor_role=eq.infra',
      consent_required: false,
    },
    notes:
      'Read-only + diagnostic. Cannot publish or promote. Memory surface is intentionally bounded to infra-only.',
  },
} as const;

/**
 * Helper: look up a profile by role. Returns null for unrecognized
 * inputs (do NOT throw — caller must handle the null path so a
 * malformed role doesn't crash the assistant turn).
 */
export function getRoleProfile(role: string | null | undefined): AssistantRoleProfile | null {
  if (!role) return null;
  const r = role as AssistantRole;
  return (ROLE_PROFILES as Record<string, AssistantRoleProfile>)[r] ?? null;
}

/**
 * Helper: check whether a tool name passes a role's allow/deny policy.
 *
 * Order of precedence:
 *   1. exact denylist match → DENY
 *   2. prefix denylist match (e.g. 'admin_*' matches 'admin_foo') → DENY
 *   3. exact allowlist match → ALLOW
 *   4. prefix allowlist match → ALLOW
 *   5. default → DENY (closed-world default)
 */
export function isToolAllowed(profile: AssistantRoleProfile, toolName: string): boolean {
  for (const deny of profile.tool_denylist) {
    if (matchesPattern(deny, toolName)) return false;
  }
  for (const allow of profile.tool_allowlist) {
    if (matchesPattern(allow, toolName)) return true;
  }
  return false;
}

function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return name.startsWith(prefix);
  }
  return false;
}

/**
 * Helper: check whether a context-source id is permitted for a role.
 * Same precedence as isToolAllowed but without prefix wildcards (source
 * ids are stable enums, not strings).
 */
export function isContextSourceAllowed(
  profile: AssistantRoleProfile,
  sourceId: string,
): boolean {
  if (profile.context_source_denylist.includes(sourceId)) return false;
  if (profile.context_source_allowlist.includes(sourceId)) return true;
  return false;
}

/**
 * Helper: validate that a context source spec is actually reachable from
 * a given role. Returns the filtered subset. Used by PR 4 (role-aware
 * context pack shadow) to filter the inventory.
 *
 * Generic over the source shape — callers pass either the full
 * ContextSourceSpec (from W3-D1 PR 1 once merged) or anything that
 * structurally has an `id: string`. Keeps this PR independent of PR 1.
 */
export function filterContextSourcesForRole<T extends MinContextSourceSpec>(
  profile: AssistantRoleProfile,
  sources: readonly T[],
): T[] {
  return sources.filter((s) => isContextSourceAllowed(profile, s.id));
}
