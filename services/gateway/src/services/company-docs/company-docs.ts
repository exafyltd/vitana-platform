/**
 * VTID-04821: Exafy company document search (Jev P3 E1,
 * docs/JEV-INTEGRATION-PLAN.md §10.4 E1).
 *
 * Owner decision 2026-10-01: company documentation lives on the Exafy
 * corporate Google Drive (and OneDrive), reached only through Exafy accounts
 * (d.stevanovic@exafy.io, j.tadic@exafy.io today). So:
 *
 *   - Staff-only. The Operator Console tools that use this check the caller is
 *     a verified exafy_admin; nothing here is on the member Connected Apps
 *     screen.
 *   - A connection only counts when its account email is on a company domain
 *     (COMPANY_DOCS_DOMAINS, default exafy.io). A private Gmail or Outlook
 *     account is never searched, even when it is connected.
 *   - Read-only: drive.readonly / Files.Read.All. Names, types, dates and links
 *     only; file contents are never downloaded.
 *   - Each person searches their own drive with their own grant, so the
 *     provider's sharing rules decide what they see.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { MICROSOFT_BASE_SCOPES, getOAuthUrl } from '../social-connect-service';
import { getConnectorAccessToken } from '../../connectors/runtime/dispatcher';
import { fetchCompanyDocsConnection } from './company-docs-repository';

export type CompanyDocsProvider = 'google' | 'microsoft';
export const COMPANY_DOCS_PROVIDERS: CompanyDocsProvider[] = ['google', 'microsoft'];

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const ONEDRIVE_SCOPE = 'Files.Read.All';

/** What a company-docs consent asks for: sign-in identity (the account email) plus read-only files. */
export const COMPANY_DOCS_SCOPES: Record<CompanyDocsProvider, string[]> = {
  google: ['openid', 'email', 'profile', GOOGLE_DRIVE_SCOPE],
  microsoft: [...MICROSOFT_BASE_SCOPES, ONEDRIVE_SCOPE],
};

const MAX_RESULTS = 10;

export interface CompanyDoc {
  provider: CompanyDocsProvider;
  id: string;
  name: string;
  mime: string | null;
  modified: string | null;
  url: string | null;
}

export type SourceStatus = 'searched' | 'not_connected' | 'not_company_account' | 'scope_missing' | 'token_unavailable' | 'provider_error';

export interface CompanyDocsSource {
  provider: CompanyDocsProvider;
  status: SourceStatus;
  account?: string;
  error?: string;
}

/** Company email domains (COMPANY_DOCS_DOMAINS, comma separated; default exafy.io). */
export function companyDocsDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.COMPANY_DOCS_DOMAINS ?? 'exafy.io').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  return raw.length ? raw : ['exafy.io'];
}

/** Whether an account email belongs to the company. Exact domain, never a subdomain or look-alike. */
export function isCompanyAccount(email: string | null | undefined, domains: string[]): boolean {
  if (!email) return false;
  const at = email.trim().toLowerCase().lastIndexOf('@');
  if (at < 1) return false;
  return domains.includes(email.trim().toLowerCase().slice(at + 1));
}

function scopeList(scopes: unknown): string[] {
  if (Array.isArray(scopes)) return scopes.map(String);
  if (typeof scopes === 'string') return scopes.split(/[\s,]+/).filter(Boolean);
  return [];
}

/** Whether a granted scope list covers the provider's read-only files scope (Microsoft returns it lower-case or URL-qualified). */
export function hasFilesScope(provider: CompanyDocsProvider, scopes: unknown): boolean {
  const want = provider === 'google' ? GOOGLE_DRIVE_SCOPE : ONEDRIVE_SCOPE.toLowerCase();
  return scopeList(scopes).some((s) => {
    const v = s.toLowerCase();
    return provider === 'google' ? v === want || v === 'https://www.googleapis.com/auth/drive' : v === want || v.endsWith(`/${want}`);
  });
}

/** Drive v3 `q`: full-text match, not in the trash. Backslashes and quotes escaped. */
export function driveQuery(query: string): string {
  const q = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `fullText contains '${q}' and trashed = false`;
}

/** Graph drive search path. A quote is doubled (OData), then the whole term is URL-encoded. */
export function oneDriveSearchPath(query: string): string {
  return `/me/drive/root/search(q='${encodeURIComponent(query.replace(/'/g, "''"))}')`;
}

export interface CompanyDocsDeps {
  sb: SupabaseClient;
  fetch?: typeof fetch;
  token?: (provider: CompanyDocsProvider) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
}

async function searchGoogle(token: string, query: string, f: typeof fetch): Promise<CompanyDoc[]> {
  const params = new URLSearchParams({
    q: driveQuery(query),
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
    pageSize: String(MAX_RESULTS),
    corpora: 'allDrives',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
  });
  const r = await f(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const json: any = await r.json().catch(() => null);
  if (!r.ok) throw new Error(json?.error?.message ?? `HTTP ${r.status}`);
  return (json?.files ?? []).slice(0, MAX_RESULTS).map((x: any) => ({
    provider: 'google' as const, id: String(x.id), name: String(x.name ?? ''), mime: x.mimeType ?? null, modified: x.modifiedTime ?? null, url: x.webViewLink ?? null,
  }));
}

async function searchMicrosoft(token: string, query: string, f: typeof fetch): Promise<CompanyDoc[]> {
  const url = `https://graph.microsoft.com/v1.0${oneDriveSearchPath(query)}?$top=${MAX_RESULTS}&$select=id,name,webUrl,lastModifiedDateTime,file,folder`;
  const r = await f(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const json: any = await r.json().catch(() => null);
  if (!r.ok) throw new Error(json?.error?.message ?? `HTTP ${r.status}`);
  return (json?.value ?? []).slice(0, MAX_RESULTS).map((x: any) => ({
    provider: 'microsoft' as const, id: String(x.id), name: String(x.name ?? ''), mime: x.file?.mimeType ?? (x.folder ? 'folder' : null), modified: x.lastModifiedDateTime ?? null, url: x.webUrl ?? null,
  }));
}

/**
 * Search the caller's own company drives. Google first (company documentation
 * is on the Exafy Drive), then OneDrive. Each source reports why it was or
 * was not searched; a failing provider never hides the other's results.
 */
export async function searchCompanyDocs(userId: string, query: string, deps: CompanyDocsDeps): Promise<{ docs: CompanyDoc[]; sources: CompanyDocsSource[] }> {
  const env = deps.env ?? process.env;
  const f = deps.fetch ?? fetch;
  const domains = companyDocsDomains(env);
  const token = deps.token ?? ((p: CompanyDocsProvider) => getConnectorAccessToken(deps.sb, userId, p));
  const docs: CompanyDoc[] = [];
  const sources: CompanyDocsSource[] = [];
  for (const provider of COMPANY_DOCS_PROVIDERS) {
    const { data } = await fetchCompanyDocsConnection(deps.sb, userId, provider);
    if (!data) { sources.push({ provider, status: 'not_connected' }); continue; }
    const account = data.provider_username ?? undefined;
    if (!isCompanyAccount(account, domains)) { sources.push({ provider, status: 'not_company_account' }); continue; }
    if (!hasFilesScope(provider, data.scopes)) { sources.push({ provider, status: 'scope_missing', account }); continue; }
    const t = await token(provider);
    if (!t) { sources.push({ provider, status: 'token_unavailable', account }); continue; }
    try {
      docs.push(...(provider === 'google' ? await searchGoogle(t, query, f) : await searchMicrosoft(t, query, f)));
      sources.push({ provider, status: 'searched', account });
    } catch (err: any) {
      sources.push({ provider, status: 'provider_error', account, error: String(err?.message ?? err).slice(0, 200) });
    }
  }
  return { docs, sources };
}

/**
 * The consent link for connecting a company drive. Keeps the scopes the
 * connection already has, so connecting Drive never drops Gmail or Calendar.
 */
export async function companyDocsConnectUrl(a: {
  userId: string;
  tenantId: string;
  provider: CompanyDocsProvider;
  sb: SupabaseClient;
}): Promise<{ ok: true; auth_url: string } | { ok: false; error: string }> {
  const { data } = await fetchCompanyDocsConnection(a.sb, a.userId, a.provider);
  const scopes = Array.from(new Set([...COMPANY_DOCS_SCOPES[a.provider], ...scopeList(data?.scopes)]));
  const { url, error } = getOAuthUrl(a.provider, a.userId, a.tenantId, { returnMode: 'web', scopesOverride: scopes, mode: data ? 'incremental' : 'full' });
  if (error || !url) return { ok: false, error: error ?? 'oauth_unavailable' };
  return { ok: true, auth_url: url };
}
