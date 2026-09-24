/**
 * VTID-04362 (Orchestrator v2, P2 — shadow): capability catalog for ORB tools
 * (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.2).
 *
 * Every ORB tool name maps to { domain, tier, self }:
 *   - domain  — the policy domain the tool acts in (policy.ts PolicyDomain);
 *   - tier    — read < draft < commit < high (what the call can change);
 *   - self    — a low-risk action on the caller's OWN data (log water, set an
 *               alarm, RSVP). Only these may be committed by voice; every
 *               other commit asks for chat/web confirmation (plan §3.2).
 *
 * This closes, for the new policy engine, the name-mapping gap the old
 * role-policy enforcer carries (orb-tools-shared.ts, "INTEGRATION TODO"):
 * the catalog is keyed by the ORB tool names themselves, so nothing needs a
 * second name table. A test requires every name in ORB_TOOL_NAMES to resolve
 * without falling through to the default, so a new tool must be classified
 * on purpose.
 *
 * Rules are deliberately explicit: prefix/verb rules for the bulk, then
 * exact overrides. `high` is an explicit list — it means maker-checker, so it
 * must never be inferred from a verb.
 */

import type { PolicyDomain, PolicyTier } from './policy';

export interface ToolCapability {
  domain: PolicyDomain;
  tier: Exclude<PolicyTier, 'none'>;
  self: boolean;
  /** Which rule produced this entry — 'override', 'rule:<name>' or 'default'. */
  source: string;
}

/** Maker-checker actions: privilege, money, prod infrastructure, tenant-wide broadcast. */
const HIGH_TOOLS = new Set<string>([
  // developer: production + merge + privilege
  'dev_publish_to_prod', 'dev_deploy_service', 'dev_promote_canary', 'dev_abort_canary',
  'dev_revert_deploy', 'dev_revert_both', 'dev_run_prod_migration', 'dev_merge_pr',
  'dev_safe_merge', 'dev_revert_pr', 'dev_approve_pr', 'dev_mint_token', 'dev_grant_access',
  'dev_revoke_access', 'dev_set_control', 'dev_healing_kill_switch', 'dev_approve_auto_execute',
  'dev_execute_vtid', 'dev_run_exec_workflow', 'dev_start_autopilot_loop', 'dev_release_merge_lock',
  'dev_run_backfill', 'dev_approve_heal', 'dev_rollback_heal', 'dev_set_healing_mode',
  // admin: privilege, money, tenant-wide effect, destructive
  'admin_grant_role', 'admin_revoke_role', 'admin_set_trust_tier', 'admin_credit_wallet',
  'admin_debit_wallet', 'admin_send_broadcast', 'admin_bulk_product_action', 'admin_set_feature_flag',
  'admin_set_control_key', 'admin_kb_delete_doc', 'admin_delete_meetup', 'admin_system_kb_update',
  'admin_run_embeddings_backfill', 'admin_repair_signup', 'admin_bulk_set_awareness',
]);

/** Proposals and compositions: produce something for a human to confirm. */
const DRAFT_TOOLS = new Set<string>([
  'admin_compose_broadcast', 'admin_create_proposal', 'dev_create_proposal', 'dev_update_proposal',
  'dev_generate_finding_plan', 'generate_health_plan', 'create_index_improvement_plan',
  'offer_action', 'build_personalized_shopping_guide', 'capture_shopping_goal',
]);

/** User-own, low-risk commits that may be confirmed by voice. */
const SELF_COMMIT_TOOLS = new Set<string>([
  'log_water', 'log_sleep', 'log_exercise', 'log_meditation', 'log_meal', 'log_vitals', 'log_mood',
  'log_biomarker', 'save_diary_entry', 'add_diary_photo', 'record_journey_answer',
  'set_alarm', 'delete_alarm', 'start_timer', 'start_pomodoro',
  'snooze_reminder', 'acknowledge_reminder', 'complete_reminder', 'update_reminder',
  'set_language', 'set_theme', 'set_voice_preferences', 'set_capability_preference',
  'mark_notifications_read', 'mark_conversation_read', 'mute_conversation', 'archive_conversation',
  'like_post', 'rsvp_event', 'cancel_rsvp', 'complete_event', 'add_to_calendar',
  'set_goal', 'update_goal', 'reinforce_memory',
  'snooze_recommendation', 'dismiss_recommendation', 'dismiss_marketplace_recommendation',
  // VTID-04493: activating the member's OWN Autopilot item (books their own
  // calendar slot) — owner decision 2026-09-24: a spoken yes may commit it.
  'activate_recommendation', 'activate_autopilot_recommendations',
  'save_marketplace_preferences', 'add_supplement_to_regimen', 'remove_supplement_from_regimen',
  'follow_member', 'unfollow_member', 'shortlist_marketplace_options', 'remove_from_marketplace_shortlist',
  'react_to_message', 'set_display_currency', 'set_shopping_budget', 'apply_discount_code',
]);

/** Reads that the verb rules below would not catch. */
const READ_OVERRIDES = new Set<string>([
  'navigate', 'navigate_to_screen', 'narrate_guided_session', 'play_music', 'play_podcast',
  'switch_persona', 'consult_external_ai', 'resolve_recipient',
  'start_marketplace_discover_assistant', 'refine_marketplace_recommendations',
  'clarify_shopping_need', 'classify_marketplace_intent', 'generate_top_marketplace_picks',
  'recent_conversations', 'scan_existing_matches', 'global_search', 'dev_open_hub_panel',
  'dev_run_simulator', 'dev_voice_lab_probe', 'dev_run_orb_selfcheck', 'admin_test_notification_category',
  'admin_test_specialist_connection', 'admin_kb_search', 'admin_kb_list_docs',
  'admin_marketplace_overview', 'admin_feedback_kpis', 'dev_recent_events',
]);

const HEALTH_TOOLS = new Set<string>([
  'log_water', 'log_sleep', 'log_exercise', 'log_meditation', 'log_meal', 'log_vitals', 'log_mood',
  'log_biomarker', 'get_pillar_subscores', 'ask_pillar_agent', 'create_index_improvement_plan',
  'get_emotional_state',
]);

const PROFESSIONAL_TOOLS = new Set<string>(['create_service', 'update_service_offerings']);

const READ_VERB = /^(get|list|search|find|browse|view|explain|recall|check|compare|summarize|review|ask|read|discover|recommend|count|query|lookup|evaluate|validate)_/;
const READ_SUFFIX = /_(status|stats|health|feed|summary|history|metrics|snapshot|log|briefing|trace|analytics|decisions|failures|context|comparison|queue|info|rate|projection|lineage|detail|diagnostics|turns|awareness)$/;
/** Writes, matched on the name with any dev_/admin_ prefix removed. */
const COMMIT_VERB = /^(create|update|set|send|add|remove|cancel|join|leave|invite|accept|decline|submit|start|end|go|edit|delete|block|unblock|mute|archive|react|reply|comment|apply|reorder|clear|request|exchange|buy|order|connect|disconnect|upgrade|redeem|schedule|purchase|activate|respond|share|report|forget|reschedule|complete|confirm|reset|dispute|approve|reject|flag|trigger|close|recompute|resolve|rollback|release|cleanup|route|stop|snooze|verify|run|allocate|terminalize|revoke|kb|healing|act)_|^(go_live|invite_friend)$/;
const HEALTH_PATTERN = /(health|lab_|biomarker|supplement|vitals|condition|vitana_index_plan)/;

function domainOf(name: string): PolicyDomain {
  if (name.startsWith('dev_')) return 'dev';
  if (name.startsWith('admin_')) return 'admin';
  if (PROFESSIONAL_TOOLS.has(name)) return 'professional';
  if (HEALTH_TOOLS.has(name) || HEALTH_PATTERN.test(name)) return 'health';
  return 'community';
}

export function classifyOrbTool(name: string): ToolCapability {
  const domain = domainOf(name);
  const bare = name.replace(/^(dev|admin)_/, '');
  if (HIGH_TOOLS.has(name)) return { domain, tier: 'high', self: false, source: 'override:high' };
  if (DRAFT_TOOLS.has(name)) return { domain, tier: 'draft', self: false, source: 'override:draft' };
  if (SELF_COMMIT_TOOLS.has(name)) return { domain, tier: 'commit', self: true, source: 'override:self' };
  if (READ_OVERRIDES.has(name)) return { domain, tier: 'read', self: false, source: 'override:read' };
  if (READ_VERB.test(bare) || READ_VERB.test(name)) return { domain, tier: 'read', self: false, source: 'rule:read-verb' };
  // A write verb wins over a read-looking suffix (admin_update_proposal_status is a write).
  if (COMMIT_VERB.test(bare)) return { domain, tier: 'commit', self: false, source: 'rule:commit-verb' };
  if (READ_SUFFIX.test(name)) return { domain, tier: 'read', self: false, source: 'rule:read-suffix' };
  return { domain, tier: 'commit', self: false, source: 'default' };
}

/** Build the full catalog for a list of tool names (e.g. ORB_TOOL_NAMES). */
export function buildToolCatalog(names: readonly string[]): Record<string, ToolCapability> {
  const out: Record<string, ToolCapability> = {};
  for (const n of names) out[n] = classifyOrbTool(n);
  return out;
}

/** Counts by domain × tier, for review screens and drift tests. */
export function summarizeCatalog(catalog: Record<string, ToolCapability>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const c of Object.values(catalog)) {
    out[c.domain] = out[c.domain] || {};
    out[c.domain][c.tier] = (out[c.domain][c.tier] || 0) + 1;
  }
  return out;
}
