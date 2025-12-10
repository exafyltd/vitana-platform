/**
 * VTID-0526-D: Task Stage Mapping Utility
 *
 * Provides standardized 4-stage mapping for telemetry events.
 * Only these 4 macro stages are allowed:
 * - PLANNER: Planning phase (scheduling, queue, preparation)
 * - WORKER: Execution phase (running, processing, building)
 * - VALIDATOR: Validation phase (testing, verification, checks)
 * - DEPLOY: Deployment phase (releasing, publishing, deploying)
 */

export type TaskStage = 'PLANNER' | 'WORKER' | 'VALIDATOR' | 'DEPLOY';

// Canonical stage values
export const VALID_STAGES: readonly TaskStage[] = ['PLANNER', 'WORKER', 'VALIDATOR', 'DEPLOY'] as const;

// Keywords mapped to each stage
const STAGE_KEYWORDS: Record<TaskStage, string[]> = {
  PLANNER: [
    'planner', 'planning', 'plan', 'schedule', 'scheduled', 'queue', 'queued',
    'prepare', 'preparation', 'init', 'initialize', 'setup', 'configure',
    'pending', 'waiting', 'start', 'starting', 'begin', 'request', 'requested'
  ],
  WORKER: [
    'worker', 'working', 'execute', 'executing', 'execution', 'run', 'running',
    'process', 'processing', 'build', 'building', 'compile', 'compiling',
    'active', 'in_progress', 'in-progress', 'ongoing', 'doing', 'implement'
  ],
  VALIDATOR: [
    'validator', 'validate', 'validating', 'validation', 'test', 'testing',
    'verify', 'verifying', 'verification', 'check', 'checking', 'lint', 'linting',
    'review', 'reviewing', 'assess', 'assessing', 'audit', 'auditing', 'scan'
  ],
  DEPLOY: [
    'deploy', 'deploying', 'deployment', 'release', 'releasing', 'publish',
    'publishing', 'ship', 'shipping', 'rollout', 'live', 'production', 'prod',
    'promote', 'promoting', 'complete', 'completed', 'done', 'finish', 'finished'
  ]
};

/**
 * Maps a raw string (topic, kind, status, message) to one of the 4 canonical stages.
 * Returns null if no stage can be determined (event has no clear stage association).
 *
 * @param raw - Raw string to analyze (can be topic, kind, status, or message)
 * @param context - Optional additional context strings to consider
 * @returns The mapped TaskStage or null
 */
export function mapRawToStage(raw: string | null | undefined, ...context: (string | null | undefined)[]): TaskStage | null {
  if (!raw && context.every(c => !c)) {
    return null;
  }

  // Combine all inputs for analysis
  const combined = [raw, ...context]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!combined) {
    return null;
  }

  // Check each stage's keywords (in reverse order of pipeline to prioritize later stages)
  // This ensures "deploy after test" maps to DEPLOY, not VALIDATOR
  for (const stage of [...VALID_STAGES].reverse()) {
    const keywords = STAGE_KEYWORDS[stage];
    for (const keyword of keywords) {
      if (combined.includes(keyword)) {
        return stage;
      }
    }
  }

  // Default: if we can't determine stage, return null (not an error, just unknown)
  return null;
}

/**
 * Normalizes a stage string to a valid TaskStage.
 * If the input is already a valid stage (case-insensitive), returns it uppercased.
 * Otherwise, attempts to map it using keywords.
 *
 * @param stage - Input stage string
 * @returns Valid TaskStage or null
 */
export function normalizeStage(stage: string | null | undefined): TaskStage | null {
  if (!stage) {
    return null;
  }

  const upper = stage.toUpperCase().trim();

  // Direct match
  if (VALID_STAGES.includes(upper as TaskStage)) {
    return upper as TaskStage;
  }

  // Attempt keyword mapping
  return mapRawToStage(stage);
}

/**
 * Type guard to check if a value is a valid TaskStage.
 */
export function isValidStage(value: unknown): value is TaskStage {
  return typeof value === 'string' && VALID_STAGES.includes(value as TaskStage);
}

/**
 * Empty stage counters object.
 */
export interface StageCounters {
  PLANNER: number;
  WORKER: number;
  VALIDATOR: number;
  DEPLOY: number;
}

/**
 * Returns an empty stage counters object.
 */
export function emptyStageCounters(): StageCounters {
  return {
    PLANNER: 0,
    WORKER: 0,
    VALIDATOR: 0,
    DEPLOY: 0
  };
}

/**
 * VTID-0527: Stage status type for timeline entries.
 */
export type StageStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'ERROR';

/**
 * VTID-0527: Individual stage timeline entry.
 */
export interface StageTimelineEntry {
  stage: TaskStage;
  status: StageStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  errorAt?: string | null;
}

/**
 * VTID-0527-B: Return default stage timeline with all stages PENDING.
 * Used as fallback when no events are found.
 */
export function defaultStageTimeline(): StageTimelineEntry[] {
  return VALID_STAGES.map((stage): StageTimelineEntry => ({
    stage,
    status: 'PENDING',
    startedAt: null,
    completedAt: null,
    errorAt: null,
  }));
}

/**
 * VTID-0527: Telemetry event structure for timeline building.
 */
export interface TimelineEvent {
  id?: string;
  created_at: string;
  vtid: string;
  kind?: string;
  status?: string;
  title?: string;
  task_stage?: string | null;
  source?: string;
  layer?: string;
}

/**
 * VTID-0527: Build stage timeline from telemetry events for a specific VTID.
 *
 * Returns an array of 4 entries (PLANNER, WORKER, VALIDATOR, DEPLOY) in order.
 * Each entry has a status (PENDING, RUNNING, COMPLETED, ERROR) and timestamps.
 *
 * Rules:
 * - If no events seen for a stage → status: "PENDING", no timestamps
 * - If events exist but no completion → status: "RUNNING", startedAt present
 * - If completion/success events exist → status: "COMPLETED", startedAt & completedAt present
 * - If error/failure events exist → status: "ERROR", errorAt present (overrides others)
 *
 * @param events - Array of telemetry events (pre-filtered by VTID or not)
 * @param vtid - The VTID to filter events by (optional if already filtered)
 * @returns Array of 4 StageTimelineEntry objects
 */
export function buildStageTimeline(events: TimelineEvent[], vtid?: string): StageTimelineEntry[] {
  // Filter events by VTID if specified
  const relevantEvents = vtid
    ? events.filter(e => e.vtid === vtid)
    : events;

  // Build timeline for each stage
  return VALID_STAGES.map((stage): StageTimelineEntry => {
    // Find all events for this stage
    const stageEvents = relevantEvents.filter(e => e.task_stage === stage);

    if (stageEvents.length === 0) {
      return { stage, status: 'PENDING' };
    }

    // Sort events by timestamp
    const sorted = [...stageEvents].sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    // Determine status based on event statuses
    const hasError = sorted.some(e =>
      e.status === 'failure' || e.status === 'error' ||
      (e.title && /error|fail|exception/i.test(e.title))
    );

    const hasCompleted = sorted.some(e =>
      e.status === 'success' || e.status === 'completed' ||
      (e.kind && /completed|done|finished|success/i.test(e.kind)) ||
      (e.title && /completed|done|finished|success/i.test(e.title))
    );

    const hasRunning = sorted.some(e =>
      e.status === 'in_progress' || e.status === 'running' ||
      (e.kind && /started|running|processing|executing/i.test(e.kind))
    );

    // Get timestamps
    const startedAt = sorted[0]?.created_at;
    const lastEvent = sorted[sorted.length - 1];

    // Build entry based on status priority: ERROR > COMPLETED > RUNNING > PENDING
    if (hasError) {
      const errorEvent = sorted.find(e =>
        e.status === 'failure' || e.status === 'error' ||
        (e.title && /error|fail|exception/i.test(e.title))
      );
      return {
        stage,
        status: 'ERROR',
        startedAt,
        errorAt: errorEvent?.created_at
      };
    }

    if (hasCompleted) {
      const completedEvent = sorted.find(e =>
        e.status === 'success' || e.status === 'completed' ||
        (e.kind && /completed|done|finished|success/i.test(e.kind)) ||
        (e.title && /completed|done|finished|success/i.test(e.title))
      ) || lastEvent;
      return {
        stage,
        status: 'COMPLETED',
        startedAt,
        completedAt: completedEvent?.created_at
      };
    }

    if (hasRunning || stageEvents.length > 0) {
      return {
        stage,
        status: 'RUNNING',
        startedAt
      };
    }

    return { stage, status: 'PENDING' };
  });
}
