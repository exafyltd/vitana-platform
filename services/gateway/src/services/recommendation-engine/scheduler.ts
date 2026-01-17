/**
 * Recommendation Scheduler - VTID-01185
 *
 * Handles scheduled recommendation generation:
 * - Every 6 hours: OASIS event analysis
 * - Daily 2 AM UTC: Full codebase scan
 * - On PR merge: Changed files analysis (triggered via webhook)
 */

import { generateRecommendations, SourceType } from './recommendation-generator';
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
}

export interface SchedulerState {
  isRunning: boolean;
  lastOasisRun?: Date;
  lastCodebaseRun?: Date;
  nextOasisRun?: Date;
  nextCodebaseRun?: Date;
  oasisIntervalId?: NodeJS.Timeout;
  codebaseIntervalId?: NodeJS.Timeout;
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
        sources: ['codebase', 'oasis', 'health', 'roadmap'],
      },
    });

    const result = await generateRecommendations(basePath, {
      sources: ['codebase', 'oasis', 'health', 'roadmap'],
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

  console.log(`${LOG_PREFIX} Scheduler started`);
  console.log(`${LOG_PREFIX} - OASIS analysis: every ${fullConfig.oasisIntervalMs / 1000 / 60 / 60}h`);
  console.log(`${LOG_PREFIX} - Daily scan: ${fullConfig.codebaseHour}:${String(fullConfig.codebaseMinute).padStart(2, '0')} UTC`);
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

  if (state.codebaseIntervalId) {
    clearTimeout(state.codebaseIntervalId);
    state.codebaseIntervalId = undefined;
  }

  state.isRunning = false;
  state.nextOasisRun = undefined;
  state.nextCodebaseRun = undefined;

  console.log(`${LOG_PREFIX} Scheduler stopped`);
}

export function getSchedulerStatus(): {
  isRunning: boolean;
  lastOasisRun?: string;
  lastCodebaseRun?: string;
  nextOasisRun?: string;
  nextCodebaseRun?: string;
} {
  return {
    isRunning: state.isRunning,
    lastOasisRun: state.lastOasisRun?.toISOString(),
    lastCodebaseRun: state.lastCodebaseRun?.toISOString(),
    nextOasisRun: state.nextOasisRun?.toISOString(),
    nextCodebaseRun: state.nextCodebaseRun?.toISOString(),
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
