/**
 * Conversation Flow — greeting-facts ledger (spoken-content continuity).
 *
 * THE gap behind "Vitana greets me with the same stats every session":
 * every opener recomputes level stats (unread messages, sessions completed,
 * Index) fresh from the DB, and NOTHING records that they were already
 * spoken. The cadence machinery (`wake_cadence:*`) tracks style and timing;
 * `recent_openers` tracks provider identity; this module tracks the FACTS
 * a greeting actually told the user, so the next opener can speak deltas
 * ("zwei neue seit heute Morgen") instead of restating levels ("du hast
 * 10 ungelesene Nachrichten") — and so consecutive greetings never reuse
 * the same wording (the previous first utterance is stored and handed to
 * the model as a negative example).
 *
 * Storage: two signals in `user_assistant_state` — the exact pattern of
 * `wake-cadence-signals.ts` and the next-action `dedupe-store.ts`:
 *
 *   `greeting_facts_v1`            { facts: { <key>: { value, spoken_at } } }
 *   `greeting_last_utterance_v1`   { text, spoken_at }
 *
 * Read paths fail OPEN (empty ledger on any error) — a DB outage must
 * never silence or degrade the greeting; it just loses continuity for
 * one session. Write paths are fire-and-forget and never throw.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OverviewPayload } from '../assistant-continuation/providers/new-day-overview-payload';

export const SIGNAL_GREETING_FACTS = 'greeting_facts_v1';
export const SIGNAL_GREETING_LAST_UTTERANCE = 'greeting_last_utterance_v1';

/** A fact's spoken value is considered "known to the user" this long. */
export const FACT_FRESHNESS_MS = 48 * 3600 * 1000;

/** Stored utterances are capped so the signal row stays small. */
export const UTTERANCE_MAX_CHARS = 400;

export interface SpokenFact {
  value: number;
  spoken_at: string;
}

export interface GreetingLedger {
  facts: Record<string, SpokenFact>;
  last_utterance: string | null;
  last_utterance_at: string | null;
  /** Sessions opened today (piggy-backed from `wake_cadence:sessions_today`
   *  in the same query — situation context for rule 4). Null when unknown. */
  sessions_today: number | null;
}

export const EMPTY_GREETING_LEDGER: GreetingLedger = {
  facts: {},
  last_utterance: null,
  last_utterance_at: null,
  sessions_today: null,
};

export type FactStatus = 'new' | 'changed' | 'unchanged';

export interface FactDelta {
  key: string;
  current: number;
  /** Last value spoken to the user (null when never spoken / stale). */
  previous: number | null;
  /** current - previous; null when previous is unknown. */
  delta: number | null;
  status: FactStatus;
  spoken_at: string | null;
}

export interface LedgerIdentity {
  supabase: SupabaseClient;
  tenantId: string;
  userId: string;
  nowIso?: string;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Fail-open read of the greeting ledger. Never throws; empty on error. */
export async function readGreetingLedger(inputs: LedgerIdentity): Promise<GreetingLedger> {
  if (!inputs.tenantId || !inputs.userId) return { ...EMPTY_GREETING_LEDGER };
  const nowIso = inputs.nowIso ?? new Date().toISOString();
  try {
    const { data, error } = await inputs.supabase
      .from('user_assistant_state')
      .select('signal_name, value')
      .eq('tenant_id', inputs.tenantId)
      .eq('user_id', inputs.userId)
      .in('signal_name', [
        SIGNAL_GREETING_FACTS,
        SIGNAL_GREETING_LAST_UTTERANCE,
        'wake_cadence:sessions_today',
      ]);
    if (error) return { ...EMPTY_GREETING_LEDGER };
    const out: GreetingLedger = { ...EMPTY_GREETING_LEDGER, facts: {} };
    for (const row of (data || []) as Array<{ signal_name: string; value: unknown }>) {
      if (row.signal_name === SIGNAL_GREETING_FACTS) {
        out.facts = parseFacts(row.value);
      } else if (row.signal_name === SIGNAL_GREETING_LAST_UTTERANCE) {
        const v = row.value as { text?: unknown; spoken_at?: unknown } | null;
        if (v && typeof v === 'object' && typeof v.text === 'string' && v.text.trim()) {
          out.last_utterance = v.text;
          out.last_utterance_at = typeof v.spoken_at === 'string' ? v.spoken_at : null;
        }
      } else if (row.signal_name === 'wake_cadence:sessions_today') {
        const v = row.value as { date?: unknown; count?: unknown } | null;
        if (
          v &&
          typeof v === 'object' &&
          v.date === nowIso.slice(0, 10) &&
          typeof v.count === 'number' &&
          Number.isFinite(v.count)
        ) {
          out.sessions_today = v.count;
        }
      }
    }
    return out;
  } catch {
    return { ...EMPTY_GREETING_LEDGER };
  }
}

export function parseFacts(value: unknown): Record<string, SpokenFact> {
  const out: Record<string, SpokenFact> = {};
  if (!value || typeof value !== 'object') return out;
  const facts = (value as { facts?: unknown }).facts;
  if (!facts || typeof facts !== 'object') return out;
  for (const [key, raw] of Object.entries(facts as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const v = (raw as { value?: unknown }).value;
    const at = (raw as { spoken_at?: unknown }).spoken_at;
    if (typeof v === 'number' && Number.isFinite(v) && typeof at === 'string') {
      out[key] = { value: v, spoken_at: at };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delta computation (pure)
// ---------------------------------------------------------------------------

/**
 * Compare the facts the opener is ABOUT to draw from against what was
 * already spoken. A fact previously spoken within FACT_FRESHNESS_MS:
 * same value → 'unchanged' (restating it is the robotic repeat — forbid),
 * different value → 'changed' (speak the delta). Never spoken / stale →
 * 'new' (the full number is allowed once).
 */
export function computeFactDeltas(
  current: Record<string, number>,
  ledger: GreetingLedger,
  opts?: { nowIso?: string; freshnessMs?: number },
): Record<string, FactDelta> {
  const nowMs = Date.parse(opts?.nowIso ?? new Date().toISOString());
  const freshnessMs = opts?.freshnessMs ?? FACT_FRESHNESS_MS;
  const out: Record<string, FactDelta> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!Number.isFinite(value)) continue;
    const prior = ledger.facts[key];
    const priorMs = prior ? Date.parse(prior.spoken_at) : NaN;
    const fresh =
      prior && Number.isFinite(priorMs) && Number.isFinite(nowMs) && nowMs - priorMs < freshnessMs;
    if (!fresh) {
      out[key] = { key, current: value, previous: null, delta: null, status: 'new', spoken_at: null };
    } else if (prior!.value === value) {
      out[key] = {
        key,
        current: value,
        previous: prior!.value,
        delta: 0,
        status: 'unchanged',
        spoken_at: prior!.spoken_at,
      };
    } else {
      out[key] = {
        key,
        current: value,
        previous: prior!.value,
        delta: value - prior!.value,
        status: 'changed',
        spoken_at: prior!.spoken_at,
      };
    }
  }
  return out;
}

/**
 * The numeric facts an opener can recite, extracted from the overview
 * payload. Only levels prone to robotic repetition are tracked — the
 * ledger is a repeat-guard, not a data store.
 */
export function extractSpokenFactsFromPayload(p: OverviewPayload | null): Record<string, number> {
  if (!p) return {};
  const out: Record<string, number> = {};
  if (typeof p.messages_unread === 'number') out.messages_unread = p.messages_unread;
  if (typeof p.matches_unread === 'number') out.matches_unread = p.matches_unread;
  if (p.reminders_today && typeof p.reminders_today.count === 'number') {
    out.reminders_today = p.reminders_today.count;
  }
  if (p.guided_journey && typeof p.guided_journey.sessions_completed === 'number') {
    out.sessions_completed = p.guided_journey.sessions_completed;
  }
  if (p.vitana_index.state === 'ok' && typeof p.vitana_index.today === 'number') {
    out.vitana_index = p.vitana_index.today;
  }
  if (typeof p.diary_last_7d === 'number') out.diary_last_7d = p.diary_last_7d;
  return out;
}

// ---------------------------------------------------------------------------
// Write (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Merge the facts just handed to the opener into the ledger. Read-modify-
 * write (same trade-off as recordWakeSessionStart — a lost race only costs
 * one session of continuity). Never throws.
 */
export async function recordGreetingFacts(
  inputs: LedgerIdentity & { facts: Record<string, number> },
): Promise<{ ok: boolean; reason?: string }> {
  if (!inputs.tenantId || !inputs.userId) return { ok: false, reason: 'missing_identity' };
  const keys = Object.keys(inputs.facts);
  if (keys.length === 0) return { ok: false, reason: 'no_facts' };
  const nowIso = inputs.nowIso ?? new Date().toISOString();
  try {
    const { data: existing } = await inputs.supabase
      .from('user_assistant_state')
      .select('value')
      .eq('tenant_id', inputs.tenantId)
      .eq('user_id', inputs.userId)
      .eq('signal_name', SIGNAL_GREETING_FACTS)
      .maybeSingle();
    const merged = existing ? parseFacts((existing as { value: unknown }).value) : {};
    for (const key of keys) {
      const value = inputs.facts[key];
      if (Number.isFinite(value)) merged[key] = { value, spoken_at: nowIso };
    }
    const { error } = await inputs.supabase.from('user_assistant_state').upsert(
      {
        tenant_id: inputs.tenantId,
        user_id: inputs.userId,
        signal_name: SIGNAL_GREETING_FACTS,
        value: { facts: merged },
        last_seen_at: nowIso,
      },
      { onConflict: 'tenant_id,user_id,signal_name' },
    );
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Store Vitana's actual first spoken turn of a session (truncated), so the
 * NEXT session can show it to the model as a negative example ("do not
 * reuse this wording"). Never throws.
 */
export async function recordGreetingUtterance(
  inputs: LedgerIdentity & { utterance: string },
): Promise<{ ok: boolean; reason?: string }> {
  if (!inputs.tenantId || !inputs.userId) return { ok: false, reason: 'missing_identity' };
  const text = (inputs.utterance || '').trim().slice(0, UTTERANCE_MAX_CHARS);
  if (!text) return { ok: false, reason: 'empty_utterance' };
  const nowIso = inputs.nowIso ?? new Date().toISOString();
  try {
    const { error } = await inputs.supabase.from('user_assistant_state').upsert(
      {
        tenant_id: inputs.tenantId,
        user_id: inputs.userId,
        signal_name: SIGNAL_GREETING_LAST_UTTERANCE,
        value: { text, spoken_at: nowIso },
        last_seen_at: nowIso,
      },
      { onConflict: 'tenant_id,user_id,signal_name' },
    );
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Prompt helpers (pure) — shared by the daily briefing and the resume
// register so both compose against the same continuity rules.
// ---------------------------------------------------------------------------

/**
 * Per-fact composition guidance for the model. Data stays available (the
 * payload still carries the numbers); this section tells the model which
 * numbers the user has ALREADY heard, so it weaves instead of recites.
 */
export function buildFactContinuityLines(deltas: Record<string, FactDelta>): string[] {
  const lines: string[] = [];
  for (const d of Object.values(deltas)) {
    if (d.status === 'unchanged') {
      lines.push(
        `- ${d.key} = ${d.current}: ALREADY TOLD to the user (unchanged since last mentioned). ` +
          `Do NOT restate this number. At most a soft, number-free reference if it serves the conversation.`,
      );
    } else if (d.status === 'changed' && d.delta !== null) {
      const dir = d.delta > 0 ? `+${d.delta}` : `${d.delta}`;
      lines.push(
        `- ${d.key} = ${d.current} (was ${d.previous} when last mentioned, ${dir} since): ` +
          `speak the CHANGE, not the running total — the change is the news.`,
      );
    }
    // status === 'new' → no line: the number is fresh and may be spoken once.
  }
  return lines;
}

/**
 * The wording-variety negative example. Concrete previous utterances beat
 * abstract "vary your wording" instructions — the model reliably avoids a
 * shown example.
 */
export function buildPreviousGreetingSection(lastUtterance: string | null): string {
  if (!lastUtterance || !lastUtterance.trim()) return '';
  return (
    `\n## YOUR PREVIOUS GREETING TO THIS USER (NEGATIVE EXAMPLE — NEVER IMITATE)\n\n` +
    `"${lastUtterance.trim()}"\n\n` +
    `Compose a DIFFERENT opening: different first words, different sentence ` +
    `structure, a different opening move. Repeating the wording, rhythm, or ` +
    `structure of the previous greeting is a contract failure.\n`
  );
}
