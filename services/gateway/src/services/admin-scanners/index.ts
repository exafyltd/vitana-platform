/**
 * BOOTSTRAP-ADMIN-BB-CC: Admin scanner registry + runner.
 *
 * Each scanner self-registers here. The runner iterates registered scanners
 * for each tenant and upserts their insight drafts into admin_insights
 * keyed by (tenant_id, scanner, natural_key) so rescans dedup on the same
 * signal.
 *
 * The runner is invoked from services/admin-awareness-worker.ts after KPI
 * compute completes for a tenant. Soft-fails per scanner — a broken
 * scanner never breaks the loop or the KPI tick.
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';
import { systemHealthScanner } from './system-health';
import { autopilotHealthScanner } from './autopilot-health';
import { contentModerationScanner } from './content-moderation';
import { communityScanner } from './community';
import { usersLifecycleScanner } from './users-lifecycle';
import { marketplaceScanner } from './marketplace';
import { navigatorScanner } from './navigator';
import { knowledgeScanner } from './knowledge';
import { assistantScanner } from './assistant';
import { signupsFunnelScanner } from './signups-funnel';
import { settingsAuditScanner } from './settings-audit';
import { complianceScanner } from './compliance';
import { notificationsScanner } from './notifications';

const LOG_PREFIX = '[admin-scanners]';

const REGISTRY: AdminScanner[] = [
  systemHealthScanner,
  autopilotHealthScanner,
  contentModerationScanner,
  communityScanner,
  usersLifecycleScanner,
  marketplaceScanner,
  navigatorScanner,
  knowledgeScanner,
  assistantScanner,
  signupsFunnelScanner,
  settingsAuditScanner,
  complianceScanner,
  notificationsScanner,
  // Phase BB complete — all 13 scanners registered
];

export function listScanners(): AdminScanner[] {
  return [...REGISTRY];
}

export async function runAllScannersForTenant(tenantId: string): Promise<{
  scanners_run: number;
  scanners_failed: number;
  insights_written: number;
  insights_resolved: number;
}> {
  const supabase = getSupabase();
  if (!supabase) return { scanners_run: 0, scanners_failed: 0, insights_written: 0, insights_resolved: 0 };

  let scannersRun = 0;
  let scannersFailed = 0;
  let insightsWritten = 0;
  let insightsResolved = 0;

  for (const scanner of REGISTRY) {
    try {
      const drafts = await scanner.scan(tenantId);
      scannersRun++;

      // Upsert each draft — unique (tenant_id, scanner, natural_key) handles dedup.
      for (const draft of drafts) {
        const { error } = await supabase.from('admin_insights').upsert(
          {
            tenant_id: tenantId,
            scanner: scanner.id,
            natural_key: draft.natural_key,
            domain: draft.domain,
            title: draft.title,
            description: draft.description ?? null,
            severity: draft.severity,
            actionable: draft.actionable ?? false,
            recommended_action: draft.recommended_action ?? null,
            context: draft.context ?? {},
            confidence_score: draft.confidence_score ?? null,
            autonomy_level: draft.autonomy_level ?? 'observe_only',
            // Only set status on insert. On conflict we leave existing
            // status alone so approved/rejected/snoozed decisions stick
            // across rescans.
            status: 'open',
          },
          {
            onConflict: 'tenant_id,scanner,natural_key',
            ignoreDuplicates: false,
          },
        );
        if (error) {
          console.warn(`${LOG_PREFIX} upsert failed scanner=${scanner.id} key=${draft.natural_key}: ${error.message}`);
        } else {
          insightsWritten++;
        }
      }

      // Auto-resolve: any open insight from THIS scanner not in the current
      // draft set means the signal has cleared. Mark them resolved so the
      // admin isn't shown stale actions.
      const activeKeys = drafts.map((d) => d.natural_key);
      if (activeKeys.length > 0) {
        const { data: stale, error: staleErr } = await supabase
          .from('admin_insights')
          .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolved_via: 'scanner_auto' })
          .eq('tenant_id', tenantId)
          .eq('scanner', scanner.id)
          .eq('status', 'open')
          .not('natural_key', 'in', `(${activeKeys.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(',')})`)
          .select('id');
        if (!staleErr && stale) insightsResolved += stale.length;
      } else {
        // No drafts at all — resolve everything currently open from this scanner.
        const { data: stale } = await supabase
          .from('admin_insights')
          .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolved_via: 'scanner_auto' })
          .eq('tenant_id', tenantId)
          .eq('scanner', scanner.id)
          .eq('status', 'open')
          .select('id');
        if (stale) insightsResolved += stale.length;
      }
    } catch (err: any) {
      scannersFailed++;
      console.warn(`${LOG_PREFIX} scanner=${scanner.id} tenant=${tenantId.substring(0, 8)}... threw: ${err?.message}`);
    }
  }

  return { scanners_run: scannersRun, scanners_failed: scannersFailed, insights_written: insightsWritten, insights_resolved: insightsResolved };
}
