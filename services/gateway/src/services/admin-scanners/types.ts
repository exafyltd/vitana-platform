/**
 * BOOTSTRAP-ADMIN-BB-CC: Shared types for admin scanners.
 *
 * Each scanner is a module exporting `scan(tenantId)` that returns an array
 * of insight drafts. The runner upserts them into admin_insights keyed by
 * (tenant_id, scanner, natural_key) so repeat scans dedup on the same signal.
 */

export type InsightSeverity = 'info' | 'warning' | 'action_needed' | 'urgent';

export type AutonomyLevel =
  | 'observe_only'
  | 'diagnose'
  | 'spec_and_wait'
  | 'auto_approve_simple'
  | 'full_auto';

/**
 * Admin domains map to the tenant-admin sidebar sections in the plan
 * (atomic-riding-badger.md Part B-1).
 */
export type AdminDomain =
  | 'overview'
  | 'users'
  | 'community'
  | 'knowledge'
  | 'navigator'
  | 'moderation'
  | 'assistant'
  | 'marketplace'
  | 'autopilot'
  | 'audit'
  | 'settings'
  | 'notifications'
  | 'signups'
  | 'system_health';

export interface InsightDraft {
  /** Stable per-signal key; scanner produces the same value on re-scan to dedup. */
  natural_key: string;
  domain: AdminDomain;
  title: string;
  description?: string;
  severity: InsightSeverity;
  actionable?: boolean;
  recommended_action?: Record<string, unknown>;
  context?: Record<string, unknown>;
  confidence_score?: number; // 0-1
  autonomy_level?: AutonomyLevel;
}

export interface AdminScanner {
  /** Unique scanner id (lowercase, used as the scanner column value). */
  id: string;
  /** The admin domain this scanner reports to. */
  domain: AdminDomain;
  /** Human label for logs. */
  label: string;
  /** Scan one tenant. Never throws; returns [] on any internal failure. */
  scan(tenantId: string): Promise<InsightDraft[]>;
}
