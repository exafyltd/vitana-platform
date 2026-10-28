/**
 * VTID-04895 — the partner terms lifecycle.
 * VTID-04909 — German is binding (owner decision 2026-10-06, replacing the
 * English rule of 2026-10-05).
 *
 * The version in force is the single `published` row of
 * partner_terms_versions (it replaces the never-set PARTNER_TERMS_VERSION env
 * var). `content` holds one { title, body_md } per language, keyed by exact
 * BCP-47 code (SUPPORTED_TERMS_LOCALES). German (`de`) is the canonical,
 * legally binding text and the only input to the content hash:
 * sha256(UTF-8(de.title + "\n" + de.body_md)), computed by the database at
 * publish. English is required as the second language; the others are
 * translations for understanding. A supplier reads one language at a time
 * (their app language, German when it is missing) and may switch; switching
 * never changes the version or hash they accept.
 *
 * Translations are part of the immutable published version: a translation
 * correction is a new version published without re-acceptance (same
 * baseline, same canonical hash when German is unchanged). The acceptance's
 * version id + shown_locale identify exactly which translation was on screen.
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

export const BINDING_LOCALE = 'de';

/** Every language the partner terms can carry, in display order (owner order). Exact BCP-47 keys. */
export const SUPPORTED_TERMS_LOCALES = ['de', 'en', 'es', 'sr', 'fr', 'pt-BR', 'ru', 'pl', 'ar', 'zh-CN', 'tr'] as const;
export type TermsLocale = (typeof SUPPORTED_TERMS_LOCALES)[number];

/** Languages a version must carry: German (binding) and English (second language). */
export const REQUIRED_TERMS_LOCALES: readonly TermsLocale[] = ['de', 'en'];

const RTL_TERMS_LOCALES: ReadonlySet<string> = new Set(['ar']);

export function isSupportedTermsLocale(key: string): key is TermsLocale {
  return (SUPPORTED_TERMS_LOCALES as readonly string[]).includes(key);
}

/**
 * The terms language for a requested locale (usually the app's catalog key:
 * de-DE, en-US, pt-BR, ar-XA, zh-CN …), among the languages a version has.
 * Exact key first (case-insensitive, `_` read as `-`); then, only for keys
 * that are a bare language (de, en, ar …), the request's base language.
 * `pt-BR` and `zh-CN` are only ever matched exactly: `pt`, `pt-PT`, `zh`,
 * `zh-TW` match nothing. Nothing matched → German, never English.
 */
export function resolveTermsLocale(requested: string | null | undefined, available: readonly string[]): { locale: TermsLocale; fallback: boolean } {
  const req = (requested ?? '').trim().replace(/_/g, '-').toLowerCase();
  const has = (k: string) => available.includes(k) && isSupportedTermsLocale(k);
  if (req) {
    const exact = SUPPORTED_TERMS_LOCALES.find((k) => k.toLowerCase() === req);
    if (exact && has(exact)) return { locale: exact, fallback: false };
    const base = req.split('-')[0];
    const bare = SUPPORTED_TERMS_LOCALES.find((k) => !k.includes('-') && k === base);
    if (bare && has(bare)) return { locale: bare, fallback: false };
  }
  return { locale: BINDING_LOCALE, fallback: req !== '' };
}

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

/** The languages a version carries (title and body present), in display order. */
export function availableTermsLocales(terms: Pick<PublishedTerms, 'content'>): TermsLocale[] {
  return SUPPORTED_TERMS_LOCALES.filter((k) => {
    const v = terms.content?.[k];
    return Boolean(v && typeof v.title === 'string' && v.title.trim() && typeof v.body_md === 'string' && v.body_md.trim());
  });
}

/**
 * What the supplier is shown: one language — the requested one, German when
 * it is missing — plus the binding German text and the version's canonical
 * hash, which does not depend on the language shown. `shown_locale` is the
 * language on screen; the accept call sends it back.
 * `translation` is kept for clients that still render the binding text and a
 * translation side by side.
 */
export function termsForDisplay(terms: PublishedTerms, locale: string | null | undefined) {
  const available = availableTermsLocales(terms);
  const { locale: shown, fallback } = resolveTermsLocale(locale, available);
  const binding = terms.content[BINDING_LOCALE] ?? {};
  const text = terms.content[shown] ?? {};
  const shownText = { title: text.title ?? '', body_md: text.body_md ?? '' };
  return {
    id: terms.id,
    version: terms.version,
    published_at: terms.published_at,
    content_sha256: terms.content_sha256,
    binding_locale: BINDING_LOCALE,
    binding: { title: binding.title ?? '', body_md: binding.body_md ?? '' },
    locale: shown,
    fallback,
    direction: RTL_TERMS_LOCALES.has(shown) ? ('rtl' as const) : ('ltr' as const),
    text: shownText,
    available_locales: available,
    translation: shown !== BINDING_LOCALE ? { locale: shown, ...shownText } : null,
    shown_locale: shown,
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
