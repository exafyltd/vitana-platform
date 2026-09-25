/**
 * VTID-04560 — the Assistant Profile: which Vitana speaks in this session.
 *
 * Owner rule (2026-09-25): the role whose screens are on the user's display
 * decides which Vitana assists. Community screens get the community Vitana,
 * the Command Hub gets the developer Vitana, admin screens get the admin
 * Vitana, BackOffice screens get the BackOffice Vitana — whichever app or URL
 * the user first logged in through.
 *
 * Before this module the decision was scattered and late:
 *   - the widget declared neither role nor surface, so the server guessed the
 *     surface from `current_route` plus a User-Agent phone regex;
 *   - `session.active_role` stayed null until the (often > 300 ms) context
 *     build resolved, so the setup envelope went out with no role, no role
 *     header and no developer tools;
 *   - the greeting ladder never looked at surface or role, so a developer on
 *     the Command Hub was greeted by the community wake-brief providers
 *     ("you completed 9 sessions today — shall we continue the guided
 *     journey?", production session live-848f1576, 2026-09-25 09:26 UTC).
 *
 * This module resolves ONE immutable profile per session, synchronously,
 * before the upstream setup is built. Every consumer (instruction, tools,
 * greeting, context, pre-warm) reads it. It is pure: no I/O, no env reads.
 */
import { isOrbSurface, resolveOrbSurface, SURFACE_PERSONA_KEY, type OrbSurface } from '../live/surface';
import type { PersonalitySurfaceKey } from '../../services/ai-personality-service';

/** Roles whose screens live on the member app (the `vitanaland` surface). */
export const MEMBER_PLANE_ROLES = ['community', 'patient', 'professional', 'staff'] as const;
export type MemberPlaneRole = (typeof MEMBER_PLANE_ROLES)[number];

export function isMemberPlaneRole(v: unknown): v is MemberPlaneRole {
  return typeof v === 'string' && (MEMBER_PLANE_ROLES as readonly string[]).includes(v);
}

/** The role each work surface serves. The member surface has no fixed role. */
export const WORK_SURFACE_ROLE: Record<Exclude<OrbSurface, 'vitanaland'>, string> = {
  'command-hub': 'developer',
  admin: 'admin',
  backoffice: 'backoffice',
  commerce: 'commerce',
};

/**
 * How the profile was reached:
 *  - `declared`   the screen declared its surface/role and it was accepted;
 *  - `route`      no declaration (older client) — derived from the route;
 *  - `narrowed`   a declared member role the surface does not allow was
 *                 narrowed (e.g. `developer` on community screens → community);
 *  - `unverified` a work surface whose role the token cannot confirm yet
 *                 (tool handlers still re-check the role server-side);
 *  - `anonymous`  no verified identity.
 */
export type ProfileResolution = 'declared' | 'route' | 'narrowed' | 'unverified' | 'anonymous';

export interface AssistantProfile {
  surface: OrbSurface;
  /** The role this Vitana serves. For the member surface it may be null until
   *  the stored role is read; it is then clamped by `clampMemberRole`. */
  role: string | null;
  isWorkSurface: boolean;
  personaKey: PersonalitySurfaceKey | null;
  resolution: ProfileResolution;
  /** What the screen declared, kept for telemetry. */
  declared: { surface: string | null; viewRole: string | null };
}

export interface ResolveAssistantProfileInput {
  /** `surface` from the session-start body (widget VitanaOrb.init/updateContext). */
  declaredSurface?: unknown;
  /** `view_role` from the session-start body: the role whose screens are shown. */
  declaredViewRole?: unknown;
  currentRoute?: string | null;
  isAnonymous: boolean;
  /** Verified JWT claim `app_metadata.exafy_admin`. */
  isExafyAdmin: boolean;
}

function cleanString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
}

/**
 * Resolve the session's Assistant Profile. Never throws, never returns an
 * undefined surface. Device type is deliberately NOT an input: the screens
 * decide, and a phone showing the Command Hub is still the Command Hub.
 */
export function resolveAssistantProfile(input: ResolveAssistantProfileInput): AssistantProfile {
  const declaredSurface = cleanString(input.declaredSurface);
  const declaredViewRole = cleanString(input.declaredViewRole);
  const declared = { surface: declaredSurface, viewRole: declaredViewRole };

  if (input.isAnonymous) {
    return {
      surface: 'vitanaland',
      role: null,
      isWorkSurface: false,
      personaKey: null,
      resolution: 'anonymous',
      declared,
    };
  }

  const surfaceWasDeclared = !!declaredSurface && isOrbSurface(declaredSurface);
  const surface: OrbSurface = surfaceWasDeclared
    ? (declaredSurface as OrbSurface)
    : resolveOrbSurface({ currentRoute: input.currentRoute ?? '', isMobile: false });

  if (surface !== 'vitanaland') {
    const role = WORK_SURFACE_ROLE[surface];
    // The Command Hub is the developer's surface. The token proves it for
    // Supabase-issued JWTs; Cognito tokens carry no exafy_admin claim yet
    // (auth-supabase-jwt.ts KNOWN GAP), so those sessions are marked
    // `unverified` — the persona is still the developer's (never community),
    // and every developer tool re-checks the role in its own handler.
    const resolution: ProfileResolution =
      surface === 'command-hub' && !input.isExafyAdmin
        ? 'unverified'
        : surfaceWasDeclared ? 'declared' : 'route';
    return {
      surface,
      role,
      isWorkSurface: true,
      personaKey: SURFACE_PERSONA_KEY[surface],
      resolution,
      declared,
    };
  }

  // Member surface: the declared view role wins when it is a member-plane role.
  // A work-plane role declared here (developer/admin/backoffice/infra viewing
  // community screens) is narrowed to community — the screens decide.
  let role: string | null = null;
  let resolution: ProfileResolution = surfaceWasDeclared ? 'declared' : 'route';
  if (declaredViewRole) {
    if (isMemberPlaneRole(declaredViewRole)) {
      role = declaredViewRole;
    } else {
      role = 'community';
      resolution = 'narrowed';
    }
  }
  return {
    surface,
    role,
    isWorkSurface: false,
    personaKey: null,
    resolution,
    declared,
  };
}

/**
 * The role a session serves once the stored role is known. Work surfaces keep
 * their fixed role whatever the database says; the member surface only ever
 * serves a member-plane role (a stored `developer` on community screens is
 * served as community).
 */
export function clampRoleToProfile(profile: AssistantProfile, storedRole: string | null | undefined): string | null {
  if (profile.isWorkSurface) return profile.role;
  if (profile.resolution === 'anonymous') return null;
  if (profile.role) return profile.role;
  const stored = cleanString(storedRole);
  if (!stored) return 'community';
  return isMemberPlaneRole(stored) ? stored : 'community';
}

/** Compact telemetry payload for `orb.session.profile.resolved`. */
export function profileTelemetry(profile: AssistantProfile): Record<string, unknown> {
  return {
    surface: profile.surface,
    role: profile.role,
    is_work_surface: profile.isWorkSurface,
    persona_key: profile.personaKey,
    resolution: profile.resolution,
    declared_surface: profile.declared.surface,
    declared_view_role: profile.declared.viewRole,
  };
}
