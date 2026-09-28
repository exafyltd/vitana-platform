/**
 * VTID-04684: forgetting a stored fact by voice.
 *
 * Until now the voice model had no way to forget a FACT: `forget_memory`
 * deletes one memory_items row by id, and the Memory Garden delete is a
 * screen. Live suite B-FORG-01 (2026-09-26): "vergiss bitte, dass mein Hund
 * Bello heißt" → Nova said it had deleted the name, called no tool, and
 * user_pet_name=Bello stayed current.
 *
 * `runForgetFact` does what the Garden delete does, from what the member said:
 *   1. find the fact they mean — its value named in the request ("Bello"),
 *      else its key words ("mein Lieblingsessen" → user_favorite_food);
 *   2. forget every row of that key and record the do-not-re-learn marker
 *      (deleteGardenEntry, VTID-04441);
 *   3. delete the member's own transcript lines that carry the value, so the
 *      next session's recall cannot read it back;
 *   4. rebuild the voice snapshot (VTID-04627).
 * Both the `forget_fact` tool and the gateway backstop (the model skipped
 * the tool) run it.
 */

import { keyTokens, type StoredKeyedFact } from './remember-fact-tool';

export type ForgetFactStatus = 'forgotten' | 'not_found' | 'ambiguous' | 'failed';

export interface ForgetFactResult {
  status: ForgetFactStatus;
  forgotten: Array<{ fact_key: string; fact_value: string }>;
  candidates?: Array<{ fact_key: string; fact_value: string }>;
  transcript_lines_removed?: number;
  error?: string;
  instruction: string;
}

export interface ForgettableFact extends StoredKeyedFact {
  id: string;
}

export interface ForgetFactDeps {
  listCurrentFacts(tenantId: string, userId: string): Promise<ForgettableFact[]>;
  /** Forget every row of the key the fact id belongs to, recording the marker. */
  forgetFact(tenantId: string, userId: string, factId: string): Promise<{ ok: boolean; error?: string }>;
  /** Delete the member's own memory_items whose content carries the value; returns how many. */
  deleteItemsMentioning(tenantId: string, userId: string, value: string): Promise<number>;
  refreshSnapshot(tenantId: string, userId: string): void;
}

// Keys the gateway writes for itself and the profile basics — never forgotten by voice.
const PROTECTED_KEY = /^(preferred_language|stt_language|user_timezone|timezone|locale|user_name|user_first_name|user_last_name|user_birthday|user_birthdate|user_date_of_birth)$/i;

// Request words that carry no fact ("vergiss bitte dass …").
const REQUEST_WORDS = new Set([
  'vergiss', 'vergessen', 'bitte', 'dass', 'das', 'es', 'loesch', 'losch', 'lösch', 'lösche', 'loesche', 'löschen',
  'aus', 'deinem', 'dem', 'gedächtnis', 'gedaechtnis', 'was', 'du', 'über', 'ueber', 'weißt', 'weisst', 'ich', 'habe',
  'hat', 'heißt', 'heisst', 'ist', 'sind', 'forget', 'please', 'that', 'about', 'what', 'you', 'know', 'delete',
  'olvida', 'que', 'zaboravi', 'da', 'moj', 'moja', 'und', 'and', 'wieder', 'auch', 'mal',
]);

const norm = (s: string) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Words of the request, as fact-key tokens ("hund" → dog, "lieblingsessen" → favorite + food). */
function requestTokens(request: string): Set<string> {
  const words = norm(request).split(' ').filter((w) => w && !REQUEST_WORDS.has(w));
  return keyTokens(words.join('_'));
}

/**
 * The facts the request means. A value named in the request wins (it is
 * explicit); otherwise the facts whose every key word the request names.
 */
export function matchFactsToForget(request: string, facts: ForgettableFact[]): {
  matches: ForgettableFact[];
  ambiguous: boolean;
} {
  const text = ` ${norm(request)} `;
  const usable = facts.filter((f) => !PROTECTED_KEY.test(f.fact_key));
  const byValue = usable.filter((f) => {
    const v = norm(f.fact_value);
    return v.length >= 3 && text.includes(` ${v} `);
  });
  if (byValue.length) return { matches: byValue, ambiguous: false };

  const want = requestTokens(request);
  if (want.size === 0) return { matches: [], ambiguous: false };
  const scored = usable
    .map((f) => {
      const have = keyTokens(f.fact_key);
      let shared = 0;
      for (const t of have) if (want.has(t)) shared++;
      return { f, shared, full: have.size > 0 && shared === have.size };
    })
    .filter((x) => x.full);
  if (scored.length === 0) return { matches: [], ambiguous: false };
  const best = Math.max(...scored.map((x) => x.shared));
  const top = scored.filter((x) => x.shared === best);
  const keys = new Set(top.map((x) => x.f.fact_key));
  return { matches: top.map((x) => x.f), ambiguous: keys.size > 1 };
}

export async function runForgetFact(
  input: { tenant_id: string; user_id: string; request: string },
  deps: ForgetFactDeps,
): Promise<ForgetFactResult> {
  const request = String(input.request ?? '').trim();
  if (!request) {
    return { status: 'failed', forgotten: [], error: 'empty request', instruction: 'Nothing was forgotten. Ask the member what you should forget.' };
  }
  let facts: ForgettableFact[];
  try {
    facts = await deps.listCurrentFacts(input.tenant_id, input.user_id);
  } catch (err: any) {
    return {
      status: 'failed', forgotten: [], error: err?.message ?? String(err),
      instruction: 'Forgetting failed. Tell the member honestly that you could not do it right now; do not say it is forgotten.',
    };
  }
  const { matches, ambiguous } = matchFactsToForget(request, facts);
  if (matches.length === 0) {
    return {
      status: 'not_found', forgotten: [],
      instruction: 'Nothing matching is stored, so there is nothing to forget. Tell the member that plainly; do not claim you deleted anything.',
    };
  }
  if (ambiguous) {
    const candidates = matches.map((f) => ({ fact_key: f.fact_key, fact_value: f.fact_value }));
    return {
      status: 'ambiguous', forgotten: [], candidates,
      instruction: `Nothing was forgotten yet: more than one stored fact fits (${candidates.map((c) => `${c.fact_key} = "${c.fact_value}"`).join('; ')}). Name them and ask which one the member means.`,
    };
  }

  const forgotten: Array<{ fact_key: string; fact_value: string }> = [];
  const seenKeys = new Set<string>();
  let removed = 0;
  for (const f of matches) {
    if (seenKeys.has(f.fact_key)) continue;
    seenKeys.add(f.fact_key);
    const r = await deps.forgetFact(input.tenant_id, input.user_id, f.id).catch((err: any) => ({ ok: false, error: err?.message ?? String(err) }));
    if (!r.ok) {
      return {
        status: 'failed', forgotten, error: r.error,
        instruction: 'Forgetting failed. Tell the member honestly that you could not do it right now; do not say it is forgotten.',
      };
    }
    forgotten.push({ fact_key: f.fact_key, fact_value: f.fact_value });
    removed += await deps.deleteItemsMentioning(input.tenant_id, input.user_id, f.fact_value).catch(() => 0);
  }
  try {
    deps.refreshSnapshot(input.tenant_id, input.user_id);
  } catch {
    /* best-effort */
  }
  return {
    status: 'forgotten',
    forgotten,
    transcript_lines_removed: removed,
    instruction: `Forgotten: ${forgotten.map((f) => `${f.fact_key} ("${f.fact_value}")`).join(', ')} — removed everywhere and it will not be learned again from conversation. Confirm briefly to the member.`,
  };
}

export function formatForgetFactResult(r: ForgetFactResult): string {
  return `STATUS: ${r.status}. ${r.instruction}`;
}
