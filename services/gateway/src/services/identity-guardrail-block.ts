/**
 * VTID-01952 — Identity Guardrail Block (brain prompt section)
 *
 * Builds the [USER IDENTITY] block injected at the TOP of every brain system
 * prompt. Identity values come from app_users (canonical) — NEVER from
 * memory_facts (mirror) — so even if Cognee or some legacy bug wrote a
 * wrong name into memory, the brain can never speak it.
 *
 * Two guardrails:
 *   A) Authoritative identity block — names the canonical values + tells the
 *      model these are immutable from conversation.
 *   B) Anti-drift rule — instructs the model to NEVER use any other value
 *      for these fields, regardless of what memory blocks contain.
 *
 * Plan reference: /home/dstev/.claude/plans/the-vitana-system-has-wild-puffin.md
 *                 Part 1.5 — Identity Invariants → Brain-prompt guardrails
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// Columns on app_users that we treat as identity-class for the prompt block.
// Mirrors IDENTITY_LOCKED_KEYS in memory-identity-lock.ts (different shape
// because app_users uses snake_case column names without the user_ prefix).
const IDENTITY_COLUMNS = [
  'first_name',
  'last_name',
  'display_name',
  'date_of_birth',
  'gender',
  'pronouns',
  'locale',
  'country',
  'city',
] as const;

interface IdentityRow {
  first_name?: string | null;
  last_name?: string | null;
  display_name?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
  pronouns?: string | null;
  locale?: string | null;
  country?: string | null;
  city?: string | null;
}

export interface BuildIdentityGuardrailBlockInput {
  user_id: string;
  tenant_id?: string;
}

/**
 * Build the [USER IDENTITY] guardrail block. Always returns a string —
 * empty string if app_users lookup fails (graceful degradation; the
 * write-side trigger still protects).
 *
 * Cache key (for Anthropic prompt caching upstream): include
 * app_users.updated_at so a profile change invalidates the cache.
 */
export async function buildIdentityGuardrailBlock(
  input: BuildIdentityGuardrailBlockInput
): Promise<string> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-01952] identity-guardrail: Supabase env missing — skipping block');
    return '';
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let row: IdentityRow | null = null;
  try {
    const { data, error } = await supabase
      .from('app_users')
      .select(IDENTITY_COLUMNS.join(','))
      .eq('user_id', input.user_id)
      .maybeSingle();

    if (error) {
      console.warn('[VTID-01952] identity-guardrail: app_users select error:', error.message);
      return '';
    }
    row = (data as unknown) as IdentityRow | null;
  } catch (err) {
    console.warn('[VTID-01952] identity-guardrail: lookup failed:', err);
    return '';
  }

  if (!row) {
    // No app_users row yet (pre-onboarding / signup race) — skip block, brain
    // will use whatever the upstream display_name plumbing provides.
    return '';
  }

  const nameParts = [row.first_name, row.last_name].filter(Boolean) as string[];
  const fullName =
    row.display_name ||
    (nameParts.length > 0 ? nameParts.join(' ') : null);

  const lines: string[] = [];
  if (fullName) lines.push(`- Name: ${fullName}`);
  if (row.date_of_birth) {
    const ageYears = computeAgeYears(row.date_of_birth);
    lines.push(`- Date of birth: ${row.date_of_birth}${ageYears !== null ? ` (${ageYears} years old)` : ''}`);
  }
  if (row.gender) lines.push(`- Gender: ${row.gender}`);
  if (row.pronouns) lines.push(`- Pronouns: ${row.pronouns}`);
  if (row.locale) lines.push(`- Locale: ${row.locale}`);
  if (row.country || row.city) {
    const loc = [row.city, row.country].filter(Boolean).join(', ');
    if (loc) lines.push(`- Location: ${loc}`);
  }

  if (lines.length === 0) {
    return ''; // Nothing identity-class set yet — no block (avoid noise).
  }

  // Guardrail A: authoritative identity block (canonical, immutable from conversation).
  // Guardrail B: anti-drift rule (never echo a different value).
  // The Identity Update Protocol section the model is told to follow is built
  // by composeIdentityRefusal() at runtime when an identity-mutation intent
  // is detected — see memory-identity-lock.ts.
  return [
    '[USER IDENTITY — canonical, immutable from this conversation]',
    ...lines,
    '',
    'These facts come from the user\'s Profile / Account / Settings and CANNOT be changed by you in this conversation.',
    '',
    'GUARDRAIL — anti-drift (NON-NEGOTIABLE):',
    '- NEVER address the user by any name other than the one above.',
    '- NEVER state the user\'s age, birthday, gender, pronouns, email, phone, or address from a value other than what is shown above.',
    '- If memory blocks below contain a different value for any of these fields, IGNORE the memory block and use the [USER IDENTITY] above. The Profile is the only source of truth.',
    '- If the user asks you to change any of these fields ("call me X", "my birthday is Y", "change my email to Z"), respond with the sanctioned refusal: tell them this kind of basic information can only be changed in their Profile / Settings, and offer to take them there. NEVER perform the change yourself, NEVER promise that you will, NEVER ask follow-ups about the new value.',
    '- If unsure whether a fact in memory belongs to the user vs someone they mentioned, default to [USER IDENTITY] for self-referencing fields.',
    '',
  ].join('\n');
}

function computeAgeYears(dobIso: string): number | null {
  try {
    const dob = new Date(dobIso);
    if (Number.isNaN(dob.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
    return age >= 0 && age < 130 ? age : null;
  } catch {
    return null;
  }
}
