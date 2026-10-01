/**
 * VTID-03848 — ORB surface resolution, one place.
 *
 * The assistant must never cross surfaces (GOLDEN-WORKFLOWS §3.3, owner
 * decision 2026-09-13): the community companion, the Command Hub engineering
 * co-pilot, the tenant-admin assistant and the BackOffice operations
 * assistant are four different personas with four different tool sets and
 * separate context. Before this file the rule lived in three copies
 * (live-system-instruction.ts, live-session-controller.ts telemetry,
 * orb-live.ts deriveSurfaceRole) that had already drifted on `/admin`.
 *
 * Resolution order mirrors the original heuristic: an explicit surface wins
 * (voice-lab eval / tests), mobile is always the community surface, then the
 * route prefix decides.
 */
import type { PersonalitySurfaceKey } from '../../services/ai-personality-service';

export type OrbSurface = 'vitanaland' | 'command-hub' | 'admin' | 'backoffice' | 'commerce';

export const ORB_SURFACES: readonly OrbSurface[] = ['vitanaland', 'command-hub', 'admin', 'backoffice', 'commerce'];

/**
 * VTID-04326 — the commerce portal (partner organisations: onboarding, team,
 * health-order inbox, partner connections). Owner decision 2026-09-23
 * (Orchestrator plan §8.3): business mode is its own ORB surface, so a
 * partner org member's voice session never carries the community persona,
 * personal health/diary memory or community tools into business work.
 */
export function isCommerceRoute(route: string): boolean {
  const r = route.toLowerCase();
  return r === '/commerce' || r.startsWith('/commerce/') || r === '/partner' || r.startsWith('/partner/');
}

export function isOrbSurface(v: unknown): v is OrbSurface {
  return typeof v === 'string' && (ORB_SURFACES as readonly string[]).includes(v);
}

export function resolveOrbSurface(opts: {
  currentRoute?: string | null;
  isMobile?: boolean | null;
  explicit?: string | null;
}): OrbSurface {
  const explicit = typeof opts.explicit === 'string' ? opts.explicit.trim() : '';
  if (explicit && isOrbSurface(explicit)) return explicit;
  const route = (opts.currentRoute || '').toLowerCase();
  // Commerce is checked before the mobile rule on purpose: the commerce
  // portal is fully adapted to mobile (VTID-03989), and "mobile is always
  // community" would put the community companion — with personal health
  // memory — in front of a partner org's business work.
  if (isCommerceRoute(route)) return 'commerce';
  if (opts.isMobile) return 'vitanaland';
  if (route.startsWith('/command-hub')) return 'command-hub';
  if (route === '/backoffice' || route.startsWith('/backoffice/')) return 'backoffice';
  if (route === '/admin' || route.startsWith('/admin/')) return 'admin';
  return 'vitanaland';
}

/** Work surfaces get a persona overlay, no community memory/brain context, and a restricted tool set. */
export function isWorkSurface(surface: OrbSurface): boolean {
  return surface !== 'vitanaland';
}

/** The ai_personality_config row whose voice_* fields overlay voice_live on each surface. */
export const SURFACE_PERSONA_KEY: Record<OrbSurface, PersonalitySurfaceKey | null> = {
  vitanaland: null,
  'command-hub': 'dev_orb',
  admin: 'admin_orb',
  backoffice: 'backoffice_orb',
  commerce: 'commerce_orb',
};

/** Navigator role per surface — the Navigator only ever offers routes of the surface the user is in. */
export function navigatorRoleForSurface(surface: OrbSurface): string {
  switch (surface) {
    case 'command-hub': return 'developer';
    case 'admin': return 'admin';
    case 'backoffice': return 'backoffice';
    case 'commerce': return 'commerce';
    default: return 'community';
  }
}
