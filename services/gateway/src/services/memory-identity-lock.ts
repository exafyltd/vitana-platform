/**
 * VTID-01952 — Memory Identity Lock
 *
 * Prevents the Maria → Kemal class of bug: memory writes that overwrite the
 * user's name, birthday, gender, email, etc. from voice / inference paths.
 *
 * IDENTITY-CLASS facts (name, DOB, gender, pronouns, email, phone, address,
 * locale, role, tenant_id) can ONLY be written from authorized UI surfaces:
 *   - Profile / Settings screen
 *   - Memory Garden manual entry
 *   - Onboarding flow
 *   - Baseline survey
 *   - Admin correction
 *   - System provisioning (signup trigger)
 *
 * The brain must REFUSE voice/text intents to mutate locked fields and
 * REDIRECT the user to the authorized UI surface. This module is the single
 * application-layer chokepoint enforcing that contract; the DB trigger
 * `enforce_identity_lock_memory_facts` (migration vtid_01952) is defense-in-depth.
 *
 * Mirror of SQL functions:
 *   - public.identity_locked_fact_keys()
 *   - public.identity_authorized_sources()
 * (CI lint enforces sync between this file and the migration.)
 *
 * See: /home/dstev/.claude/plans/the-vitana-system-has-wild-puffin.md  Part 1.5
 */

// ============================================================================
// Locked fact keys — mirror of public.identity_locked_fact_keys() in SQL
// ============================================================================

export const IDENTITY_LOCKED_KEYS = [
  // Name
  'user_first_name',
  'user_last_name',
  'user_display_name',
  'user_full_name',
  // Birth
  'user_date_of_birth',
  'user_birthday',
  // Identity attributes
  'user_gender',
  'user_pronouns',
  'user_marital_status',
  // Contact
  'user_email',
  'user_phone',
  // Address
  'user_country',
  'user_city',
  'user_address',
  // Locale + role
  'user_locale',
  'user_account_type',
  'user_role',
  'user_tenant_id',
] as const;

export type IdentityLockedKey = (typeof IDENTITY_LOCKED_KEYS)[number];

const LOCKED_KEYS_SET: ReadonlySet<string> = new Set(IDENTITY_LOCKED_KEYS);

export function isIdentityLockedKey(factKey: string): factKey is IdentityLockedKey {
  return LOCKED_KEYS_SET.has(factKey);
}

// ============================================================================
// Authorized provenance sources — mirror of public.identity_authorized_sources()
// ============================================================================

export const IDENTITY_AUTHORIZED_SOURCES = [
  'user_stated_via_settings',
  'user_stated_via_memory_garden_ui',
  'user_stated_via_onboarding',
  'user_stated_via_baseline_survey',
  'admin_correction',
  'system_provision',
] as const;

export type IdentityAuthorizedSource = (typeof IDENTITY_AUTHORIZED_SOURCES)[number];

const AUTHORIZED_SOURCES_SET: ReadonlySet<string> = new Set(IDENTITY_AUTHORIZED_SOURCES);

export function isIdentityAuthorizedSource(source: string): source is IdentityAuthorizedSource {
  return AUTHORIZED_SOURCES_SET.has(source);
}

// ============================================================================
// Soft-lock taxonomy
//
// HARD-locked: refusal + redirect (no voice change ever)
// SOFT-locked: voice can propose change WITH explicit confirmation
// FREE       : voice can write directly with provenance=user_stated
// ============================================================================

export type IdentityLockLevel = 'hard' | 'soft' | 'free';

const SOFT_LOCKED_KEYS = new Set([
  'active_life_compass_goal',
  'preferred_language',
  'communication_style',
  'ai_personality_preset',
]);

export function getLockLevel(factKey: string): IdentityLockLevel {
  if (isIdentityLockedKey(factKey)) return 'hard';
  if (SOFT_LOCKED_KEYS.has(factKey)) return 'soft';
  return 'free';
}

// ============================================================================
// Redirect targets — when we refuse, the brain emits a deep-link event so
// the frontend can route the user to the right screen and field.
//
// Frontend handlers in vitana-v1 listen for these custom events and navigate
// + focus the relevant input. (Pattern mirrors G3 vitana:open-life-compass.)
// ============================================================================

export interface RedirectTarget {
  /** Custom DOM event name the frontend listens for. */
  event: 'vitana:open-profile-edit' | 'vitana:open-account-settings' | 'vitana:open-app-settings';
  /** Payload — section + field hint to focus the right input. */
  payload: {
    section: string;
    field?: string;
  };
}

const REDIRECT_TARGETS: Record<IdentityLockedKey, RedirectTarget> = {
  user_first_name:      { event: 'vitana:open-profile-edit',     payload: { section: 'personal_info', field: 'first_name' } },
  user_last_name:       { event: 'vitana:open-profile-edit',     payload: { section: 'personal_info', field: 'last_name' } },
  user_display_name:    { event: 'vitana:open-profile-edit',     payload: { section: 'personal_info', field: 'display_name' } },
  user_full_name:       { event: 'vitana:open-profile-edit',     payload: { section: 'personal_info', field: 'first_name' } },
  user_date_of_birth:   { event: 'vitana:open-profile-edit',     payload: { section: 'personal_info', field: 'date_of_birth' } },
  user_birthday:        { event: 'vitana:open-profile-edit',     payload: { section: 'personal_info', field: 'date_of_birth' } },
  user_gender:          { event: 'vitana:open-profile-edit',     payload: { section: 'personal_info', field: 'gender' } },
  user_pronouns:        { event: 'vitana:open-profile-edit',     payload: { section: 'personal_info', field: 'pronouns' } },
  user_marital_status:  { event: 'vitana:open-profile-edit',     payload: { section: 'personal_info', field: 'marital_status' } },
  user_email:           { event: 'vitana:open-account-settings', payload: { section: 'contact',       field: 'email' } },
  user_phone:           { event: 'vitana:open-account-settings', payload: { section: 'contact',       field: 'phone' } },
  user_country:         { event: 'vitana:open-profile-edit',     payload: { section: 'address',       field: 'country' } },
  user_city:            { event: 'vitana:open-profile-edit',     payload: { section: 'address',       field: 'city' } },
  user_address:         { event: 'vitana:open-profile-edit',     payload: { section: 'address',       field: 'address' } },
  user_locale:          { event: 'vitana:open-app-settings',     payload: { section: 'language' } },
  user_account_type:    { event: 'vitana:open-account-settings', payload: { section: 'account_type' } },
  user_role:            { event: 'vitana:open-account-settings', payload: { section: 'role' } },
  user_tenant_id:       { event: 'vitana:open-account-settings', payload: { section: 'tenant' } },
};

export function getRedirectTarget(factKey: IdentityLockedKey): RedirectTarget {
  return REDIRECT_TARGETS[factKey];
}

// ============================================================================
// Sanctioned refusal phrasing — used by the brain when an identity-mutation
// intent is detected. EN + DE today; expand per locale as needed.
//
// "Silent honor" tone (per Proactive Guide rules): no apology, no grovelling,
// helpful pivot to the right surface.
// ============================================================================

export type SupportedLocale = 'en' | 'de';

interface RefusalPhrasing {
  /** Human-readable label for the field, used inside the refusal message. */
  fieldLabel: string;
  /** "I can't change your <fieldLabel> from a conversation — it has to be done in <surfaceLabel>." */
  surfaceLabel: string;
  /** Friendly call-to-action: "Want me to take you there?" */
  cta: string;
}

const FIELD_LABELS: Record<IdentityLockedKey, Record<SupportedLocale, string>> = {
  user_first_name:      { en: 'first name',          de: 'Vornamen' },
  user_last_name:       { en: 'last name',           de: 'Nachnamen' },
  user_display_name:    { en: 'display name',        de: 'Anzeigenamen' },
  user_full_name:       { en: 'name',                de: 'Namen' },
  user_date_of_birth:   { en: 'date of birth',       de: 'Geburtsdatum' },
  user_birthday:        { en: 'birthday',            de: 'Geburtstag' },
  user_gender:          { en: 'gender',              de: 'Geschlecht' },
  user_pronouns:        { en: 'pronouns',            de: 'Pronomen' },
  user_marital_status:  { en: 'marital status',      de: 'Familienstand' },
  user_email:           { en: 'email',               de: 'E-Mail-Adresse' },
  user_phone:           { en: 'phone number',        de: 'Telefonnummer' },
  user_country:         { en: 'country',             de: 'Land' },
  user_city:            { en: 'city',                de: 'Stadt' },
  user_address:         { en: 'address',             de: 'Adresse' },
  user_locale:          { en: 'language preference', de: 'Spracheinstellung' },
  user_account_type:    { en: 'account type',        de: 'Kontotyp' },
  user_role:            { en: 'role',                de: 'Rolle' },
  user_tenant_id:       { en: 'workspace',           de: 'Workspace' },
};

const SURFACE_LABELS: Record<RedirectTarget['event'], Record<SupportedLocale, string>> = {
  'vitana:open-profile-edit':     { en: 'your Profile',          de: 'deinem Profil' },
  'vitana:open-account-settings': { en: 'Account Settings',      de: 'den Kontoeinstellungen' },
  'vitana:open-app-settings':     { en: 'App Settings',          de: 'den App-Einstellungen' },
};

const CTA_PHRASE: Record<SupportedLocale, string> = {
  en: 'Want me to take you there?',
  de: 'Soll ich dich dorthin bringen?',
};

/**
 * Build the sanctioned refusal sentence the brain should speak/write.
 * Returns both the message string and the redirect_target the frontend needs.
 */
export function composeIdentityRefusal(
  factKey: IdentityLockedKey,
  locale: SupportedLocale = 'en'
): { message: string; redirect_target: RedirectTarget } {
  const target = getRedirectTarget(factKey);
  const fieldLabel = FIELD_LABELS[factKey][locale];
  const surfaceLabel = SURFACE_LABELS[target.event][locale];
  const cta = CTA_PHRASE[locale];

  const message = locale === 'de'
    ? `Deinen ${fieldLabel} kann ich nicht aus dem Gespräch heraus ändern — das musst du in ${surfaceLabel} machen, damit es überall stimmt. ${cta}`
    : `I can't change your ${fieldLabel} from a conversation — that has to be done in ${surfaceLabel} so it stays consistent everywhere. ${cta}`;

  return { message, redirect_target: target };
}

// ============================================================================
// The chokepoint: assertIdentityLockOk()
//
// Called by the unified write broker (memory-audit.ts) BEFORE every
// memory_facts write. Throws IdentityLockViolation with a structured
// rejection result that the broker converts into a graceful brain response.
// ============================================================================

export interface IdentityLockCheckInput {
  fact_key: string;
  provenance_source: string | null | undefined;
  /** The actor identity at the broker layer (not the DB session var). */
  actor_id: string;
}

export class IdentityLockViolation extends Error {
  readonly code = 'IDENTITY_LOCKED' as const;
  readonly fact_key: string;
  readonly attempted_provenance_source: string | null | undefined;
  readonly attempted_actor_id: string;
  readonly redirect_target: RedirectTarget | null;

  constructor(input: IdentityLockCheckInput) {
    super(
      `identity_locked: fact_key=${input.fact_key} cannot be written with provenance_source=${
        input.provenance_source ?? '<null>'
      } / actor_id=${input.actor_id}. Authorized: ${IDENTITY_AUTHORIZED_SOURCES.join(', ')}.`
    );
    this.name = 'IdentityLockViolation';
    this.fact_key = input.fact_key;
    this.attempted_provenance_source = input.provenance_source;
    this.attempted_actor_id = input.actor_id;
    this.redirect_target = isIdentityLockedKey(input.fact_key)
      ? getRedirectTarget(input.fact_key)
      : null;
  }
}

/**
 * Throws IdentityLockViolation if the fact_key is identity-locked AND the
 * provenance_source is NOT in the authorized list.
 *
 * Returns silently otherwise (including for non-locked keys, which is the
 * common path — most writes are not identity-class).
 */
export function assertIdentityLockOk(input: IdentityLockCheckInput): void {
  if (!isIdentityLockedKey(input.fact_key)) {
    return; // Not locked: any provenance is fine.
  }
  if (input.provenance_source && isIdentityAuthorizedSource(input.provenance_source)) {
    return; // Locked but authorized: allow.
  }
  throw new IdentityLockViolation(input);
}

// ============================================================================
// CLI/test helpers (safe to import from tests)
// ============================================================================

/** Deterministic ordering for snapshot tests (matches SQL function order). */
export function getLockedKeysSorted(): readonly IdentityLockedKey[] {
  return [...IDENTITY_LOCKED_KEYS];
}

export function getAuthorizedSourcesSorted(): readonly IdentityAuthorizedSource[] {
  return [...IDENTITY_AUTHORIZED_SOURCES];
}
