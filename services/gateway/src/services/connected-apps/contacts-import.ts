/**
 * VTID-04405: import a member's contacts from Google, iCloud, Outlook
 * (VTID-04449) or their Android phone into Vitanaland's `contacts` table.
 *
 * - De-duplicated per source (user_id, source, external_id): a second sync
 *   updates names/emails/phones instead of adding copies.
 * - Contacts who are already Vitanaland members (matched by e-mail) get
 *   contact_user_id + is_on_platform, excluding test/service accounts
 *   (CLAUDE.md rule 45 — the same allowlists as every member-facing list).
 * - Imported contacts stay the member's even if they later turn the app off;
 *   removing them is an explicit choice (removeImportedContacts).
 * - VTID-04439: `contacts` also has two older unique indexes, one phone and
 *   one member per user (unique_user_phone, unique_user_contact). A contact
 *   whose phone or member is already held by another row — a hand-added
 *   contact, another source, or an earlier contact in the same import — is
 *   the same person, so it is skipped rather than failing the whole batch.
 */

import { db, enc } from './db';

export type ContactSource = 'google' | 'icloud' | 'microsoft' | 'android';

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
  /** Already in the member's contacts under another row (same phone or member). */
  already_present: number;
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
  const rows = clean.map((c) => {
    const member = c.emails.map((e) => matches.get(e)).find((id) => id && id !== userId) ?? null;
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
  const { keep, skipped } = resolveCollisions(rows, await existingContactKeys(userId));
  for (let i = 0; i < keep.length; i += BATCH) {
    await db('contacts?on_conflict=user_id,source,external_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(keep.slice(i, i + BATCH)),
    });
  }
  return {
    received: raw.length,
    imported: keep.length,
    on_platform: keep.filter((r) => r.is_on_platform).length,
    already_present: skipped,
  };
}

export interface ExistingContactKey {
  source: string | null;
  external_id: string | null;
  contact_phone: string | null;
  contact_user_id: string | null;
}

const rowKey = (r: { source: string | null; external_id: string | null }, i: number) =>
  r.source && r.external_id ? `${r.source}\u0000${r.external_id}` : `row\u0000${i}`;

/**
 * Drop rows whose phone or member is already held by a different row, so
 * the upsert cannot trip unique_user_phone / unique_user_contact. A row that
 * updates itself (same source + external id) keeps what it already holds.
 * Pure; exported for tests.
 */
export function resolveCollisions<R extends { source: string; external_id: string; contact_phone: string | null; contact_user_id: string | null }>(
  rows: R[],
  existing: ExistingContactKey[],
): { keep: R[]; skipped: number } {
  const phoneOwner = new Map<string, string>();
  const memberOwner = new Map<string, string>();
  existing.forEach((e, i) => {
    const k = rowKey(e, i);
    if (e.contact_phone) phoneOwner.set(e.contact_phone, k);
    if (e.contact_user_id) memberOwner.set(e.contact_user_id, k);
  });
  // Conservative on purpose: an existing row keeps its phone and member even
  // if this import changes them, so no statement order can trip an index.
  const keep: R[] = [];
  let skipped = 0;
  for (const r of rows) {
    const k = rowKey(r, -1);
    const clash = (held: string | undefined) => held !== undefined && held !== k;
    if (clash(r.contact_phone ? phoneOwner.get(r.contact_phone) : undefined) ||
        clash(r.contact_user_id ? memberOwner.get(r.contact_user_id) : undefined)) {
      skipped += 1;
      continue;
    }
    keep.push(r);
    if (r.contact_phone) phoneOwner.set(r.contact_phone, k);
    if (r.contact_user_id) memberOwner.set(r.contact_user_id, k);
  }
  return { keep, skipped };
}

/** The member's contacts that hold a phone or a member, paged past PostgREST's row cap. */
async function existingContactKeys(userId: string): Promise<ExistingContactKey[]> {
  const out: ExistingContactKey[] = [];
  const PAGE = 1000;
  for (let offset = 0; offset < 20_000; offset += PAGE) {
    const rows = ((await db(
      `contacts?select=source,external_id,contact_phone,contact_user_id&user_id=eq.${enc(userId)}` +
        `&or=(contact_phone.not.is.null,contact_user_id.not.is.null)&order=id.asc&limit=${PAGE}&offset=${offset}`,
    )) ?? []) as ExistingContactKey[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
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

/**
 * VTID-04449: every contact in the member's Outlook / Microsoft 365
 * address book (Graph /me/contacts, all pages). Only names, e-mail
 * addresses and phone numbers are read.
 */
export async function fetchOutlookContacts(token: string): Promise<ImportContact[]> {
  const out: ImportContact[] = [];
  let url: string | null =
    'https://graph.microsoft.com/v1.0/me/contacts' +
    '?$select=id,displayName,givenName,surname,emailAddresses,mobilePhone,homePhones,businessPhones&$top=500';
  for (let page = 0; url && page < 20; page++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const json: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 403) throw new Error('permission_not_granted');
      throw new Error(`outlook_contacts ${r.status}: ${json?.error?.message ?? r.statusText}`);
    }
    for (const c of json?.value ?? []) {
      out.push({
        external_id: String(c.id ?? ''),
        name: c.displayName || [c.givenName, c.surname].filter(Boolean).join(' '),
        emails: (c.emailAddresses ?? []).map((e: any) => e?.address).filter(Boolean),
        phones: [c.mobilePhone, ...(c.homePhones ?? []), ...(c.businessPhones ?? [])].filter(Boolean),
      });
    }
    url = json?.['@odata.nextLink'] ?? null;
    if (out.length >= MAX_CONTACTS_PER_IMPORT) break;
  }
  return out;
}
