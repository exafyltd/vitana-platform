/**
 * VTID-04405: import a member's contacts from Google, iCloud or their
 * Android phone into Vitanaland's `contacts` table.
 *
 * - De-duplicated per source (user_id, source, external_id): a second sync
 *   updates names/emails/phones instead of adding copies.
 * - Contacts who are already Vitanaland members (matched by e-mail) get
 *   contact_user_id + is_on_platform, excluding test/service accounts
 *   (CLAUDE.md rule 45 — the same allowlists as every member-facing list).
 * - Imported contacts stay the member's even if they later turn the app off;
 *   removing them is an explicit choice (removeImportedContacts).
 */

import { db, enc } from './db';

export type ContactSource = 'google' | 'icloud' | 'android';

export interface ImportContact {
  external_id: string;
  name: string;
  emails: string[];
  phones: string[];
}

export interface ImportResult {
  received: number;
  imported: number;
  on_platform: number;
}

export const MAX_CONTACTS_PER_IMPORT = 5000;
const BATCH = 500;

/** Clean one contact; null when there is nothing to keep. */
export function normalizeContact(c: Partial<ImportContact>): ImportContact | null {
  const emails = Array.from(new Set((c.emails ?? []).map((e) => String(e).trim().toLowerCase()).filter((e) => /.+@.+\..+/.test(e)))).slice(0, 5);
  const phones = Array.from(new Set((c.phones ?? []).map((p) => String(p).trim()).filter((p) => p.replace(/\D/g, '').length >= 5))).slice(0, 5);
  const name = String(c.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || emails[0] || phones[0] || '';
  if (!name) return null;
  const external = String(c.external_id ?? '').trim().slice(0, 300);
  if (!external) return null;
  return { external_id: external, name, emails, phones };
}

/** A stable id for device contacts, which carry none of their own. */
export function deviceContactId(c: { name?: string; emails?: string[]; phones?: string[] }): string {
  const key = [
    (c.name ?? '').trim().toLowerCase(),
    ...(c.emails ?? []).map((e) => e.trim().toLowerCase()).sort(),
    ...(c.phones ?? []).map((p) => p.replace(/\D/g, '')).sort(),
  ].join('|');
  // FNV-1a — collisions only merge two identical-looking entries.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `dev_${h.toString(16)}_${key.length}`;
}

async function platformMatches(emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (emails.length === 0) return out;
  const { createClient } = await import('@supabase/supabase-js');
  const { fetchExcludedTestServiceAccountIds } = await import('../../lib/excluded-test-service-accounts');
  const excluded = await fetchExcludedTestServiceAccountIds(
    createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE as string) as any,
  );
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    const list = chunk.map((e) => `"${e.replace(/"/g, '')}"`).join(',');
    const rows = (await db(`profiles?select=user_id,email&email=in.(${enc(list)})`)) as Array<{ user_id: string; email: string }>;
    for (const r of rows ?? []) {
      if (r.email && r.user_id && !excluded.has(r.user_id)) out.set(r.email.toLowerCase(), r.user_id);
    }
  }
  return out;
}

export async function importContacts(
  userId: string,
  source: ContactSource,
  raw: Array<Partial<ImportContact>>,
): Promise<ImportResult> {
  const clean: ImportContact[] = [];
  const seen = new Set<string>();
  for (const c of raw.slice(0, MAX_CONTACTS_PER_IMPORT)) {
    const n = normalizeContact(c);
    if (!n || seen.has(n.external_id)) continue;
    seen.add(n.external_id);
    clean.push(n);
  }
  const matches = await platformMatches(Array.from(new Set(clean.flatMap((c) => c.emails))));
  const now = new Date().toISOString();
  let onPlatform = 0;
  const rows = clean.map((c) => {
    const member = c.emails.map((e) => matches.get(e)).find((id) => id && id !== userId) ?? null;
    if (member) onPlatform += 1;
    return {
      user_id: userId,
      source,
      external_id: c.external_id,
      contact_name: c.name,
      contact_email: c.emails[0] ?? null,
      contact_phone: c.phones[0] ?? null,
      contact_user_id: member,
      is_on_platform: !!member,
      metadata: { import_source: source, consent_given: true, emails: c.emails, phones: c.phones, imported_at: now },
      updated_at: now,
    };
  });
  for (let i = 0; i < rows.length; i += BATCH) {
    await db('contacts?on_conflict=user_id,source,external_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + BATCH)),
    });
  }
  return { received: raw.length, imported: rows.length, on_platform: onPlatform };
}

export async function removeImportedContacts(userId: string, source: ContactSource): Promise<void> {
  await db(`contacts?user_id=eq.${enc(userId)}&source=eq.${enc(source)}`, { method: 'DELETE' });
}

/** Every contact in the member's Google account (People API, all pages). */
export async function fetchGoogleContacts(token: string): Promise<ImportContact[]> {
  const out: ImportContact[] = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const u = new URL('https://people.googleapis.com/v1/people/me/connections');
    u.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers');
    u.searchParams.set('pageSize', '1000');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const json: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`google_contacts ${r.status}: ${json?.error?.message ?? r.statusText}`);
    for (const p of json?.connections ?? []) {
      const n = (p.names ?? [])[0] ?? {};
      out.push({
        external_id: String(p.resourceName ?? ''),
        name: n.displayName ?? [n.givenName, n.familyName].filter(Boolean).join(' '),
        emails: (p.emailAddresses ?? []).map((e: any) => e.value).filter(Boolean),
        phones: (p.phoneNumbers ?? []).map((e: any) => e.value).filter(Boolean),
      });
    }
    pageToken = json?.nextPageToken ?? '';
    if (!pageToken || out.length >= MAX_CONTACTS_PER_IMPORT) break;
  }
  return out;
}
