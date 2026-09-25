/**
 * VTID-04581: `remember_fact` — the assistant saves a fact while the member is
 * talking, and learns in the same turn what is already stored.
 *
 * Before this tool, facts were only written by a background extractor after
 * the turn. The model had no way to see, while answering, that
 *   - the fact is a profile field (birthday, name, …) that only the profile
 *     can change — so it cheerfully "saved" a birthday that was then refused;
 *   - a different value is already stored — so "my wife's birthday is B"
 *     silently replaced A without asking which one is right.
 *
 * The tool answers with one status the model acts on:
 *   profile_owned  nothing saved; the profile's current value, if any
 *   already_known  nothing saved; the same value is stored
 *   conflict       nothing saved; a different value is stored — ask which is right
 *   saved          written (after confirm_replace when it replaced a value)
 *
 * The text returned to the model is an instruction (intent), never a
 * sentence for Vitana to speak (CLAUDE.md NEVER rule 41).
 */

import { isIdentityLockedKey, getRedirectTarget, type IdentityLockedKey } from '../memory-identity-lock';
import { rememberFact } from './remember';

export type RememberFactStatus = 'profile_owned' | 'already_known' | 'conflict' | 'saved' | 'failed';

export interface RememberFactToolResult {
  status: RememberFactStatus;
  fact_key: string;
  new_value: string;
  stored_value?: string | null;
  stored_at?: string | null;
  profile_value?: string | null;
  profile_field?: string;
  replaced_value?: string | null;
  error?: string;
  instruction: string;
}

export interface StoredFact {
  fact_value: string;
  extracted_at: string | null;
}

export interface StoredKeyedFact extends StoredFact {
  fact_key: string;
}

export interface RememberFactDeps {
  readCurrentFact(tenantId: string, userId: string, factKey: string): Promise<StoredFact | null>;
  readProfileValue(userId: string, factKey: IdentityLockedKey): Promise<string | null>;
  write: typeof rememberFact;
  /**
   * The member's current facts, to find one stored under a different key for
   * the same thing (the background extractor wrote "paul_birthday", the model
   * says "bruder_paul_geburtstag"). Optional; without it only the exact key is checked.
   */
  listCurrentFacts?(tenantId: string, userId: string): Promise<StoredKeyedFact[]>;
  /** Conflicts this tool reported and the member has not resolved yet. Defaults to a process-wide store. */
  pendingConflicts?: PendingConflictStore;
  now?: () => number;
}

/**
 * A replace is honoured only after this tool reported the conflict to the
 * member, so the model cannot skip the "which one is right?" question by
 * sending confirm_replace on its own.
 */
export interface PendingConflictStore {
  mark(userId: string, factKey: string, at: number): void;
  isPending(userId: string, factKey: string, now: number): boolean;
  clear(userId: string, factKey: string): void;
}

export const CONFLICT_CONFIRM_WINDOW_MS = 30 * 60 * 1000;

export function createPendingConflictStore(windowMs = CONFLICT_CONFIRM_WINDOW_MS): PendingConflictStore {
  const pending = new Map<string, number>();
  const k = (u: string, f: string) => `${u}:${f}`;
  return {
    mark(userId, factKey, at) {
      pending.set(k(userId, factKey), at);
      if (pending.size > 5000) pending.delete(pending.keys().next().value as string);
    },
    isPending(userId, factKey, now) {
      const at = pending.get(k(userId, factKey));
      return at !== undefined && now - at <= windowMs;
    },
    clear(userId, factKey) {
      pending.delete(k(userId, factKey));
    },
  };
}

const defaultPendingConflicts = createPendingConflictStore();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** write_fact's p_thread_id is a uuid; a voice session id ("live-…") is not. */
export function uuidOrNull(value: string | null | undefined): string | null {
  return value && UUID_RE.test(value) ? value : null;
}

/**
 * A year the member never said: models fill a missing year with 1900 or 0001.
 * "1900-05-05" becomes "--05-05" (day and month only).
 */
export function dropPlaceholderYear(value: string): string {
  const m = value.trim().match(/^(1900|0001|0000)-(\d{2})-(\d{2})$/);
  return m ? `--${m[2]}-${m[3]}` : value.trim();
}

// Words a model may use for a profile field, mapped to the locked key.
const PROFILE_ALIASES: Record<string, IdentityLockedKey> = {
  birthday: 'user_birthday',
  my_birthday: 'user_birthday',
  birth_date: 'user_birthday',
  birthdate: 'user_birthday',
  date_of_birth: 'user_date_of_birth',
  dob: 'user_date_of_birth',
  user_dob: 'user_date_of_birth',
  user_birth_date: 'user_date_of_birth',
  name: 'user_first_name',
  my_name: 'user_first_name',
  first_name: 'user_first_name',
  user_name: 'user_first_name',
  last_name: 'user_last_name',
  surname: 'user_last_name',
  full_name: 'user_full_name',
  display_name: 'user_display_name',
  gender: 'user_gender',
  pronouns: 'user_pronouns',
  email: 'user_email',
  email_address: 'user_email',
  phone: 'user_phone',
  phone_number: 'user_phone',
  city: 'user_city',
  country: 'user_country',
  address: 'user_address',
  home_address: 'user_address',
};

/** Profile column read for each locked key; null = no profile column. */
const PROFILE_COLUMN: Partial<Record<IdentityLockedKey, string>> = {
  user_birthday: 'date_of_birth',
  user_date_of_birth: 'date_of_birth',
  user_first_name: 'first_name',
  user_last_name: 'last_name',
  user_display_name: 'display_name',
  user_full_name: 'full_name',
  user_gender: 'gender',
  user_city: 'city',
  user_country: 'country',
};

export function profileColumnFor(key: IdentityLockedKey): string | null {
  return PROFILE_COLUMN[key] ?? null;
}

export function normalizeFactKey(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The member's own profile field this key names, or null. */
export function resolveProfileKey(factKey: string, about: string | undefined): IdentityLockedKey | null {
  if (about && about !== 'self') return null;
  if (isIdentityLockedKey(factKey)) return factKey;
  return PROFILE_ALIASES[factKey] ?? null;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, januar: 1, jaenner: 1, jänner: 1,
  feb: 2, february: 2, februar: 2,
  mar: 3, march: 3, marz: 3, märz: 3, maerz: 3,
  apr: 4, april: 4,
  may: 5, mai: 5,
  jun: 6, june: 6, juni: 6,
  jul: 7, july: 7, juli: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, okt: 10, oktober: 10,
  nov: 11, november: 11,
  dec: 12, december: 12, dez: 12, dezember: 12,
};

/** "4. November 1997", "November 4th, 1997", "1997-11-04", "04.11.1997" → "1997-11-04". */
export function normalizeDate(value: string): string | null {
  const v = value.trim().toLowerCase();
  let m = v.match(/^--(\d{1,2})-(\d{1,2})$/);
  if (m) return `--${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = v.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const tokens = v.replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  let day: number | null = null;
  let month: number | null = null;
  let year: number | null = null;
  for (const t of tokens) {
    const n = t.replace(/(st|nd|rd|th)$/, '');
    if (MONTHS[t] !== undefined) month = MONTHS[t];
    else if (/^\d{4}$/.test(n)) year = Number(n);
    else if (/^\d{1,2}$/.test(n) && day === null) day = Number(n);
  }
  if (day === null || month === null) return null;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return year ? `${year}-${mm}-${dd}` : `--${mm}-${dd}`;
}

export function valuesMatch(a: string, b: string): boolean {
  const da = normalizeDate(a);
  const db = normalizeDate(b);
  if (da && db) {
    // A day-and-month value matches a full date with the same day and month.
    if (da.startsWith('--') || db.startsWith('--')) return da.slice(-5) === db.slice(-5);
    return da === db;
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return norm(a) === norm(b);
}

// Words that do not identify the fact.
const KEY_STOPWORDS = new Set([
  'my', 'the', 'of', 'a', 'an', 'user', 'users', 'is', 'date', 'value',
  'mein', 'meine', 'meiner', 'meines', 'von', 'der', 'die', 'das', 'am', 'des', 'dem', 'den', 'ist',
  'mi', 'moj', 'moja', 'de', 'la', 'el',
]);

// One word for each concept, across the languages the member speaks.
const KEY_SYNONYMS: Record<string, string> = {
  geburtstag: 'birthday', geburtsdatum: 'birthday', bday: 'birthday', birth: 'birthday', dob: 'birthday',
  cumpleanos: 'birthday', rodjendan: 'birthday',
  bruder: 'brother', schwester: 'sister', sibling: 'sibling', geschwister: 'sibling',
  wife: 'spouse', husband: 'spouse', partner: 'spouse', frau: 'spouse', ehefrau: 'spouse',
  mann: 'spouse', ehemann: 'spouse', partnerin: 'spouse', fiancee: 'spouse', verlobte: 'spouse',
  mutter: 'mother', mama: 'mother', mom: 'mother', vater: 'father', papa: 'father', dad: 'father',
  sohn: 'son', tochter: 'daughter', kind: 'child', kids: 'child', children: 'child',
  hund: 'dog', katze: 'cat', haustier: 'pet',
  lieblingsessen: 'favorite_food', lieblings: 'favorite', favourite: 'favorite',
  arbeit: 'job', beruf: 'job', work: 'job', occupation: 'job',
  wohnort: 'city', stadt: 'city',
};

export function keyTokens(factKey: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalizeFactKey(factKey).split('_')) {
    if (!raw || KEY_STOPWORDS.has(raw)) continue;
    out.add(KEY_SYNONYMS[raw] ?? raw);
  }
  return out;
}

/**
 * The stored fact that names the same thing under another key: one key's
 * words contain the other's, and they share at least two words (so
 * "birthday" alone never matches "paul_birthday").
 */
export function findRelatedFact(factKey: string, facts: StoredKeyedFact[]): StoredKeyedFact | null {
  const want = keyTokens(factKey);
  if (want.size < 2) return null;
  let best: { fact: StoredKeyedFact; shared: number } | null = null;
  for (const f of facts) {
    const have = keyTokens(f.fact_key);
    let shared = 0;
    for (const t of have) if (want.has(t)) shared++;
    const nested = shared === have.size || shared === want.size;
    if (shared < 2 || !nested) continue;
    const newer = best && shared === best.shared && String(f.extracted_at ?? '') > String(best.fact.extracted_at ?? '');
    if (!best || shared > best.shared || newer) best = { fact: f, shared };
  }
  return best?.fact ?? null;
}

export interface RememberFactToolInput {
  tenant_id: string;
  user_id: string;
  fact_key: string;
  fact_value: string;
  about?: string;
  confirm_replace?: boolean;
  thread_id?: string | null;
}

export async function runRememberFact(
  input: RememberFactToolInput,
  deps: RememberFactDeps,
): Promise<RememberFactToolResult> {
  let factKey = normalizeFactKey(input.fact_key);
  const newValue = dropPlaceholderYear(String(input.fact_value ?? ''));
  const base = { fact_key: factKey, new_value: newValue };
  if (!factKey || !newValue) {
    return {
      ...base,
      status: 'failed',
      error: 'fact_key and fact_value are required',
      instruction: 'Nothing was saved. Ask the member what exactly they want you to remember.',
    };
  }

  const profileKey = resolveProfileKey(factKey, input.about);
  if (profileKey) {
    const profileValue = await deps.readProfileValue(input.user_id, profileKey).catch(() => null);
    const target = getRedirectTarget(profileKey);
    const field = target.payload.field ?? profileKey;
    const sameAsProfile = profileValue ? valuesMatch(profileValue, newValue) : false;
    const instruction = profileValue
      ? sameAsProfile
        ? `Nothing was saved: this is a profile field and the profile already has exactly this value (${profileValue}). Tell the member you already know it. If they ever want to change it, that is done in their profile.`
        : `Nothing was saved: this is a profile field. The profile says ${profileValue}; the member just said ${newValue}. Tell them you already know it from their profile (say the profile value), that it differs from what they just said, and that profile basics like this are changed in their profile — offer to open it for them.`
      : `Nothing was saved: this is a profile field and their profile has no value yet. Tell the member that basics like this are entered in their profile, where every part of Vitanaland uses them, and offer to open it now.`;
    return {
      ...base,
      status: 'profile_owned',
      fact_key: profileKey,
      profile_field: field,
      profile_value: profileValue,
      instruction,
    };
  }

  const pendingConflicts = deps.pendingConflicts ?? defaultPendingConflicts;
  const now = (deps.now ?? Date.now)();
  let stored = await deps.readCurrentFact(input.tenant_id, input.user_id, factKey).catch(() => null);
  if (!stored && deps.listCurrentFacts) {
    const facts = await deps.listCurrentFacts(input.tenant_id, input.user_id).catch(() => [] as StoredKeyedFact[]);
    const related = findRelatedFact(factKey, facts);
    if (related) {
      // Keep one fact per thing: compare against, and replace, the stored key.
      factKey = related.fact_key;
      stored = { fact_value: related.fact_value, extracted_at: related.extracted_at };
    }
  }
  base.fact_key = factKey;
  if (stored && valuesMatch(stored.fact_value, newValue)) {
    return {
      ...base,
      status: 'already_known',
      stored_value: stored.fact_value,
      stored_at: stored.extracted_at,
      instruction: `Nothing new to save: you already have ${factKey} = "${stored.fact_value}". Tell the member you already knew that.`,
    };
  }
  const replaceConfirmed =
    input.confirm_replace === true && pendingConflicts.isPending(input.user_id, factKey, now);
  if (stored && !replaceConfirmed) {
    pendingConflicts.mark(input.user_id, factKey, now);
    return {
      ...base,
      status: 'conflict',
      stored_value: stored.fact_value,
      stored_at: stored.extracted_at,
      instruction:
        `Nothing was saved. You already have a DIFFERENT value for ${factKey}: "${stored.fact_value}". ` +
        `The member just said "${newValue}". Tell them you have the other value stored, name both, and ask which one is correct. ` +
        `When they answer, call remember_fact again with the correct value and confirm_replace=true. Do not say it is saved before that call returns status=saved.`,
    };
  }

  const written = await deps.write({
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    fact_key: factKey,
    fact_value: newValue,
    entity: input.about && input.about !== 'self' ? 'disclosed' : 'self',
    provenance_source: 'user_stated',
    provenance_confidence: 0.95,
    thread_id: uuidOrNull(input.thread_id),
    actor: 'orb-remember-fact-tool',
  });
  if (written.ok) pendingConflicts.clear(input.user_id, factKey);
  if (!written.ok) {
    if (written.blocked === 'identity_lock') {
      return {
        ...base,
        status: 'profile_owned',
        profile_value: null,
        instruction: 'Nothing was saved: this is a profile field. Tell the member it is set in their profile and offer to open it.',
      };
    }
    return {
      ...base,
      status: 'failed',
      error: written.error,
      instruction: 'Saving failed. Tell the member honestly that you could not save it right now; do not say it was saved.',
    };
  }
  return {
    ...base,
    status: 'saved',
    replaced_value: stored?.fact_value ?? null,
    instruction: stored
      ? `Saved: ${factKey} = "${newValue}" (replaced "${stored.fact_value}"). Confirm briefly to the member.`
      : `Saved: ${factKey} = "${newValue}". Confirm briefly to the member.`,
  };
}

/** One line per status, for the model. */
export function formatRememberFactResult(r: RememberFactToolResult): string {
  return `STATUS: ${r.status}. ${r.instruction}`;
}
