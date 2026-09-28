/**
 * VTID-04692: the gateway keeps "what is my …?" questions answered when the
 * voice model says a stored fact is not stored.
 *
 * Live suite on staging, 2026-09-28: the member asked "Wie heißt mein Hund?"
 * with `user_pet_name = Bello` stored and in the session's context. Nova
 * answered "leider habe ich diese Information nicht in deinen gespeicherten
 * Daten" without calling search_memory — B-REC-01 failed in 4 of 7 runs, and
 * B-REC-03 ("Wann feiert mein Bruder Paul?", `paul_birthday = May 5`) the same
 * way. Prompt wording cannot make this reliable, so this path does not
 * depend on it:
 *
 *   1. the member's utterance is a question about their own details;
 *   2. the reply this turn denied knowing it, or only promised to look;
 *   3. no remember/forget tool ran in the turn (a search that found
 *      nothing does not count — one live run searched, missed, and said
 *      "nicht finden");
 *   4. the gateway reads the member's current stored facts and gives them to
 *      the model as a system note; the model answers from them, or says
 *      plainly that nothing matching is stored.
 *
 * The facts are the member's own, read for the member's own session. The
 * note is intent for the model, never a sentence for Vitana to speak
 * (CLAUDE.md NEVER rule 41).
 */

import { REMEMBER_BACKSTOP_MARKER } from './remember-backstop';

// A question word and a first-person possessive in the same utterance:
// "wie heißt mein Hund", "wann hat meine Frau Geburtstag", "what is my …".
const QUESTION_WORD =
  /\b(wie|wann|wo|was|wer|welche[rsnm]?|wieso|what|when|where|who|which|how|cómo|cuál|cuándo|dónde|qué|quién|kako|kada|gde|gdje|šta|što|koji|koja|koje)\b/i;
const OWN_POSSESSIVE =
  /\b(mein|meine|meinen|meinem|meiner|meines|my|mi|mis|moj|moja|moje|mog|mojoj|mojem)\b/i;
// "weißt du noch …", "erinnerst du dich …", "do you remember …".
const ASK_MEMORY =
  /\b(weißt du (noch|eigentlich)?|erinnerst du dich|kennst du (noch )?(den|die|das)? ?namen?|do you (still )?(remember|know)|te acuerdas|sabes|sećaš li se|znaš li)\b/i;

// "Was weißt du (alles) über mich?" — asks for the member's facts in general.
const ABOUT_ME =
  /\b(was weißt du[^?.!]{0,30} über mich|was hast du (dir )?(über mich )?gespeichert|what do you (know|remember) about me|what have you (stored|saved) about me|qué sabes (de|sobre) mí|šta znaš o meni|što znaš o meni)\b/i;

export function detectAboutMeQuestion(text: string): boolean {
  if (!text || text.startsWith(REMEMBER_BACKSTOP_MARKER)) return false;
  return ABOUT_ME.test(text);
}

// VTID-04705: the member asks about themself with "ich", not "mein" — live
// B-PROF-03: "Wann habe ich Geburtstag?" got "Ich überprüfe das für dich.
// einen Moment bitte." and nothing else. A verb directly followed by the
// pronoun is the question word order ("habe ich", "bin ich", "am I").
const OWN_SUBJECT =
  /\b(habe|hab|bin|war|heiße|heisse|wohne|arbeite|mag|esse|trinke|lebe)\s+ich\b|\b(am|was|do|did)\s+i\b|\b(tengo|soy|vivo)\b|\b(imam|sam|živim)\s+ja\b/i;

export function detectRecallQuestion(text: string): boolean {
  if (!text || text.startsWith(REMEMBER_BACKSTOP_MARKER)) return false;
  if (ASK_MEMORY.test(text)) return true;
  return QUESTION_WORD.test(text) && (OWN_POSSESSIVE.test(text) || OWN_SUBJECT.test(text));
}

// The reply said it does not know, cannot show it, or only promised to look.
const DENIES_OR_DEFERS = new RegExp(
  [
    'nicht (gespeichert|finden|gefunden|hinterlegt|bekannt|vorhanden|notiert)',
    'keine (information|informationen|angabe|angaben|daten|ahnung)',
    'nicht in deine[nm]? ',
    'weiß ich (leider )?nicht',
    'kann (ich )?(dir )?(leider )?(keine|nicht)',
    'leider (nicht|kein)',
    'einen moment',
    'muss (erst|zuerst) (nach|in)',
    "(don't|do not|doesn't) (have|know|see)",
    'not (stored|saved|found|sure)',
    "(couldn't|could not|can't|cannot) (find|see|tell|show)",
    'no (information|record|data)',
    'let me (check|look)',
    'one moment',
    'no (tengo|lo sé|encontr)',
    'nemam|ne znam|nisam (našla|pronašla)',
    // VTID-04700: a counter-question instead of the answer. Live B-REC-05:
    // "ich brauche ein paar Informationen. Kannst du mir sagen, ob Paul ein
    // Mitglied der Maxina-Community ist …" with paul_birthday stored.
    'brauche (noch )?(ein paar |ein bisschen |etwas |mehr |weitere )*(informationen|angaben|details)',
    'kannst du mir (bitte )?(sagen|verraten|mitteilen|genauer)',
    '(need|needs) (a few |some |more )*(information|details|info)',
    'can you (please )?tell me (whether|if|which|who|more)',
    'necesito (más |algunos? )?(información|datos|detalles)',
    'trebam (više |još )?(informacija|podataka|detalja)',
    // VTID-04700: a promise to look that ends the turn. Live B-TIME-02: the
    // appointment was a stored fact, search_calendar found nothing, and the
    // reply was only "Ich überprüfe deinen Kalender, um … zu finden."
    '\\bich (über)?prüfe\\b',
    '\\bich (schaue|schau|sehe|guck|gucke|suche) (mal |kurz |gleich )?(nach|in|im|deine|dein)\\b',
    "\\bi('m| am) (checking|looking)\\b",
    '\\b(voy a|déjame) (revisar|comprobar|mirar|buscar)\\b',
    '\\b(proveriću|proveravam|provjerit ću|provjeravam)\\b',
  ].join('|'),
  'i',
);

export function replyDeniesOrDefers(reply: string): boolean {
  return Boolean(reply) && DENIES_OR_DEFERS.test(reply);
}

export interface RecallFact {
  fact_key: string;
  fact_value: string;
  provenance_source?: string | null;
}

// VTID-04707: live B-REC-06 — "Was weißt du alles über mich?" with Lasagne and
// Bello stored got the member's name, language, goals, follows and matches,
// none of what the member had told Vitana. The reply named "E2E" (the profile
// name), so "names a stored value" held and the backstop stood down. An
// about-me answer is judged on the facts the member stated themself; profile
// basics do not count.
const PROFILE_BASIC_KEY = /^(user_name|user_first_name|user_last_name|user_birthday|user_birthdate|user_date_of_birth|user_hometown|user_city|user_location)$/i;

/** Facts the member stated themself (by voice or in the Garden), profile basics and system keys excluded. */
export function memberStatedFacts(facts: RecallFact[]): RecallFact[] {
  return facts.filter(
    (f) =>
      f &&
      /^user_stated/i.test(String(f.provenance_source || '')) &&
      !SYSTEM_KEY.test(f.fact_key) &&
      !PROFILE_BASIC_KEY.test(f.fact_key),
  );
}

/** Keys the gateway writes for itself; never member knowledge. */
const SYSTEM_KEY = /^(preferred_language|stt_language|user_timezone|timezone|locale)$/i;
/** Bounds the note: Nova text turns stay small. */
const MAX_FACTS = 40;
const MAX_VALUE_CHARS = 120;

/** True when the reply already carries a stored value — it answered, just with extra words. */
export function replyContainsStoredValue(reply: string, facts: RecallFact[]): boolean {
  const r = reply.toLowerCase();
  return facts.some((f) => {
    const v = String(f.fact_value || '').trim().toLowerCase();
    return v.length >= 3 && r.includes(v);
  });
}

// Words a member asks with, mapped to the English words fact keys are named
// with. Only for ranking: a fact that matches is offered first.
const KEY_HINTS: Array<[RegExp, string[]]> = [
  [/\b(hund|hundes|katze|haustier|dog|cat|pet|perro|gato|mascota|pas|psa|mačka|ljubimac)\b/i, ['pet', 'dog', 'cat']],
  [/\b(geburtstag|geboren|birthday|born|cumpleaños|rođendan)\b/i, ['birthday', 'birth']],
  [/\b(feiert|feiern|celebrate)\b/i, ['birthday', 'anniversary']],
  [/\b(frau|mann|ehefrau|ehemann|partner|partnerin|wife|husband|spouse|esposa|esposo|žena|muž)\b/i, ['spouse', 'wife', 'husband', 'partner']],
  [/\b(bruder|brother|hermano|brat)\b/i, ['brother', 'sibling']],
  [/\b(schwester|sister|hermana|sestra)\b/i, ['sister', 'sibling']],
  [/\b(mutter|mama|mother|mom|madre|majka)\b/i, ['mother', 'mom']],
  [/\b(vater|papa|father|dad|padre|otac)\b/i, ['father', 'dad']],
  [/\b(sohn|tochter|kind|kinder|son|daughter|child|children|hijo|hija|sin|ćerka|dete)\b/i, ['son', 'daughter', 'child']],
  [/\b(farbe|colou?r|color|boja)\b/i, ['color', 'colour']],
  [/\b(wohne|wohnort|stadt|live|city|ciudad|grad)\b/i, ['city', 'location', 'home']],
  [/\b(arbeit|beruf|job|work|trabajo|posao)\b/i, ['job', 'occupation', 'work', 'employer']],
  [/\b(allergie|allergisch|allergy|allergic|alergia|alergija)\b/i, ['allerg']],
  [/\b(essen|lieblingsessen|food|comida|hrana)\b/i, ['food', 'dish']],
];

function tokens(s: string): string[] {
  return String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
}

/** How strongly a stored fact matches the question: shared words, then key hints. */
export function recallScore(question: string, fact: RecallFact): number {
  const q = new Set(tokens(question));
  const keyWords = tokens(String(fact.fact_key).replace(/_/g, ' '));
  let score = 0;
  for (const w of [...keyWords, ...tokens(fact.fact_value)]) if (q.has(w)) score += 2;
  const key = String(fact.fact_key).toLowerCase();
  for (const [re, hints] of KEY_HINTS) if (re.test(question) && hints.some((h) => key.includes(h))) score += 1;
  return score;
}

/** The system note, or null when there is nothing stored to offer. */
export function buildRecallBackstopNote(
  facts: RecallFact[],
  question = '',
  reason: 'denied' | 'about_me_vague' = 'denied',
): string | null {
  const usable = facts
    .filter((f) => f && f.fact_key && !SYSTEM_KEY.test(f.fact_key) && String(f.fact_value ?? '').trim())
    // Matching facts first (stable: newest-first order is kept within a score).
    .map((f, i) => ({ f, i, s: recallScore(question, f) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.f)
    .slice(0, MAX_FACTS);
  if (usable.length === 0) return null;
  const lines = usable.map((f) => `- ${f.fact_key}: ${String(f.fact_value).trim().slice(0, MAX_VALUE_CHARS)}`);
  if (reason === 'about_me_vague') {
    return [
      `${REMEMBER_BACKSTOP_MARKER} System result, not said by the member: the member asked what you know about them and your answer named none of the things they told you. These are the member's current stored facts, the ones they told you first (key: value):`,
      ...lines,
      "Now answer the question: name two or three of the first facts briefly and concretely, in the member's language — a key names the meaning in English (user_pet_name is the member's pet). Do not read out keys, and do not list everything.",
    ].join('\n');
  }
  return [
    `${REMEMBER_BACKSTOP_MARKER} System result, not said by the member: the member asked about something about themselves and your answer said you do not know it or only promised to look. These are the member's current stored facts (key: value):`,
    ...lines,
    'If one of them answers the question, give the answer now in one short sentence, in the member\'s language, and correct your previous answer plainly — a key names the meaning in English (user_pet_name is the member\'s pet, <name>_birthday is that person\'s birthday). If none of them answers it, say plainly that it is not stored. Do not list the other facts.',
  ].join('\n');
}
