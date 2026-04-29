/**
 * E5 — server-side enforcement of profiles.account_visibility.
 *
 * The jsonb column was introduced in vitana-v1 migration
 * 20260421000000_add_account_profile_fields.sql with a 3-tier model
 * (private | connections | public) keyed by camelCase field names.
 * Today the visibility filter runs only client-side; this module is the
 * server-side mirror used by gateway routes that proxy profile data.
 *
 * Used together with the SQL helpers introduced in
 * 20260507000100_account_visibility_helper_fns.sql:
 *   - public.get_viewer_relationship(viewer, subject) → 'self' | 'connection' | 'stranger'
 *   - public.can_read_profile_field(subject, viewer, field_key, default_tier) → bool
 *
 * The frontend mirror (DEFAULT_ACCOUNT_VISIBILITY in src/types/profile.ts)
 * MUST stay in sync with FIELD_DEFAULTS below — this is the price of
 * defense-in-depth (frontend filter for UX, server filter for safety).
 */

import { getSupabase } from './supabase';

export type FieldVisibility = 'private' | 'connections' | 'public';
export type ViewerRelationship = 'self' | 'connection' | 'stranger';

/**
 * Canonical defaults per visibility key. Mirrors the frontend
 * DEFAULT_ACCOUNT_VISIBILITY map. Sub-fields use dot notation.
 *
 * Defaults err on the side of privacy for sensitive fields (age,
 * gender, partner preferences, contact info). Public defaults are only
 * applied to fields whose exposure is intrinsic to community discovery
 * (display_name, avatar, member_since, etc.).
 */
export const FIELD_DEFAULTS: Record<string, FieldVisibility> = {
  // ── Existing keys (from 20260421000000) ──
  firstName: 'private',
  lastName: 'private',
  dateOfBirth: 'private',
  gender: 'private',
  maritalStatus: 'private',
  email: 'private',
  phone: 'private',
  address: 'private',
  country: 'connections',
  city: 'connections',
  memberSince: 'public',
  accountType: 'public',
  verificationStatus: 'public',
  handle: 'public',
  avatarUrl: 'public',
  longevityArchetype: 'public',

  // ── E5 additions for new profile sections ──
  dancePreferences: 'public',
  'dancePreferences.varieties': 'public',
  'dancePreferences.level': 'public',
  'dancePreferences.lookingFor': 'public',

  // Partner-finding section is private by default. Sub-fields stay
  // private even if the section flips to public — user must opt-in
  // each sub-field individually for the highest-stakes data.
  partnerPreferences: 'private',
  'partnerPreferences.ageRange': 'private',
  'partnerPreferences.gender': 'private',
  'partnerPreferences.relationshipIntent': 'private',
  'partnerPreferences.locationRadius': 'connections',

  // Service offerings are public by default (hiding defeats the purpose).
  serviceOfferings: 'public',
  'serviceOfferings.priceRange': 'public',

  // "My posts" section visibility on the public profile page. Each
  // user_intents row already has its own per-row visibility column from
  // P2-A; this controls whether the SECTION even renders to non-owners.
  myPosts: 'public',
  'myPosts.commercial': 'public',
  // Hardcoded — partner_seek posts NEVER surface in the public My Posts
  // list regardless of toggle. They follow the mutual-reveal protocol.
  'myPosts.partnerSeek': 'private',

  // Coarse age-band exposure (e.g. "30s") that lets a user be
  // discoverable without exposing exact age. Three modes are encoded
  // separately by the frontend: 'none' (don't show), 'band' (exposes
  // band only — corresponds to derivedAgeBand=public), 'exact' (exposes
  // band AND exact age — corresponds to dateOfBirth=public).
  derivedAgeBand: 'connections',
};

/**
 * Keys that are NEVER user-toggleable. Writes to these keys via the
 * visibility PATCH endpoint must be rejected.
 */
export const HARDCODED_KEYS = new Set<string>(['myPosts.partnerSeek']);

/**
 * Resolve viewer-vs-subject relationship via the SQL helper.
 * Returns 'stranger' on any DB error to fail closed.
 */
export async function getViewerRelationship(
  viewerUserId: string | null,
  subjectUserId: string,
): Promise<ViewerRelationship> {
  if (!viewerUserId) return 'stranger';
  if (viewerUserId === subjectUserId) return 'self';

  const supabase = getSupabase();
  if (!supabase) return 'stranger';

  const { data, error } = await supabase.rpc('get_viewer_relationship', {
    p_viewer: viewerUserId,
    p_subject: subjectUserId,
  });

  if (error) {
    console.warn('[account-visibility] get_viewer_relationship failed', error);
    return 'stranger';
  }
  return (data === 'self' || data === 'connection') ? data : 'stranger';
}

/**
 * Resolve the effective tier for a field given a subject's
 * account_visibility map (raw jsonb from profiles row).
 */
export function effectiveTier(
  visibilityMap: Record<string, FieldVisibility> | null | undefined,
  fieldKey: string,
): FieldVisibility {
  const explicit = visibilityMap?.[fieldKey];
  if (explicit === 'private' || explicit === 'connections' || explicit === 'public') {
    return explicit;
  }
  return FIELD_DEFAULTS[fieldKey] ?? 'private';
}

/**
 * Returns true iff the viewer is allowed to see fieldKey on subject.
 * Tier ladder: public > connections > private. Self always wins.
 */
export function canRead(
  visibilityMap: Record<string, FieldVisibility> | null | undefined,
  fieldKey: string,
  relationship: ViewerRelationship,
): boolean {
  if (relationship === 'self') return true;
  const tier = effectiveTier(visibilityMap, fieldKey);
  if (tier === 'public') return true;
  if (tier === 'connections' && relationship === 'connection') return true;
  return false;
}

/**
 * Strip fields the viewer cannot see. Object spread, never mutates input.
 *
 * The fieldMap argument maps response-shape keys → visibility keys.
 * Example for a member-card row:
 *   {
 *     age:        'dateOfBirth',
 *     ageBand:    'derivedAgeBand',
 *     gender:     'gender',
 *     city:       'city',
 *   }
 *
 * Any fieldMap value that resolves to a hidden tier sets the
 * corresponding shape key to null in the returned shallow copy.
 */
export function applyAccountVisibility<T extends Record<string, any>>(
  payload: T,
  visibilityMap: Record<string, FieldVisibility> | null | undefined,
  relationship: ViewerRelationship,
  fieldMap: Record<string, string>,
): T {
  if (relationship === 'self') return payload;
  const out: Record<string, any> = { ...payload };
  for (const [shapeKey, visibilityKey] of Object.entries(fieldMap)) {
    if (!canRead(visibilityMap, visibilityKey, relationship)) {
      out[shapeKey] = null;
    }
  }
  return out as T;
}

/**
 * Validate a (field_key, tier) pair for the PATCH endpoint.
 * Rejects unknown keys (visibility-key squatting) and hardcoded keys.
 */
export function validateVisibilityPatch(
  fieldKey: string,
  tier: string,
): { ok: true } | { ok: false; reason: string } {
  if (HARDCODED_KEYS.has(fieldKey)) {
    return { ok: false, reason: `field_${fieldKey}_is_hardcoded` };
  }
  if (!(fieldKey in FIELD_DEFAULTS)) {
    return { ok: false, reason: `unknown_field_${fieldKey}` };
  }
  if (tier !== 'private' && tier !== 'connections' && tier !== 'public') {
    return { ok: false, reason: `invalid_tier_${tier}` };
  }
  return { ok: true };
}
