/**
 * VTID-05090 — the partner data processing agreement (AVV, GDPR Art. 28).
 *
 * A sibling of the partner terms lifecycle (services/partner-terms.ts,
 * VTID-04895/04909) and built from the same parts: the version in force is
 * the single `published` row of partner_dpa_versions; German is binding and
 * the only input to the hash, which the database computes at publish:
 * sha256(UTF-8(de.title + "\n" + de.body_md + "\n" + (de.signing_declaration ?? ""))).
 * The declaration the signer ticks is part of the version's text, so it is
 * part of what is signed.
 *
 * No legal text and no legal conclusion lives here. The agreement, its
 * translations and the signing declaration are data the owner/legal publishes
 * through /api/v1/admin/partner-dpa. Until a version is published every read
 * fails closed to "not published" and the onboarding step stays open
 * (`dpa_not_published`).
 *
 * Only the supplier's own signed-in session signs (requestDelegation, shared
 * with the terms). An AI assistant never signs.
 */
import type { Supa } from '../routes/partner-onboarding';
import { BINDING_LOCALE, availableTermsLocales, termsForDisplay } from './partner-terms';

export interface DpaLocaleText {
  title?: string;
  body_md?: string;
  signing_declaration?: string;
}

export interface PublishedDpa {
  id: string;
  version: string;
  baseline_version_id: string;
  content_sha256: string;
  requires_resign: boolean;
  published_at: string;
  content: Record<string, DpaLocaleText>;
}

const DPA_FIELDS = 'id, version, baseline_version_id, content_sha256, requires_resign, published_at, content';

const warn = (what: string, e: unknown) =>
  console.warn(`[VTID-05090] ${what} unreadable, treating as not published: ${e instanceof Error ? e.message : String(e)}`);

/**
 * The published agreement, or null when none is published. Fails closed: a
 * missing table (migration not applied yet) or a read error is "not
 * published", never an error the checklist could fail on.
 */
export async function loadCurrentDpa(s: Supa): Promise<PublishedDpa | null> {
  try {
    const { data, error } = await s.from('partner_dpa_versions').select(DPA_FIELDS).eq('status', 'published').maybeSingle();
    if (error) {
      warn('partner DPA', error.message);
      return null;
    }
    const row = data as Partial<PublishedDpa> | null;
    if (!row || typeof row.id !== 'string' || typeof row.version !== 'string' || typeof row.content_sha256 !== 'string' || typeof row.baseline_version_id !== 'string') {
      return null;
    }
    return { ...row, content: (row.content ?? {}) as Record<string, DpaLocaleText> } as PublishedDpa;
  } catch (e) {
    warn('partner DPA', e);
    return null;
  }
}

/** The version strings whose signature counts for the agreement in force (same baseline). */
export async function loadDpaBaselineVersions(s: Supa, current: PublishedDpa): Promise<string[]> {
  try {
    const { data, error } = await s.from('partner_dpa_versions').select('version').eq('baseline_version_id', current.baseline_version_id);
    if (error || !Array.isArray(data)) return [current.version];
    const versions = (data as Array<{ version: string }>).map((r) => r.version);
    return versions.includes(current.version) ? versions : [...versions, current.version];
  } catch {
    return [current.version];
  }
}

/** The DPA versions an org has signed. A read error is "none signed" (the step stays open). */
export async function loadSignedDpaVersions(s: Supa, orgId: string): Promise<string[]> {
  try {
    const { data, error } = await s.from('partner_dpa_signatures').select('dpa_version').eq('partner_organization_id', orgId);
    if (error || !Array.isArray(data)) {
      if (error) warn('partner DPA signatures', error.message);
      return [];
    }
    return (data as Array<{ dpa_version: string }>).map((r) => r.dpa_version).filter((v) => typeof v === 'string');
  } catch (e) {
    warn('partner DPA signatures', e);
    return [];
  }
}

/** The languages a version carries (title and body present), in display order. */
export function availableDpaLocales(dpa: Pick<PublishedDpa, 'content'>): string[] {
  return availableTermsLocales({ content: dpa.content });
}

const declarationOf = (t: DpaLocaleText | undefined): string | null =>
  typeof t?.signing_declaration === 'string' && t.signing_declaration.trim() ? t.signing_declaration : null;

/**
 * What the signer is shown: the same shape as the terms (one language at a
 * time, German when the requested one is missing, the binding German text,
 * the canonical hash) plus the signing declaration for the shown and the
 * binding language. `signing_declaration` is null when the version has none
 * for the language shown.
 */
export function dpaForDisplay(dpa: PublishedDpa, locale: string | null | undefined) {
  const base = termsForDisplay(
    {
      id: dpa.id,
      version: dpa.version,
      baseline_version_id: dpa.baseline_version_id,
      content_sha256: dpa.content_sha256,
      requires_reacceptance: dpa.requires_resign,
      published_at: dpa.published_at,
      content: dpa.content,
    },
    locale,
  );
  const shownDecl = declarationOf(dpa.content[base.locale]);
  const bindingDecl = declarationOf(dpa.content[BINDING_LOCALE]);
  return {
    id: base.id,
    version: base.version,
    published_at: base.published_at,
    content_sha256: base.content_sha256,
    binding_locale: base.binding_locale,
    binding: { ...base.binding, signing_declaration: bindingDecl },
    locale: base.locale,
    fallback: base.fallback,
    direction: base.direction,
    text: { ...base.text, signing_declaration: shownDecl },
    signing_declaration: shownDecl,
    available_locales: base.available_locales,
    shown_locale: base.shown_locale,
  };
}

export const MAX_SIGNER_NAME = 200;
export const MAX_SIGNER_ROLE = 120;

export type SignBody = {
  dpa_version: string;
  content_sha256: string;
  shown_locale: string;
  signer_name: string;
  signer_role: string;
  declaration_confirmed: true;
};

/**
 * Validates the sign request body. The name and role are what the signer
 * typed (trimmed); the role is a declaration and is never verified. The
 * declaration must be ticked (`declaration_confirmed === true`, nothing else).
 */
export function parseSignBody(body: unknown): { ok: true; value: SignBody } | { ok: false; field: string; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
  const version = str('dpa_version');
  if (!version) return { ok: false, field: 'dpa_version', error: 'dpa_version is required' };
  const hash = str('content_sha256');
  if (!hash) return { ok: false, field: 'content_sha256', error: 'content_sha256 is required' };
  const shown = str('shown_locale');
  if (!shown) return { ok: false, field: 'shown_locale', error: 'shown_locale is required' };
  const name = str('signer_name');
  if (!name || name.length > MAX_SIGNER_NAME) return { ok: false, field: 'signer_name', error: `signer_name must be 1–${MAX_SIGNER_NAME} characters` };
  const role = str('signer_role');
  if (!role || role.length > MAX_SIGNER_ROLE) return { ok: false, field: 'signer_role', error: `signer_role must be 1–${MAX_SIGNER_ROLE} characters` };
  if (b.declaration_confirmed !== true) return { ok: false, field: 'declaration_confirmed', error: 'the declaration must be confirmed' };
  return { ok: true, value: { dpa_version: version, content_sha256: hash, shown_locale: shown, signer_name: name, signer_role: role, declaration_confirmed: true } };
}
