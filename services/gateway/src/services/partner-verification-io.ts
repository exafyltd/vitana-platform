/**
 * VTID-04486 — the I/O behind partner verification (spec §7): the VIES VAT
 * lookup, the domain-ownership lookups and the email-confirmation read.
 * Every function reports an outcome and never throws, so a slow or broken
 * outside service becomes `unavailable` for one check instead of a 500.
 */

import { resolveTxt } from 'node:dns/promises';
import { ssrfGuardedFetch } from './platform-detect';
import { DOMAIN_TXT_PREFIX } from './partner-verification';

const VIES_BASE = 'https://ec.europa.eu/taxation_customs/vies/rest-api';
const VIES_TIMEOUT_MS = 8000;

export interface ViesResult {
  status: 'valid' | 'invalid' | 'unavailable';
  /** Registered name as VIES returns it; null when the member state withholds it. */
  name: string | null;
  error?: string;
}

/** VIES userError values that mean the number itself is wrong. */
const VIES_INVALID = new Set(['INVALID', 'INVALID_INPUT']);

export async function checkVatVies(
  countryCode: string,
  number: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ViesResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIES_TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${VIES_BASE}/ms/${encodeURIComponent(countryCode)}/vat/${encodeURIComponent(number)}`,
      { headers: { Accept: 'application/json' }, signal: controller.signal },
    );
    if (!res.ok) return { status: 'unavailable', name: null, error: `http_${res.status}` };
    const body = (await res.json()) as { isValid?: unknown; userError?: unknown; name?: unknown };
    const name = typeof body.name === 'string' && body.name.trim() && body.name.trim() !== '---' ? body.name.trim() : null;
    if (body.isValid === true) return { status: 'valid', name };
    const userError = typeof body.userError === 'string' ? body.userError : '';
    if (VIES_INVALID.has(userError)) return { status: 'invalid', name: null, error: userError };
    return { status: 'unavailable', name: null, error: userError || 'no_verdict' };
  } catch (err) {
    return { status: 'unavailable', name: null, error: controller.signal.aborted ? 'timeout' : String((err as Error)?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** TXT records at _vitana-verification.<host>; [] when none or the lookup fails. */
export async function lookupDomainProofTxt(host: string): Promise<string[][]> {
  try {
    return await resolveTxt(`${DOMAIN_TXT_PREFIX}.${host}`);
  } catch {
    return [];
  }
}

/** The website's HTML through the SSRF-guarded fetcher; null on any failure. */
export async function fetchSiteHtml(url: string): Promise<string | null> {
  try {
    return (await ssrfGuardedFetch(url)).body;
  } catch {
    return null;
  }
}

interface AuthAdminLike {
  auth: { admin: { getUserById(id: string): Promise<{ data: { user: any } | null; error: { message: string } | null }> } };
}

/** Whether the user confirmed their email address, and which address. */
export async function readEmailConfirmation(
  supabase: AuthAdminLike,
  userId: string,
): Promise<{ status: 'confirmed' | 'unconfirmed' | 'unavailable'; email: string | null }> {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data?.user) return { status: 'unavailable', email: null };
    const user = data.user as { email?: string | null; email_confirmed_at?: string | null };
    return { status: user.email_confirmed_at ? 'confirmed' : 'unconfirmed', email: user.email ?? null };
  } catch {
    return { status: 'unavailable', email: null };
  }
}
