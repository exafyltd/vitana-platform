/**
 * VTID-04561 — the role registry: one declarative entry per role that says
 * which Vitana serves it.
 *
 * Before this, "which assistant for which role" was spread across
 * SURFACE_PERSONA_KEY (surface → persona), hard-coded
 * ['admin','exafy_admin','developer'] lists in the tool catalog (three
 * copies), developerGate()/adminGate() re-checks, and resolveBrainRole().
 * They drifted: a stored `staff` role on the Command Hub got the developer
 * persona but no developer tools.
 *
 * Every role in VITANA_ROLES must have an entry (pinned by the role-separation
 * suite), and every consumer asks the registry instead of carrying its own list.
 */
import { VITANA_ROLES } from '../../constants/vitana-roles';
import type { OrbSurface } from '../live/surface';
import type { PersonalitySurfaceKey } from '../../services/ai-personality-service';

export type ToolPack =
  | 'member'          // the community catalog (health, diary, community, journey…)
  | 'navigation'      // navigator + screen tools of the role's own surface
  | 'admin'           // tenant administration voice tools
  | 'developer'       // developer domain tools (VTIDs, CI, deploys, autopilot…)
  | 'developer_deep'  // the deep-dive engine + fast developer read tools
  | 'backoffice'      // typed ERP commands
  | 'delegate';       // operator_delegate (Command Hub)

export type KnowledgePack =
  | 'member_brain'     // memory garden, health, diary, journey (the member brain)
  | 'admin_briefing'   // admin-scanner briefing
  | 'system_snapshot'  // live system snapshot (developer)
  | 'domain_atlas'     // the developer's map of the whole system
  | 'dev_memory';      // dev_agent_memory recall

export interface RoleEntry {
  role: string;
  /** The surface whose screens this role is shown. */
  surface: OrbSurface;
  /** ai_personality_config row whose voice_* fields overlay the base persona. */
  personaKey: PersonalitySurfaceKey | null;
  toolPacks: readonly ToolPack[];
  knowledgePacks: readonly KnowledgePack[];
  /** How the first turn opens: the member wake-brief ladder or the work-surface rung. */
  opener: 'member_ladder' | 'work_surface';
  /** Which memory the assistant reads and writes. */
  memoryScope: 'member' | 'developer' | 'none';
}

const MEMBER = {
  surface: 'vitanaland' as const,
  personaKey: null,
  toolPacks: ['member', 'navigation'] as const,
  knowledgePacks: ['member_brain'] as const,
  opener: 'member_ladder' as const,
  memoryScope: 'member' as const,
};

export const ROLE_REGISTRY: Record<string, RoleEntry> = {
  community: { role: 'community', ...MEMBER },
  patient: { role: 'patient', ...MEMBER },
  professional: { role: 'professional', ...MEMBER },
  staff: { role: 'staff', ...MEMBER },
  backoffice: {
    role: 'backoffice',
    surface: 'backoffice',
    personaKey: 'backoffice_orb',
    toolPacks: ['navigation', 'backoffice'],
    knowledgePacks: ['admin_briefing'],
    opener: 'work_surface',
    memoryScope: 'none',
  },
  admin: {
    role: 'admin',
    surface: 'admin',
    personaKey: 'admin_orb',
    toolPacks: ['navigation', 'admin'],
    knowledgePacks: ['admin_briefing'],
    opener: 'work_surface',
    memoryScope: 'none',
  },
  developer: {
    role: 'developer',
    surface: 'command-hub',
    personaKey: 'dev_orb',
    toolPacks: ['navigation', 'developer', 'developer_deep', 'delegate'],
    knowledgePacks: ['system_snapshot', 'domain_atlas', 'dev_memory', 'admin_briefing'],
    opener: 'work_surface',
    memoryScope: 'developer',
  },
  infra: {
    role: 'infra',
    surface: 'command-hub',
    personaKey: 'dev_orb',
    toolPacks: ['navigation', 'developer', 'developer_deep', 'delegate'],
    knowledgePacks: ['system_snapshot', 'domain_atlas', 'dev_memory', 'admin_briefing'],
    opener: 'work_surface',
    memoryScope: 'developer',
  },
  commerce: {
    role: 'commerce',
    surface: 'commerce',
    personaKey: 'commerce_orb',
    toolPacks: ['navigation'],
    knowledgePacks: [],
    opener: 'work_surface',
    memoryScope: 'none',
  },
};

/** The entry for a role; unknown roles resolve to community (the safe member default). */
export function roleEntry(role: string | null | undefined): RoleEntry {
  const r = typeof role === 'string' ? role.toLowerCase() : '';
  if (r === 'exafy_admin') return ROLE_REGISTRY.developer;
  return ROLE_REGISTRY[r] ?? ROLE_REGISTRY.community;
}

export function roleHasToolPack(role: string | null | undefined, pack: ToolPack): boolean {
  if (!role) return false;
  return roleEntry(role).toolPacks.includes(pack);
}

/**
 * The legacy voice-catalog gate ("admin tools + developer domain tools + admin
 * domain tools") was granted to admin, exafy_admin and developer. Kept as one
 * registry answer so the three copies in the catalog cannot drift.
 */
export function roleGetsPrivilegedVoiceTools(role: string | null | undefined): boolean {
  if (!role) return false;
  return roleHasToolPack(role, 'admin') || roleHasToolPack(role, 'developer');
}

/** Every VITANA_ROLES member has an entry (checked by the regression suite). */
export function registryCoversAllRoles(): string[] {
  return (VITANA_ROLES as readonly string[]).filter((r) => !ROLE_REGISTRY[r]);
}
