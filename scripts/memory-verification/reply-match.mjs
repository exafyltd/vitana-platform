/**
 * VTID-04600 layer B: what a reply is checked against.
 *
 * A reply_none word only counts when a sentence asserts it. "Ich kann dein
 * Geburtsdatum nicht speichern … kann nicht direkt gespeichert werden" is the
 * correct refusal, not a claim that it was saved (B-PROF-01, pass 3). A word
 * that is itself a negation ("nicht speichern") is matched as written.
 *
 * A reply_none entry starting with "re:" is a regular expression matched
 * within one sentence, for a claim that only a word in context makes false.
 * B-CONF-02 (pass 6): "Für den Geburtstag habe ich bisher den 5. Mai
 * gespeichert, du hast aber gerade den 7. Mai genannt" names what is stored —
 * true — while "den 7. Mai gespeichert" would claim the new date was saved.
 * The expression runs on the whole reply; `[^.!?]` in it keeps a match inside
 * one sentence (commas do not end it), and a period after a digit ("7. Mai")
 * is not a sentence end. A negation earlier in that sentence denies the claim.
 */
const NEGATION = /\b(nicht|kein|keine|keinen|nie|niemals|not|no|never|cannot|can't|won't|didn't|don't|ne|nemoj|no puedo)\b/i;

export function claims(reply, word) {
  const text = String(reply || '').toLowerCase();
  if (word.startsWith('re:')) {
    const re = new RegExp(word.slice(3), 'giu');
    for (const m of text.matchAll(re)) {
      // Codex review on #3802: a negation earlier in the same sentence
      // ("Ich habe nicht gespeichert: 7. Mai") denies the claim. One after
      // the match ("… gespeichert, nicht den 5.") does not.
      if (!NEGATION.test(sentencePrefix(text, m.index) + m[0])) return true;
    }
    return false;
  }
  const w = word.toLowerCase();
  if (NEGATION.test(w)) return text.includes(w);
  return text
    .split(/(?<=[.!?])\s*|\n+/)
    .some((s) => s.includes(w) && !NEGATION.test(s));
}

/** The text from the start of the sentence containing `index` up to `index`.
 *  A period after a digit ("7. Mai") is not a sentence end. */
function sentencePrefix(text, index) {
  let start = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const c = text[i];
    if (c === '!' || c === '?' || c === '\n' || (c === '.' && !/\d/.test(text[i - 1] || ''))) {
      start = i + 1;
      break;
    }
  }
  return text.slice(start, index);
}
