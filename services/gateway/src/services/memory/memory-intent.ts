/**
 * VTID-04684 / VTID-04685: two things a member says that must never become a
 * stored fact, recognised without a model call.
 *
 *   - a request to FORGET ("vergiss bitte, dass mein Hund Bello heißt").
 *     Live suite B-FORG-01 (2026-09-26): Nova answered "ich habe den Namen
 *     deines Hundes gelöscht" with no tool call, and the fact stayed. The
 *     gateway runs the forget itself (forget-fact.ts), and the extractor must
 *     not read the request as a statement of the fact;
 *   - a HYPOTHETICAL ("wenn ich einen Hund hätte, würde er Max heißen").
 *     Live suite B-NOISE-01: stored as user_preference_dog_name=Max.
 *
 * Anchored on grammar (the verbs of asking, the conditional mood), never on
 * topics, so an ordinary statement never matches.
 */

// "vergiss das nicht", "don't forget", "no olvides", "ne zaboravi" ask to REMEMBER.
const REMEMBER_NEGATION = /\bvergiss\s+(das\s+|es\s+|bitte\s+)?nicht\b|\bdo(n'?t|\s+not)\s+forget\b|\bno\s+olvides\b|\bne\s+zaboravi\b/i;

const FORGET_INTENT = new RegExp(
  [
    '\\bvergiss\\b',
    '\\bvergessen\\s+sie\\b',
    '\\bl(ö|oe)sch(e|en|t)?\\b.{0,60}\\b(gedächtnis|gedaechtnis|erinnerung|gespeichert|gemerkt|weißt|weisst|notiert)\\b',
    '\\b(streich|entfern)(e|en)?\\b.{0,60}\\b(gedächtnis|gedaechtnis|erinnerung|gespeichert|gemerkt|notiert)\\b',
    '\\bforget\\b',
    '\\b(delete|erase|remove)\\b.{0,60}\\b(memory|memories|remember|know|saved|stored|noted)\\b',
    '\\bolvida\\b',
    '\\bborra\\b.{0,60}\\b(memoria|recuerdo|guardado)\\b',
    '\\bzaboravi\\b',
    '\\bobri(ši|si)\\b.{0,60}\\b(memorij|zapamti|sačuva|sacuva)',
  ].join('|'),
  'i',
);

export function detectForgetIntent(text: string): boolean {
  if (!text) return false;
  if (REMEMBER_NEGATION.test(text)) return false;
  return FORGET_INTENT.test(text);
}

// VTID-04748: "lösch/entfern" without a memory word ("den Namen von meinem
// Hund löscht … lösche das bitte", production 2026-09-29). It can also mean a
// calendar entry or a message, so the backstop acts on it only when a stored
// fact actually matches.
const LOOSE_FORGET_INTENT = /\bl(ö|oe)sch(e|en|t|st)?\b|\bentfern(e|en|t|st)?\b|\b(delete|erase|remove)\b|\bborra\b|\bobri(š|s)i\b/i;

export function detectLooseForgetIntent(text: string): boolean {
  if (!text) return false;
  if (REMEMBER_NEGATION.test(text)) return false;
  return LOOSE_FORGET_INTENT.test(text);
}

// Conditional mood: "wenn ich … hätte/wäre/würde", "if I had/were … would",
// "si tuviera … sería". A plain future ("wenn ich morgen Zeit habe") does not match.
const HYPOTHETICAL = new RegExp(
  [
    '\\b(wenn|falls)\\b[^.?!]{0,80}\\b(hätte|haette|hätten|wäre|waere|wären|würde|wuerde|würden|könnte|koennte)\\b',
    '\\b(hätte|haette|wäre|waere)\\s+ich\\b',
    '\\bstell\\s+dir\\s+vor\\b',
    '\\bif\\s+(i|we)\\s+(had|were|was|could|did|owned)\\b',
    '\\bif\\s+i\\s+ever\\b[^.?!]{0,60}\\bwould\\b',
    '\\bimagine\\s+(if|that)\\b',
    '\\bsi\\s+(yo\\s+)?(tuviera|fuera|pudiera|tuviese)\\b',
  ].join('|'),
  'i',
);

export function isHypothetical(text: string): boolean {
  return Boolean(text) && HYPOTHETICAL.test(text);
}

/** Member lines of a "User: … / Assistant: …" transcript (all lines when unlabelled). */
export function memberLines(conversationText: string): string[] {
  const lines = String(conversationText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const labelled = lines.some((l) => /^(user|member|nutzer)\s*:/i.test(l));
  if (!labelled) return lines;
  return lines.filter((l) => /^(user|member|nutzer)\s*:/i.test(l)).map((l) => l.replace(/^[^:]+:\s*/, ''));
}

const norm = (s: string) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * True when a value the extractor returned is carried only by member lines
 * that are a forget request or a hypothetical — never by a plain statement.
 * Such a value is not a fact the member told us.
 */
export function valueOnlyInNonStatements(value: string, conversationText: string): boolean {
  const v = norm(value);
  if (!v) return false;
  const carrying = memberLines(conversationText).filter((l) => ` ${norm(l)} `.includes(` ${v} `));
  if (carrying.length === 0) return false;
  return carrying.every((l) => detectForgetIntent(l) || isHypothetical(l));
}
