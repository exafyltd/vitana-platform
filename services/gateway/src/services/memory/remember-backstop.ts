/**
 * VTID-04591: the gateway keeps "remember this" requests working when the
 * voice model does not call remember_fact.
 *
 * Measured on staging, 2026-09-25: over five German sessions with the same
 * "merk dir …" utterances, Nova called remember_fact once. The other times it
 * answered from its own guesses — "ich kann Informationen über andere
 * Personen nicht speichern", or "ich habe dein Geburtsdatum notiert" for a
 * profile field that was never saved. Prompt wording cannot make that
 * reliable, so this path does not depend on it:
 *
 *   1. a turn whose member utterance is a remember request, with no
 *      remember_fact call in it, is detected at turn_complete;
 *   2. the facts are extracted from that utterance;
 *   3. each one runs through runRememberFact — the same profile / already
 *      known / conflict / saved rules the tool applies;
 *   4. the model gets the STATUS lines as a system note and says the real
 *      outcome, correcting whatever it said before.
 *
 * The note is intent for the model, never a sentence for Vitana to speak
 * (CLAUDE.md NEVER rule 41).
 */

import {
  runRememberFact,
  formatRememberFactResult,
  type RememberFactDeps,
  type RememberFactToolResult,
} from './remember-fact-tool';

/** Marks the injected note so the input-transcript path never records it as member speech. */
export const REMEMBER_BACKSTOP_MARKER = '[memory-check]';

// A request to remember, in the languages the member speaks. Anchored on the
// verbs of asking, not on facts, so an ordinary statement never triggers it.
const REMEMBER_INTENT = new RegExp(
  [
    '\\bmerk(e|t)?\\s*(dir|euch|ihnen)\\b',
    '\\bmerken\\b',
    '\\bvergiss\\s+(das\\s+|es\\s+)?nicht\\b',
    '\\bspeicher(e|n)?\\b',
    '\\bnotier(e|en)?\\b',
    '\\bbehalte?\\b.{0,20}\\b(im kopf|im gedächtnis)\\b',
    '\\bremember\\b',
    "\\bdon'?t\\s+forget\\b",
    '\\bmake\\s+a\\s+note\\b',
    '\\bnote\\s+(that|down)\\b',
    '\\bsave\\s+(that|this|it)\\b',
    '\\brecuerda(lo)?\\b',
    '\\bno\\s+olvides\\b',
    '\\bzapamti\\b',
    '\\bne\\s+zaboravi\\b',
  ].join('|'),
  'i',
);

export function detectRememberIntent(text: string): boolean {
  if (!text || text.startsWith(REMEMBER_BACKSTOP_MARKER)) return false;
  return REMEMBER_INTENT.test(text);
}

// VTID-04697: the reply says it saved or will remember something. Live
// B-CONF-02: "Mein Bruder Paul hat übrigens am siebten Mai Geburtstag" — no
// "merk dir", so the request detector stayed quiet — and Nova answered "Ich
// merke mir den Geburtstag … am siebten Mai" without calling remember_fact.
const REMEMBER_CLAIM = new RegExp(
  [
    '\\b(ich )?merke? (ich )?(mir|es mir|das mir)\\b',
    '\\b(hab|habe) (ich )?(mir )?(das |es |ihn |sie )?(gemerkt|notiert|gespeichert|vermerkt)\\b',
    '\\bich (notiere|speichere|vermerke)\\b',
    '\\b(ist|wurde) (jetzt )?(notiert|gespeichert|vermerkt)\\b',
    "\\bi('ll| will) remember\\b",
    "\\bi('ve| have) (noted|saved|stored|made a note)\\b",
    '\\b(got it|noted)[,.!]',
    '\\b(lo )?(recordaré|he guardado|he anotado)\\b',
    '\\b(zapamtila|zapamtiću|zabeležila)\\b',
  ].join('|'),
  'i',
);
const CLAIM_NEGATION = /\b(nicht|kein|keine|keinen|nie|not|can't|cannot|won't|don't|no puedo|ne mogu|ne)\b/i;

/** True when a sentence of the reply claims a save; negated sentences do not count. */
export function detectRememberClaim(reply: string): boolean {
  if (!reply) return false;
  return reply
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => REMEMBER_CLAIM.test(sentence) && !CLAIM_NEGATION.test(sentence));
}

export interface BackstopFact {
  fact_key: string;
  fact_value: string;
  entity: string;
}

export interface RememberBackstopDeps extends RememberFactDeps {
  extract(utterance: string): Promise<BackstopFact[]>;
}

export interface RememberBackstopInput {
  utterance: string;
  tenant_id: string;
  user_id: string;
  thread_id?: string | null;
}

/** At most this many facts from one utterance; the rest wait for the background extractor. */
const MAX_FACTS = 3;

export async function runRememberBackstop(
  input: RememberBackstopInput,
  deps: RememberBackstopDeps,
): Promise<RememberFactToolResult[]> {
  const facts = (await deps.extract(input.utterance).catch(() => [] as BackstopFact[]))
    .filter((f) => f && f.fact_key && typeof f.fact_value === 'string' && f.fact_value.trim())
    .slice(0, MAX_FACTS);
  const results: RememberFactToolResult[] = [];
  for (const f of facts) {
    results.push(
      await runRememberFact(
        {
          tenant_id: input.tenant_id,
          user_id: input.user_id,
          fact_key: f.fact_key,
          fact_value: f.fact_value,
          about: f.entity === 'self' || !f.entity ? 'self' : 'other',
          thread_id: input.thread_id ?? null,
        },
        deps,
      ),
    );
  }
  return results;
}

/**
 * The system note for the model, or null when there is nothing to tell
 * (no fact could be extracted — the model's own reply stands).
 */
export function buildRememberBackstopNote(
  results: RememberFactToolResult[],
  reason: 'no_call' | 'stored_value_echoed' | 'claimed_without_call' = 'no_call',
): string | null {
  if (results.length === 0) return null;
  // VTID-04690: after the model's own remember_fact came back already_known,
  // only a result that differs from that is news; otherwise its reply stands.
  if (reason === 'stored_value_echoed' && results.every((r) => r.status === 'already_known')) return null;
  const lines = results.map((r) => `- ${r.fact_key}: ${formatRememberFactResult(r)}`);
  const lead =
    reason === 'claimed_without_call'
      ? 'your answer said you saved or will remember what the member just said, but you did not call remember_fact, so nothing was saved. The gateway ran it:'
      : reason === 'stored_value_echoed'
      ? 'you called remember_fact with the value that was already stored, not the value the member just said. The gateway ran it with the member\'s own words:'
      : 'the member asked you to remember something and you answered without calling remember_fact. The gateway ran it:';
  return [
    `${REMEMBER_BACKSTOP_MARKER} System result, not said by the member: ${lead}`,
    ...lines,
    'Now tell the member the real outcome in one or two short sentences, in their language. If your previous answer said something different, correct it plainly. Do not call remember_fact for these facts again unless the member answers a question you ask.',
  ].join('\n');
}

/** A conflict the member was asked about in this session and has not answered yet. */
export interface OpenConflict {
  fact_key: string;
  stored_value: string;
  new_value: string;
  about: 'self' | 'other';
}

export function openConflictsFrom(results: RememberFactToolResult[], abouts: Array<'self' | 'other'>): OpenConflict[] {
  const out: OpenConflict[] = [];
  results.forEach((r, i) => {
    if (r.status === 'conflict' && r.stored_value) {
      out.push({ fact_key: r.fact_key, stored_value: r.stored_value, new_value: r.new_value, about: abouts[i] ?? 'other' });
    }
  });
  return out;
}

/**
 * The member's answer to "which one is right?". The answer rarely repeats
 * the fact ("der siebte ist richtig"), so the extractor is told what was
 * asked; the value it returns must match one of the two candidates, or
 * nothing is written.
 */
export async function runConflictAnswerBackstop(
  input: RememberBackstopInput & { conflict: OpenConflict },
  deps: RememberBackstopDeps,
): Promise<RememberFactToolResult[]> {
  const { conflict } = input;
  const framed =
    `The member was asked which value of ${conflict.fact_key} is correct: ` +
    `"${conflict.stored_value}" or "${conflict.new_value}". The member answered: "${input.utterance}"`;
  const facts = await deps.extract(framed).catch(() => [] as BackstopFact[]);
  const { valuesMatch } = await import('./remember-fact-tool');
  const chosen = facts
    .map((f) => String(f.fact_value ?? '').trim())
    .find((v) => v && (valuesMatch(v, conflict.new_value) || valuesMatch(v, conflict.stored_value)));
  if (!chosen) return [];
  const value = valuesMatch(chosen, conflict.new_value) ? conflict.new_value : conflict.stored_value;
  return [
    await runRememberFact(
      {
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        fact_key: conflict.fact_key,
        fact_value: value,
        about: conflict.about,
        confirm_replace: true,
        thread_id: input.thread_id ?? null,
      },
      deps,
    ),
  ];
}
