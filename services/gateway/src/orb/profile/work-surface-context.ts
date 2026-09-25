/**
 * VTID-04560 / VTID-04562 — the knowledge a work-surface Vitana starts with.
 *
 * Phase 0 (VTID-04560) wires the seam: the work-surface session-start path
 * awaits `buildWorkSurfaceKnowledge()` and composes its result into the only
 * context a work-surface prompt may carry (session-profile.ts
 * WORK_SURFACE_CONTEXT_MARKER). Phase 2 (VTID-04562) fills it for the
 * developer: the cached live system snapshot, the domain atlas and recent
 * developer memory. Every part fails open to null — a missing snapshot never
 * blocks a session, it only makes the opener more generic.
 */
import type { AssistantProfile } from './assistant-profile';

export interface WorkSurfaceKnowledge {
  systemSnapshot: string | null;
  domainAtlas: string | null;
  devMemory: string | null;
  /** Structured snapshot facts the greeting rung can lead with. */
  pulse: WorkSurfacePulse | null;
}

/** The few facts the developer opener leads with (Phase 2 fills these). */
export interface WorkSurfacePulse {
  /** Short, factual lines, most important first. Never spoken verbatim. */
  highlights: string[];
  /** ISO time the snapshot was taken. */
  asOf: string | null;
}

export interface WorkSurfaceKnowledgeInput {
  userId: string;
  tenantId: string | null;
}

export type WorkSurfaceKnowledgeLoader = (
  profile: AssistantProfile,
  input: WorkSurfaceKnowledgeInput,
) => Promise<WorkSurfaceKnowledge>;

const EMPTY: WorkSurfaceKnowledge = { systemSnapshot: null, domainAtlas: null, devMemory: null, pulse: null };

let developerLoader: WorkSurfaceKnowledgeLoader | null = null;

/** Registered by the developer knowledge module at load (Phase 2). */
export function registerDeveloperKnowledgeLoader(loader: WorkSurfaceKnowledgeLoader | null): void {
  developerLoader = loader;
}

export async function buildWorkSurfaceKnowledge(
  profile: AssistantProfile,
  input: WorkSurfaceKnowledgeInput,
): Promise<WorkSurfaceKnowledge> {
  if (!profile.isWorkSurface) return EMPTY;
  if (profile.surface === 'command-hub') {
    if (!developerLoader) {
      try {
        // Side-effect import registers the developer loader.
        await import('../developer/developer-knowledge');
      } catch {
        return EMPTY;
      }
    }
    if (developerLoader) {
      try {
        return await developerLoader(profile, input);
      } catch {
        return EMPTY;
      }
    }
  }
  return EMPTY;
}
