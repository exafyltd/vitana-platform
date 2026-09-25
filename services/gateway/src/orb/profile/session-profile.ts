/**
 * VTID-04560 — reading the Assistant Profile off a live session.
 *
 * Every consumer that used to re-derive the surface from the route (plus the
 * User-Agent phone regex) or read `session.active_role` (null until the late
 * context build resolved) goes through these helpers instead, so a session
 * has exactly one answer to "which Vitana am I?" from the first byte of the
 * setup envelope onward.
 *
 * Sessions created before this change (or by a code path that does not set a
 * profile yet) fall back to the legacy derivation, byte-for-byte.
 */
import { resolveOrbSurface, type OrbSurface } from '../live/surface';
import { clampRoleToProfile, type AssistantProfile } from './assistant-profile';

export interface ProfiledSessionLike {
  assistantProfile?: AssistantProfile;
  active_role?: string | null;
  current_route?: string | null;
  clientContext?: { isMobile?: boolean } | null;
  identity?: { role?: string | null } | null;
}

/** The surface this session serves. */
export function sessionServedSurface(session: ProfiledSessionLike): OrbSurface {
  if (session.assistantProfile) return session.assistantProfile.surface;
  return resolveOrbSurface({ currentRoute: session.current_route, isMobile: !!session.clientContext?.isMobile });
}

/**
 * The role this session serves. With a profile: the work surface's fixed
 * role, or the member-plane role clamped from the stored role. Without one:
 * the legacy `active_role`.
 */
export function sessionServedRole(session: ProfiledSessionLike): string | null {
  if (session.assistantProfile) return clampRoleToProfile(session.assistantProfile, session.active_role);
  return session.active_role ?? null;
}

/**
 * The start marker of the only context a work surface is allowed to carry.
 * `buildLiveSystemInstruction` keeps the text from this marker on and drops
 * everything before it on work surfaces — the member's health, diary,
 * journey, memory and wake-brief blocks can never reach a work-surface
 * prompt, whatever is concatenated in front of it.
 */
export const WORK_SURFACE_CONTEXT_MARKER = '=== WORK SURFACE CONTEXT ===';

export interface WorkSurfaceContextParts {
  /** Admin-scanner briefing (fetchAdminBriefingBlock). */
  adminBriefing?: string | null;
  /** Live system snapshot (developer), rendered for the prompt. */
  systemSnapshot?: string | null;
  /** Domain atlas (developer), rendered for the prompt. */
  domainAtlas?: string | null;
  /** Recent developer memory (dev_agent_memory recall). */
  devMemory?: string | null;
}

/** Compose the work-surface context block, or '' when there is nothing to carry. */
export function buildWorkSurfaceContextSection(
  profile: AssistantProfile | undefined,
  parts: WorkSurfaceContextParts,
): string {
  if (!profile || !profile.isWorkSurface) return '';
  const chunks: string[] = [];
  if (parts.systemSnapshot && parts.systemSnapshot.trim()) chunks.push(parts.systemSnapshot.trim());
  if (parts.adminBriefing && parts.adminBriefing.trim()) chunks.push(parts.adminBriefing.trim());
  if (parts.domainAtlas && parts.domainAtlas.trim()) chunks.push(parts.domainAtlas.trim());
  if (parts.devMemory && parts.devMemory.trim()) chunks.push(parts.devMemory.trim());
  if (chunks.length === 0) return '';
  return `\n\n${WORK_SURFACE_CONTEXT_MARKER}\nSurface: ${profile.surface}. Role served: ${profile.role ?? 'unverified'}.\n\n${chunks.join('\n\n')}`;
}

/**
 * Keep only the work-surface context of an assembled bootstrap string.
 * Returns '' when the string carries no work-surface section.
 */
export function extractWorkSurfaceContext(bootstrap: string | null | undefined): string {
  if (!bootstrap) return '';
  const idx = bootstrap.indexOf(WORK_SURFACE_CONTEXT_MARKER);
  return idx >= 0 ? bootstrap.slice(idx) : '';
}

/**
 * The work-surface fields of a GreetingDecisionContext. Empty on the member
 * surface and for sessions without a profile, so every member ladder is
 * unchanged.
 */
export function workSurfaceGreetingFields(
  session: ProfiledSessionLike & {
    workSurfaceBriefing?: string | null;
    workSurfaceKnowledge?: { pulse?: { highlights?: string[] } | null } | null;
  },
): { surface?: string; workSurfaceRole?: string | null; workSurfaceHighlights?: string[] } {
  const profile = session.assistantProfile;
  if (!profile || !profile.isWorkSurface) return {};
  const highlights: string[] = [];
  const pulse = session.workSurfaceKnowledge?.pulse?.highlights;
  if (Array.isArray(pulse)) highlights.push(...pulse.filter((h) => typeof h === 'string'));
  if (highlights.length === 0 && typeof session.workSurfaceBriefing === 'string') {
    highlights.push(...briefingHighlights(session.workSurfaceBriefing));
  }
  return { surface: profile.surface, workSurfaceRole: profile.role, workSurfaceHighlights: highlights };
}

/** Pull up to 5 fact lines out of a rendered admin briefing block. */
export function briefingHighlights(block: string): string[] {
  return block
    .split('\n')
    .map((l) => l.replace(/^[\s>*•\-\d.)]+/, '').trim())
    .filter((l) => l.length > 8 && !/^=+|^#+|^\[|^(admin|briefing)\b.*:$/i.test(l))
    .slice(0, 5);
}
