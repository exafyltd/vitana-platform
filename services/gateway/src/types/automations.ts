/**
 * Autopilot Automations — Type Definitions
 *
 * VTID: VTID-01250
 * Canonical registry: docs/autopilot-automations/README.md
 */

// ── Automation ID ranges ────────────────────────────────────
export type AutomationDomain =
  | 'connect-people'           // AP-0100
  | 'community-groups'         // AP-0200
  | 'events-live-rooms'        // AP-0300
  | 'sharing-growth'           // AP-0400
  | 'engagement-loops'         // AP-0500
  | 'health-wellness'          // AP-0600
  | 'payments-wallet-vtn'      // AP-0700
  | 'personalization-engines'  // AP-0800
  | 'memory-intelligence'      // AP-0900
  | 'platform-operations'      // AP-1000
  | 'business-hub-marketplace' // AP-1100
  | 'live-rooms-commerce';     // AP-1200

export type AutomationStatus = 'PLANNED' | 'IN_PROGRESS' | 'IMPLEMENTED' | 'LIVE' | 'DEPRECATED';
export type AutomationPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type TriggerType = 'cron' | 'event' | 'heartbeat' | 'manual' | 'webhook';
export type RunStatus = 'running' | 'completed' | 'failed' | 'skipped';

// ── User roles for automation targeting ───────────────────────
export const AUTOMATION_ROLES = ['patient', 'professional', 'staff', 'admin', 'developer', 'community'] as const;
export type AutomationRole = typeof AUTOMATION_ROLES[number];

/**
 * Role targeting mode:
 * - 'all': runs for all roles (default, backward-compatible)
 * - explicit array: runs only for users with matching active_role
 */
export type RoleTarget = 'all' | AutomationRole[];

// ── Automation definition (static registry entry) ───────────
export interface AutomationDefinition {
  id: string;                  // AP-XXXX
  name: string;
  domain: AutomationDomain;
  status: AutomationStatus;
  priority: AutomationPriority;
  triggerType: TriggerType;
  triggerConfig?: {
    cronExpression?: string;   // e.g. '0 8 * * *'
    eventTopic?: string;       // OASIS event to listen for
    intervalMinutes?: number;  // heartbeat interval
  };
  targetRoles: RoleTarget;     // which user roles this automation applies to
  requires?: string[];         // AP-XXXX dependencies
  handler?: string;            // function name in executor
}

// ── Automation run (dynamic execution record) ───────────────
export interface AutomationRun {
  id: string;
  tenant_id: string;
  automation_id: string;
  trigger_type: TriggerType;
  trigger_source?: string;
  target_roles: RoleTarget;
  status: RunStatus;
  users_affected: number;
  actions_taken: number;
  error_message?: string;
  metadata: Record<string, unknown>;
  started_at: string;
  completed_at?: string;
}

// ── Automation context (passed to handler) ──────────────────
export interface AutomationContext {
  tenantId: string;
  targetRoles: RoleTarget;
  supabase: any;               // SupabaseClient (service role)
  run: AutomationRun;
  log: (msg: string) => void;
  notify: (userId: string, type: string, payload: NotificationPayload) => void;
  emitEvent: (topic: string, metadata: Record<string, unknown>) => Promise<void>;
  /**
   * Query users in this tenant filtered to the automation's target roles.
   * Returns users whose active_role matches the automation's targetRoles.
   */
  queryTargetUsers: (selectColumns?: string) => Promise<Array<{ user_id: string; active_role: string }>>;
}

export interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

// ── Wallet types ────────────────────────────────────────────
export interface WalletTransaction {
  id: string;
  tenant_id: string;
  user_id: string;
  amount: number;
  type: 'reward' | 'purchase' | 'transfer' | 'vtn_convert' | 'refund';
  source: string;
  source_event_id?: string;
  description?: string;
  balance_after: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface WalletBalance {
  tenant_id: string;
  user_id: string;
  balance: number;
  total_earned: number;
  total_spent: number;
  updated_at: string;
}

export interface CreditWalletResult {
  ok: boolean;
  transaction_id?: string;
  balance: number;
  amount?: number;
  duplicate?: boolean;
  error?: string;
}

// ── Sharing types ───────────────────────────────────────────
export interface SharingLink {
  id: string;
  tenant_id: string;
  user_id: string;
  target_type: 'event' | 'group' | 'profile' | 'product' | 'service';
  target_id: string;
  short_code: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign?: string;
  click_count: number;
  signup_count: number;
  metadata: Record<string, unknown>;
  expires_at?: string;
  created_at: string;
}

export interface Referral {
  id: string;
  tenant_id: string;
  referrer_id: string;
  referred_id?: string;
  source: 'whatsapp' | 'social' | 'direct' | 'email';
  utm_campaign?: string;
  sharing_link_id?: string;
  status: 'created' | 'clicked' | 'signed_up' | 'activated' | 'rewarded';
  reward_amount?: number;
  click_count: number;
  created_at: string;
  activated_at?: string;
  rewarded_at?: string;
}

// ── Reward config ───────────────────────────────────────────
export const REWARD_TABLE: Record<string, { amount: number; description: string }> = {
  'complete_onboarding':     { amount: 50,  description: 'Completed onboarding profile' },
  'first_lab_report':        { amount: 100, description: 'Uploaded first lab report' },
  'match_accept_message':    { amount: 20,  description: 'Accepted a match and sent a message' },
  'live_room_attended':      { amount: 30,  description: 'Attended a live room (>10 min)' },
  'group_reached_5':         { amount: 75,  description: 'Created a group that reached 5 members' },
  'referral_completed':      { amount: 200, description: 'Referred a friend who completed onboarding' },
  'product_review':          { amount: 25,  description: 'Wrote a product/service review' },
  'health_goal_milestone':   { amount: 50,  description: 'Achieved a health goal milestone' },
  'streak_30_days':          { amount: 100, description: '30-day daily usage streak' },
};
