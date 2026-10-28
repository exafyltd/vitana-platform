/**
 * Recommendation Scheduler - VTID-01185
 *
 * Handles scheduled recommendation generation:
 * - Every 6 hours: OASIS event analysis
 * - Daily 2 AM UTC: Full codebase scan
 * - On PR merge: Changed files analysis (triggered via webhook)
 */

import { generateRecommendations, generatePersonalRecommendations, SourceType } from './recommendation-generator';
import { emitOasisEvent } from '../oasis-event-service';

const LOG_PREFIX = '[VTID-01185:Scheduler]';

// =============================================================================
// Types
// =============================================================================

export interface SchedulerConfig {
  enabled: boolean;
  basePath: string;
  oasisIntervalMs: number;      // Default: 6 hours
  codebaseHour: number;         // Default: 2 (2 AM UTC)
  codebaseMinute: number;       // Default: 0
  communityHour: number;        // Default: 7 (7 AM UTC) — daily community user regeneration
  communityMinute: number;      // Default: 0
  marketplaceHour: number;      // Default: 3 (3 AM UTC) — daily marketplace catalog sync
  marketplaceMinute: number;    // Default: 0
}

export interface SchedulerState {
  isRunning: boolean;
  lastOasisRun?: Date;
  lastCodebaseRun?: Date;
  lastCommunityRun?: Date;
  lastMarketplaceRun?: Date;
  nextOasisRun?: Date;
  nextCodebaseRun?: Date;
  nextCommunityRun?: Date;
  nextMarketplaceRun?: Date;
  oasisIntervalId?: NodeJS.Timeout;
  codebaseIntervalId?: NodeJS.Timeout;
  communityIntervalId?: NodeJS.Timeout;
  marketplaceIntervalId?: NodeJS.Timeout;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: SchedulerConfig = {
  enabled: true,
  basePath: process.env.VITANA_BASE_PATH || '/home/user/vitana-platform',
  oasisIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
  codebaseHour: 2,
  codebaseMinute: 0,
  communityHour: 7,
  communityMinute: 0,
  marketplaceHour: 3,
  marketplaceMinute: 0,
};

// =============================================================================
// Scheduler State
// =============================================================================

const state: SchedulerState = {
  isRunning: false,
};

// =============================================================================
// OASIS Scheduled Run
// =============================================================================

async function runOasisAnalysis(basePath: string): Promise<void> {
  console.log(`${LOG_PREFIX} Running scheduled OASIS analysis...`);

  try {
    await emitOasisEvent({
      vtid: 'VTID-01185',
      type: 'autopilot.recommendation.scheduled.started' as any,
      source: 'recommendation-scheduler',
      status: 'info',
      message: 'Scheduled OASIS analysis started',
      payload: {
        schedule_type: 'oasis_6h',
        sources: ['oasis'],
      },
    });

    const result = await generateRecommendations(basePath, {
      sources: ['oasis'],
      limit: 10,
      force: false,
      triggered_by: 'scheduler',
      trigger_type: 'scheduled',
    });

    state.lastOasisRun = new Date();

    await emitOasisEvent({
      vtid: 'VTID-01185',
      type: result.ok
        ? ('autopilot.recommendation.scheduled.completed' as any)
        : ('autopilot.recommendation.scheduled.failed' as any),
      source: 'recommendation-scheduler',
      status: result.ok ? 'success' : 'error',
      message: result.ok
        ? `OASIS analysis complete: ${result.generated} recommendations`
        : `OASIS analysis failed`,
      payload: {
        schedule_type: 'oasis_6h',
        run_id: result.run_id,
        generated: result.generated,
        duration_ms: result.duration_ms,
      },
    });

    console.log(`${LOG_PREFIX} OASIS analysis complete: ${result.generated} recommendations`);
  } catch (error) {
    console.error(`${LOG_PREFIX} OASIS analysis error:`, error);
  }
}

// =============================================================================
// Full Codebase Scheduled Run
// =============================================================================

async function runFullCodebaseScan(basePath: string): Promise<void> {
  console.log(`${LOG_PREFIX} Running daily codebase scan...`);

  try {
    await emitOasisEvent({
      vtid: 'VTID-01185',
      type: 'autopilot.recommendation.scheduled.started' as any,
      source: 'recommendation-scheduler',
      status: 'info',
      message: 'Daily codebase scan started',
      payload: {
        schedule_type: 'daily_2am',
        sources: ['codebase', 'oasis', 'health', 'roadmap', 'llm', 'behavior'],
      },
    });

    const result = await generateRecommendations(basePath, {
      sources: ['codebase', 'oasis', 'health', 'roadmap', 'llm', 'behavior'],
      limit: 20,
      force: true, // Force regeneration for daily scan
      triggered_by: 'scheduler',
      trigger_type: 'scheduled',
    });

    state.lastCodebaseRun = new Date();

    await emitOasisEvent({
      vtid: 'VTID-01185',
      type: result.ok
        ? ('autopilot.recommendation.scheduled.completed' as any)
        : ('autopilot.recommendation.scheduled.failed' as any),
      source: 'recommendation-scheduler',
      status: result.ok ? 'success' : 'error',
      message: result.ok
        ? `Daily scan complete: ${result.generated} recommendations`
        : `Daily scan failed`,
      payload: {
        schedule_type: 'daily_2am',
        run_id: result.run_id,
        generated: result.generated,
        duration_ms: result.duration_ms,
        analysis_summary: result.analysis_summary,
      },
    });

    console.log(`${LOG_PREFIX} Daily scan complete: ${result.generated} recommendations`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Daily scan error:`, error);
  }
}

// =============================================================================
// Community User Daily Regeneration
// =============================================================================

// VTID-02200 / VTID-01930: Daily marketplace catalog sync — iterates the provider registry.
async function runMarketplaceSync(): Promise<void> {
  console.log(`${LOG_PREFIX} Running daily marketplace catalog sync...`);
  try {
    const { runAllMarketplaceSync } = await import('../marketplace-sync');
    const result = await runAllMarketplaceSync('scheduler');
    state.lastMarketplaceRun = new Date();
    const summary = Object.entries(result.providers)
      .map(([k, v]) => `${k}=${v.totals.inserted}+`)
      .join(' ');
    console.log(`${LOG_PREFIX} Marketplace sync done: ${summary} in ${result.duration_ms}ms`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} Marketplace sync failed:`, message);
  }
}

async function runCommunityUserRegeneration(): Promise<void> {
  console.log(`${LOG_PREFIX} Running daily community user recommendation regeneration...`);

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;
    if (!supabaseUrl || !supabaseKey) {
      console.warn(`${LOG_PREFIX} Community regen skipped: missing Supabase credentials`);
      return;
    }

    // Find community users who have 0 'new' recommendations
    // Query: all users with community recs, grouped, where count of status='new' is 0
    const usersResp = await fetch(
      `${supabaseUrl}/rest/v1/rpc/get_community_users_needing_recs`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({}),
      }
    );

    let userIds: string[] = [];
    if (usersResp.ok) {
      const rows = await usersResp.json() as any[];
      userIds = rows.map((r: any) => r.user_id).filter(Boolean);
    }

    // Fallback: if RPC doesn't exist, query directly for users with community recs
    if (userIds.length === 0) {
      const fallbackResp = await fetch(
        `${supabaseUrl}/rest/v1/autopilot_recommendations?source_type=eq.community&select=user_id&order=user_id`,
        {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            Prefer: 'return=representation',
          },
        }
      );
      if (fallbackResp.ok) {
        const allRows = await fallbackResp.json() as any[];
        const uniqueUsers = new Set(allRows.map((r: any) => r.user_id).filter(Boolean));
        // For each user, check if they have any 'new' recs
        for (const uid of uniqueUsers) {
          const checkResp = await fetch(
            `${supabaseUrl}/rest/v1/autopilot_recommendations?user_id=eq.${uid}&status=eq.new&source_type=eq.community&select=id&limit=1`,
            { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
          );
          if (checkResp.ok) {
            const rows = await checkResp.json() as any[];
            if (rows.length === 0) {
              userIds.push(uid);
            }
          }
        }
      }
    }

    if (userIds.length === 0) {
      console.log(`${LOG_PREFIX} All community users have active recommendations — skipping`);
      state.lastCommunityRun = new Date();
      return;
    }

    console.log(`${LOG_PREFIX} Found ${userIds.length} community users needing fresh recommendations`);

    let totalGenerated = 0;
    for (const userId of userIds) {
      try {
        // Get tenant for this user
        const tenantResp = await fetch(
          `${supabaseUrl}/rest/v1/user_tenants?user_id=eq.${userId}&is_primary=eq.true&select=tenant_id&limit=1`,
          { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
        );
        let tenantId = '';
        if (tenantResp.ok) {
          const tenantRows = await tenantResp.json() as any[];
          tenantId = tenantRows[0]?.tenant_id || '';
        }

        const result = await generatePersonalRecommendations(userId, tenantId, {
          trigger_type: 'scheduled',
        });
        totalGenerated += result?.generated || 0;
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to regenerate for user ${userId.slice(0, 8)}: ${err}`);
      }
    }

    state.lastCommunityRun = new Date();

    await emitOasisEvent({
      vtid: 'VTID-01185',
      type: 'autopilot.recommendation.community.completed' as any,
      source: 'recommendation-scheduler',
      status: 'success',
      message: `Community regeneration complete: ${totalGenerated} recommendations for ${userIds.length} users`,
      payload: {
        schedule_type: 'community_daily',
        users_processed: userIds.length,
        total_generated: totalGenerated,
      },
    });

    console.log(`${LOG_PREFIX} Community regeneration complete: ${totalGenerated} recs for ${userIds.length} users`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Community regeneration error:`, error);
  }
}

// =============================================================================
// PR Merge Handler
// =============================================================================

export interface PrMergeContext {
  prNumber: number;
  repo: string;
  changedFiles: string[];
  mergedBy?: string;
  mergeSha?: string;
}

export async function handlePrMerge(
  basePath: string,
  context: PrMergeContext
): Promise<void> {
  console.log(`${LOG_PREFIX} Handling PR merge: PR #${context.prNumber}`);

  try {
    await emitOasisEvent({
      vtid: 'VTID-01185',
      type: 'autopilot.recommendation.pr_merge.started' as any,
      source: 'recommendation-scheduler',
      status: 'info',
      message: `Analyzing PR #${context.prNumber} changes`,
      payload: {
        pr_number: context.prNumber,
        repo: context.repo,
        changed_files_count: context.changedFiles.length,
        merged_by: context.mergedBy,
      },
    });

    // Determine which sources to run based on changed files
    const sources: SourceType[] = [];

    // Check if any service code changed
    const hasServiceChanges = context.changedFiles.some(
      (f) =>
        f.startsWith('services/') ||
        f.endsWith('.ts') ||
        f.endsWith('.tsx') ||
        f.endsWith('.js')
    );
    if (hasServiceChanges) {
      sources.push('codebase');
    }

    // Check if any database changes
    const hasDbChanges = context.changedFiles.some(
      (f) =>
        f.includes('supabase/migrations/') ||
        f.includes('prisma/') ||
        f.endsWith('.sql')
    );
    if (hasDbChanges) {
      sources.push('health');
    }

    // Check if any spec changes
    const hasSpecChanges = context.changedFiles.some((f) =>
      f.startsWith('docs/specs/')
    );
    if (hasSpecChanges) {
      sources.push('roadmap');
    }

    // Always include OASIS for PR merges
    sources.push('oasis');

    if (sources.length === 0) {
      console.log(`${LOG_PREFIX} No relevant changes in PR #${context.prNumber}, skipping`);
      return;
    }

    const result = await generateRecommendations(basePath, {
      sources,
      limit: 5,
      force: false,
      triggered_by: context.mergedBy || 'github-webhook',
      trigger_type: 'pr_merge',
    });

    await emitOasisEvent({
      vtid: 'VTID-01185',
      type: result.ok
        ? ('autopilot.recommendation.pr_merge.completed' as any)
        : ('autopilot.recommendation.pr_merge.failed' as any),
      source: 'recommendation-scheduler',
      status: result.ok ? 'success' : 'error',
      message: result.ok
        ? `PR #${context.prNumber} analysis complete: ${result.generated} recommendations`
        : `PR #${context.prNumber} analysis failed`,
      payload: {
        pr_number: context.prNumber,
        run_id: result.run_id,
        sources,
        generated: result.generated,
        duration_ms: result.duration_ms,
      },
    });

    console.log(
      `${LOG_PREFIX} PR #${context.prNumber} analysis complete: ${result.generated} recommendations`
    );
  } catch (error) {
    console.error(`${LOG_PREFIX} PR merge handler error:`, error);
  }
}

// =============================================================================
// Calculate Next Daily Run Time
// =============================================================================

function getNextDailyRunTime(hour: number, minute: number): Date {
  const now = new Date();
  const next = new Date(now);

  next.setUTCHours(hour, minute, 0, 0);

  // If the time has already passed today, schedule for tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

function getMillisecondsUntil(date: Date): number {
  return Math.max(0, date.getTime() - Date.now());
}

// =============================================================================
// Scheduler Control Functions
// =============================================================================

export function startScheduler(config: Partial<SchedulerConfig> = {}): void {
  if (state.isRunning) {
    console.log(`${LOG_PREFIX} Scheduler already running`);
    return;
  }

  const fullConfig = { ...DEFAULT_CONFIG, ...config };

  if (!fullConfig.enabled) {
    console.log(`${LOG_PREFIX} Scheduler disabled by configuration`);
    return;
  }

  console.log(`${LOG_PREFIX} Starting recommendation scheduler...`);

  state.isRunning = true;

  // Schedule OASIS analysis every 6 hours
  state.oasisIntervalId = setInterval(() => {
    runOasisAnalysis(fullConfig.basePath);
  }, fullConfig.oasisIntervalMs);

  state.nextOasisRun = new Date(Date.now() + fullConfig.oasisIntervalMs);

  // Schedule daily codebase scan
  const scheduleNextCodebaseScan = () => {
    const nextRun = getNextDailyRunTime(fullConfig.codebaseHour, fullConfig.codebaseMinute);
    state.nextCodebaseRun = nextRun;

    const msUntilRun = getMillisecondsUntil(nextRun);
    console.log(
      `${LOG_PREFIX} Next daily codebase scan scheduled for ${nextRun.toISOString()} (in ${Math.round(msUntilRun / 1000 / 60)} minutes)`
    );

    state.codebaseIntervalId = setTimeout(() => {
      runFullCodebaseScan(fullConfig.basePath);
      // Schedule the next run
      scheduleNextCodebaseScan();
    }, msUntilRun);
  };

  scheduleNextCodebaseScan();

  // Schedule daily community user regeneration
  const scheduleNextCommunityRun = () => {
    const nextRun = getNextDailyRunTime(fullConfig.communityHour, fullConfig.communityMinute);
    state.nextCommunityRun = nextRun;

    const msUntilRun = getMillisecondsUntil(nextRun);
    console.log(
      `${LOG_PREFIX} Next community regeneration scheduled for ${nextRun.toISOString()} (in ${Math.round(msUntilRun / 1000 / 60)} minutes)`
    );

    state.communityIntervalId = setTimeout(() => {
      runCommunityUserRegeneration();
      scheduleNextCommunityRun();
    }, msUntilRun);
  };

  scheduleNextCommunityRun();

  // VTID-02200: Schedule daily marketplace sync
  const scheduleNextMarketplaceRun = () => {
    const nextRun = getNextDailyRunTime(fullConfig.marketplaceHour, fullConfig.marketplaceMinute);
    state.nextMarketplaceRun = nextRun;
    const msUntilRun = getMillisecondsUntil(nextRun);
    console.log(
      `${LOG_PREFIX} Next marketplace sync scheduled for ${nextRun.toISOString()} (in ${Math.round(msUntilRun / 1000 / 60)} minutes)`
    );
    state.marketplaceIntervalId = setTimeout(() => {
      runMarketplaceSync();
      scheduleNextMarketplaceRun();
    }, msUntilRun);
  };

  scheduleNextMarketplaceRun();

  console.log(`${LOG_PREFIX} Scheduler started`);
  console.log(`${LOG_PREFIX} - OASIS analysis: every ${fullConfig.oasisIntervalMs / 1000 / 60 / 60}h`);
  console.log(`${LOG_PREFIX} - Daily scan: ${fullConfig.codebaseHour}:${String(fullConfig.codebaseMinute).padStart(2, '0')} UTC`);
  console.log(`${LOG_PREFIX} - Community regen: ${fullConfig.communityHour}:${String(fullConfig.communityMinute).padStart(2, '0')} UTC`);
  console.log(`${LOG_PREFIX} - Marketplace sync: ${fullConfig.marketplaceHour}:${String(fullConfig.marketplaceMinute).padStart(2, '0')} UTC`);
}

export function stopScheduler(): void {
  if (!state.isRunning) {
    console.log(`${LOG_PREFIX} Scheduler not running`);
    return;
  }

  console.log(`${LOG_PREFIX} Stopping recommendation scheduler...`);

  if (state.oasisIntervalId) {
    clearInterval(state.oasisIntervalId);
    state.oasisIntervalId = undefined;
  }

  if (state.marketplaceIntervalId) {
    clearTimeout(state.marketplaceIntervalId);
    state.marketplaceIntervalId = undefined;
  }

  if (state.codebaseIntervalId) {
    clearTimeout(state.codebaseIntervalId);
    state.codebaseIntervalId = undefined;
  }

  if (state.communityIntervalId) {
    clearTimeout(state.communityIntervalId);
    state.communityIntervalId = undefined;
  }

  state.isRunning = false;
  state.nextOasisRun = undefined;
  state.nextCodebaseRun = undefined;
  state.nextCommunityRun = undefined;

  console.log(`${LOG_PREFIX} Scheduler stopped`);
}

export function getSchedulerStatus(): {
  isRunning: boolean;
  lastOasisRun?: string;
  lastCodebaseRun?: string;
  lastCommunityRun?: string;
  nextOasisRun?: string;
  nextCodebaseRun?: string;
  nextCommunityRun?: string;
} {
  return {
    isRunning: state.isRunning,
    lastOasisRun: state.lastOasisRun?.toISOString(),
    lastCodebaseRun: state.lastCodebaseRun?.toISOString(),
    lastCommunityRun: state.lastCommunityRun?.toISOString(),
    nextOasisRun: state.nextOasisRun?.toISOString(),
    nextCodebaseRun: state.nextCodebaseRun?.toISOString(),
    nextCommunityRun: state.nextCommunityRun?.toISOString(),
  };
}

// =============================================================================
// Manual Trigger Functions
// =============================================================================

export async function triggerOasisAnalysis(basePath?: string): Promise<void> {
  const path = basePath || DEFAULT_CONFIG.basePath;
  await runOasisAnalysis(path);
}

export async function triggerFullScan(basePath?: string): Promise<void> {
  const path = basePath || DEFAULT_CONFIG.basePath;
  await runFullCodebaseScan(path);
}
