/**
 * VTID-04895 — the partner terms lifecycle.
 *
 * The version in force is the single `published` row of
 * partner_terms_versions (it replaces the never-set PARTNER_TERMS_VERSION env
 * var). English is binding (owner decision 2026-10-05); other locales in
 * `content` are translations shown alongside.
 *
 * Re-acceptance: every published version carries `baseline_version_id`. An
 * org has accepted the terms in force when it accepted any version with the
 * current baseline — an editorial update keeps acceptances valid, a material
 * one does not. Live suppliers stay live either way (owner decision O-1): the
 * status just shows the terms step open again.
 *
 * Acceptance is only ever the supplier's own signed-in session on Vitanaland.
 * A token an AI assistant received through OAuth (Commerce MCP connection) is
 * refused twice over: by its `client_id` claim, and by the session it belongs
 * to (auth.sessions.oauth_client_id). Either check failing — or not being able
 * to run — refuses.
 */
import type { Supa } from '../routes/partner-onboarding';

export const BINDING_LOCALE = 'en';

export interface PublishedTerms {
  id: string;
  version: string;
  baseline_version_id: string;
  content_sha256: string;
  requires_reacceptance: boolean;
  published_at: string;
  content: Record<string, { title?: string; body_md?: string }>;
}

const TERMS_FIELDS = 'id, version, baseline_version_id, content_sha256, requires_reacceptance, published_at, content';

/**
 * The published terms, or null when none are published. Fails closed: if the
 * table is missing (migration not applied yet) or the read errors, this is
 * "not published" — exactly the behaviour before VTID-04895.
 */
export async function loadCurrentTerms(s: Supa): Promise<PublishedTerms | null> {
  try {
    const { data, error } = await s.from('partner_terms_versions').select(TERMS_FIELDS).eq('status', 'published').maybeSingle();
    if (error) {
      console.warn(`[VTID-04895] partner terms unreadable, treating as not published: ${error.message}`);
      return null;
    }
    const row = data as Partial<PublishedTerms> | null;
    // Anything that is not a well-formed published row reads as "not published".
    if (!row || typeof row.id !== 'string' || typeof row.version !== 'string' || typeof row.content_sha256 !== 'string' || typeof row.baseline_version_id !== 'string') {
      return null;
    }
    return row as PublishedTerms;
  } catch (e) {
    console.warn(`[VTID-04895] partner terms unreadable, treating as not published: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** The version strings whose acceptance counts for the terms in force. */
export async function loadBaselineVersions(s: Supa, current: PublishedTerms): Promise<string[]> {
  try {
    const { data, error } = await s.from('partner_terms_versions').select('version').eq('baseline_version_id', current.baseline_version_id);
    if (error || !Array.isArray(data)) return [current.version];
    const versions = (data as Array<{ version: string }>).map((r) => r.version);
    return versions.includes(current.version) ? versions : [...versions, current.version];
  } catch {
    return [current.version];
  }
}

/**
 * What the supplier is shown: the English (binding) text, and the caller's
 * language alongside when a translation exists. `shown_locale` records it.
 */
export function termsForDisplay(terms: PublishedTerms, locale: string | null | undefined) {
  const binding = terms.content[BINDING_LOCALE] ?? {};
  const lang = (locale ?? '').toLowerCase().split(/[-_]/)[0];
  const tr = lang && lang !== BINDING_LOCALE ? terms.content[lang] : undefined;
  const translation = tr && tr.title && tr.body_md ? { locale: lang, title: tr.title, body_md: tr.body_md } : null;
  return {
    id: terms.id,
    version: terms.version,
    published_at: terms.published_at,
    content_sha256: terms.content_sha256,
    binding_locale: BINDING_LOCALE,
    binding: { title: binding.title ?? '', body_md: binding.body_md ?? '' },
    translation,
    shown_locale: translation ? `${BINDING_LOCALE}+${translation.locale}` : BINDING_LOCALE,
  };
}

export type DelegationVerdict = 'direct' | 'delegated' | 'unknown';

/**
 * Whether the request comes from the supplier's own session (`direct`).
 * `delegated`: an OAuth client (AI assistant) holds this token. `unknown`: it
 * could not be established — treated as refused by the caller.
 */
export async function requestDelegation(s: Supa, claims: Record<string, unknown> | undefined): Promise<DelegationVerdict> {
  if (!claims) return 'unknown';
  // Check 1: Supabase puts `client_id` on every access token its OAuth 2.1
  // server issues; a normal app session has none.
  if (claims.client_id !== undefined && claims.client_id !== null) return 'delegated';
  // Check 2: the session itself, independently of the token's claims.
  const sessionId = typeof claims.session_id === 'string' ? claims.session_id : null;
  if (!sessionId) return 'unknown';
  try {
    const { data, error } = await (s as any).rpc('auth_session_is_delegated', { p_session_id: sessionId });
    if (error) return 'unknown';
    if (data === 'direct') return 'direct';
    if (data === 'delegated') return 'delegated';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
