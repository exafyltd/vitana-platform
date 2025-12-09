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
