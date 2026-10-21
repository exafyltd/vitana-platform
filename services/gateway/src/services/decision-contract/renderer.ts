// VTID-03109 — renderer entry point for AssistantDecisionContext.
//
// Phase A keystone: future API surface that Phase B/C consumers wire onto.
// For now it validates the contract and returns a legacy pre-built prompt
// unchanged on success, so callers can opt in to validation without any
// behavior change. Phase B removes `legacyRendered` once assembly moves
// into this module.

import type { AssistantDecisionContext } from './types';
import { validateDecisionContext, type ValidationMode } from './invariants';

export interface RenderOptions {
  readonly mode?: ValidationMode;
  // Pre-built prompt from the legacy buildLiveSystemInstruction call site.
  // Returned unchanged when the contract validates. Removed in Phase B
  // when assembly is owned by this module.
  readonly legacyRendered: string;
}

export function renderSystemInstructionFromContext(
  ctx: AssistantDecisionContext,
  options: RenderOptions,
): string {
  validateDecisionContext(ctx, options.mode ?? defaultValidationMode());
  return options.legacyRendered;
}

function defaultValidationMode(): ValidationMode {
  return process.env.NODE_ENV === 'production' ? 'log' : 'strict';
}
