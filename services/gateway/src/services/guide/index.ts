/**
 * Proactive Guide — barrel exports.
 *
 * Public surface for the guide module used by vitana-brain.ts and ORB voice.
 */

export { isPaused } from './pause-check';
export { pickOpenerCandidate } from './opener-mvp';
export {
  PAUSE_PROACTIVE_GUIDANCE_TOOL,
  CLEAR_PROACTIVE_PAUSES_TOOL,
  executePauseProactiveGuidance,
  executeClearProactivePauses,
} from './dismissal-tool';
export { emitGuideTelemetry } from './guide-telemetry';
export {
  type ProactivePause,
  type ProactivePauseScope,
  type OpenerCandidate,
  type OpenerCandidateKind,
  type OpenerSelection,
} from './types';
