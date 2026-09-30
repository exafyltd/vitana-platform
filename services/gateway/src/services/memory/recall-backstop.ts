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
// VTID-04712: German wo-compounds and "why" words. Live B-SELF-02 (pass 7):
// "Worauf bin ich allergisch?" matched no question word.
const QUESTION_WORD =
  /\b(wie|wann|wo|was|wer|welche[rsnm]?|wieso|warum|weshalb|weswegen|wieviele?|wor?(auf|an|aus|bei|durch|für|gegen|her|hin|mit|nach|rin|über|um|unter|von|vor|zu)|what|when|where|who|which|how|why|cómo|cuál|cuándo|dónde|qué|quién|kako|kada|gde|gdje|šta|što|zašto|koji|koja|koje)\b/i;
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

// Codex review on #3802: a yes/no question opens with the verb and has no
// question word — "Do I have any allergies?", "Bin ich allergisch?".
const LEADING_OWN_SUBJECT =
  /^\s*(?:(?:und|also|sag mal|okay|ok|and|so)[,\s]+)?(?:(?:habe|hab|bin|war|wohne|arbeite|mag|esse|trinke|lebe)\s+ich\b|(?:am|was|do|did|have)\s+i\b|(?:imam|sam|živim)\s+ja\b)/i;

export function detectRecallQuestion(text: string): boolean {
  if (!text || text.startsWith(REMEMBER_BACKSTOP_MARKER)) return false;
  if (ASK_MEMORY.test(text)) return true;
  if (LEADING_OWN_SUBJECT.test(text)) return true;
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
    // VTID-04712: "Lass mich kurz in deinen Aufzeichnungen nachsehen." ended
    // the turn (live B-SELF-02, pass 7).
    '\\blass mich (mal |kurz |gleich |eben )?([\\wäöüß]+ ){0,6}(nachsehen|nachschauen|nachschlagen|schauen|prüfen|überprüfen|checken|suchen)\\b',
    '\\blet me (quickly |just |first )?(check|look|see)\\b',
    '\\bdaj(te)? da (pogledam|proverim|provjerim)\\b',
  ].join('|'),
  'i',
);

// VTID-04704: a refusal on privacy grounds. Live staging 2026-09-28, "wie
// heißt meine Frau" with no matching fact stored: "Tut mir leid, aber ich
// kann diese persönliche Information nicht preisgeben." Nothing a member
// told Vitana about themselves or their own people is private from them.
// Only a REFUSAL counts — a bare "Datenschutz" / "Privatsphäre" is also how
// Vitana names the privacy settings page when asked where it is (staging
// bf6360e: "… wo du alles zu Erinnerungen und Privatsphäre verwalten kannst").
const CITES_PRIVACY = new RegExp(
  [
    'nicht (preisgeben|verraten|weitergeben|herausgeben|mitteilen|teilen)',
    '(aus|wegen|aufgrund) (von )?(des |der |dem )?(datenschutz|privatsphäre)',
    'datenschutz(gründen|richtlinie|richtlinien|bestimmungen|regeln|vorgaben)',
    '(kann|darf|dürfen) .{0,40}(persönliche|private|vertrauliche|sensible)n? (information|informationen|daten|angaben|details)',
    "(can't|cannot|can not|am not able to|am not allowed to|not permitted to) (share|disclose|reveal|give out|tell you)",
    '(for|due to|because of) (privacy|data protection)',
    'privacy (reasons|polic)',
    'por (motivos de |razones de )?privacidad',
    'no puedo (compartir|revelar|divulgar)',
    'zbog (privatnosti|zaštite podataka)',
    'ne mogu (da )?(podelim|podijelim|otkrijem|kažem)',
  ].join('|'),
  'i',
);

export function replyCitesPrivacy(reply: string): boolean {
  return Boolean(reply) && CITES_PRIVACY.test(reply);
}

export function replyDeniesOrDefers(reply: string): boolean {
  return Boolean(reply) && (DENIES_OR_DEFERS.test(reply) || CITES_PRIVACY.test(reply));
}

// VTID-04704: sends the member to their profile instead of answering. Staging
// bf6360e, "wie heißt meine frau" with nothing stored: "ich muss auf deine
// Profileinstellungen zugreifen … Möchtest du, dass ich dich zu deinen
// Profileinstellungen führe, wo du diese Details einsehen kannst?" Not used
// for a question about the app's own settings or screens (see asksAboutApp).
const DEFLECTS_TO_PROFILE = new RegExp(
  [
    'muss (erst |zuerst )?auf dein(e|en)? (profil|profileinstellungen|einstellungen|daten)\\w* zugreifen',
    'wo du (diese|die|deine) (details|informationen|daten|angaben) (einsehen|nachsehen|finden)',
    '(in|zu) dein(em|en|er)? profil\\w* .{0,40}(einsehen|nachsehen|nachschauen|findest|finden)',
    '(check|look it up|find it|see it) in your (profile|settings)',
    'need to access your (profile|settings)',
  ].join('|'),
  'i',
);

export function replyDeflectsToProfile(reply: string): boolean {
  return Boolean(reply) && DEFLECTS_TO_PROFILE.test(reply);
}

// A question about the app itself — where a setting or screen is — is not a
// question about what the member told Vitana.
const APP_QUESTION =
  /(einstellung|settings?\b|seite\b|page\b|bildschirm|screen|menü|menu|\bapp\b|profil|profile|konto|account|ajustes|configuraci|podešavanj|postavk)/i;

export function asksAboutApp(question: string): boolean {
  return APP_QUESTION.test(question || '');
}

// VTID-04704: a date named in answer to a birthday / anniversary question
// that no stored fact carries. Live staging 2026-09-28, "erinnerst du dich
// an den Geburtstag meiner Frau" with no spouse fact stored: "… am 23.
// April". A made-up date is worse than "I don't know": the member acts on it.
const DATE_QUESTION =
  /\b(geburtstag|geboren|jahrestag|hochzeitstag|birthday|born|anniversary|cumpleaños|aniversario|rođendan|rodjendan|godišnjica)\b/i;

const MONTHS: Array<[RegExp, number]> = [
  [/^(januar|jänner|january|jan|enero|siječanj|januara)\.?$/i, 1],
  [/^(februar|feber|february|feb|febrero|veljača|februara)\.?$/i, 2],
  [/^(märz|maerz|march|mar|marzo|mart|ožujak|marta)\.?$/i, 3],
  [/^(april|apr|abril|travanj|aprila)\.?$/i, 4],
  [/^(mai|may|mayo|maj|svibanj|maja)\.?$/i, 5],
  [/^(juni|june|jun|junio|lipanj|juna)\.?$/i, 6],
  [/^(juli|july|jul|julio|srpanj|jula)\.?$/i, 7],
  [/^(august|aug|agosto|avgust|kolovoz|avgusta)\.?$/i, 8],
  [/^(september|sept|sep|septiembre|septembar|rujan|septembra)\.?$/i, 9],
  [/^(oktober|october|oct|okt|octubre|oktobar|listopad|oktobra)\.?$/i, 10],
  [/^(november|nov|noviembre|novembar|studeni|novembra)\.?$/i, 11],
  [/^(dezember|december|dec|dez|diciembre|decembar|prosinac|decembra)\.?$/i, 12],
];

function monthOf(word: string): number | null {
  for (const [re, m] of MONTHS) if (re.test(word)) return m;
  return null;
}

/** Day-month pairs ("12-3") named in a text: "12. März", "March 12th", "12.03.", "1985-03-12". */
export function extractDayMonths(text: string): Set<string> {
  const out = new Set<string>();
  const s = String(text || '');
  const add = (d: number, m: number | null) => {
    if (m && d >= 1 && d <= 31) out.add(`${d}-${m}`);
  };
  for (const x of s.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) add(Number(x[3]), Number(x[2]));
  for (const x of s.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/g)) add(Number(x[1]), Number(x[2]) <= 12 ? Number(x[2]) : null);
  for (const x of s.matchAll(/\b(\d{1,2})(?:\.|st|nd|rd|th)?\s+(?:de\s+|of\s+)?(\p{L}{3,})/gu)) add(Number(x[1]), monthOf(x[2]));
  for (const x of s.matchAll(/(\p{L}{3,})\s+(\d{1,2})(?:st|nd|rd|th)?\b/gu)) add(Number(x[2]), monthOf(x[1]));
  return out;
}

export function asksForDate(question: string): boolean {
  return DATE_QUESTION.test(question || '');
}

/** True when the reply names a day and month that no stored fact carries. */
export function replyNamesUnstoredDate(reply: string, facts: RecallFact[]): boolean {
  const named = extractDayMonths(reply);
  if (named.size === 0) return false;
  const stored = new Set<string>();
  for (const f of facts) for (const dm of extractDayMonths(String(f.fact_value ?? ''))) stored.add(dm);
  for (const dm of named) if (!stored.has(dm)) return true;
  return false;
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

/** Facts the note can offer: member knowledge with a value, system keys left out. */
export function usableRecallFacts(facts: RecallFact[]): RecallFact[] {
  return (facts || []).filter((f) => f && f.fact_key && !SYSTEM_KEY.test(f.fact_key) && String(f.fact_value ?? '').trim());
}

// VTID-04753: the member did not hear the reply (the recall hold kept it
// back), so the note's answer is their first one, not a correction.
const HELD_REPLY =
  'The member did not hear your previous answer, so give this as your answer to them; do not mention a correction or a previous answer.';

/** The system note, or null when there is nothing stored to offer. */
export function buildRecallBackstopNote(
  facts: RecallFact[],
  question = '',
  reason: 'denied' | 'about_me_vague' | 'unstored_date' = 'denied',
  held = false,
): string | null {
  const usable = usableRecallFacts(facts)
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
  if (reason === 'unstored_date') {
    return [
      `${REMEMBER_BACKSTOP_MARKER} System result, not said by the member: the member asked for a date and your answer named a date that none of their stored facts carries. These are the member's current stored facts (key: value):`,
      ...lines,
      held
        ? "If one of them answers the question, answer now in one short sentence, in the member's language — <name>_birthday is that person's birthday, spouse_birthday the partner's. If none of them answers it, say plainly that you do not have that date yet, and ask the member for it. Never guess a date. " + HELD_REPLY
        : "If one of them answers the question, correct your answer now in one short sentence, in the member's language — <name>_birthday is that person's birthday, spouse_birthday the partner's. If none of them answers it, say plainly that you got it wrong, that you do not have that date yet, and ask the member for it. Never guess a date.",
    ].join('\n');
  }
  return [
    `${REMEMBER_BACKSTOP_MARKER} System result, not said by the member: the member asked about something about themselves and your answer said you do not know it, refused it, or only promised to look. These are the member's current stored facts (key: value):`,
    ...lines,
    `If one of them answers the question, give the answer now in one short sentence, in the member's language${held ? '' : ', and correct your previous answer plainly'} — a key names the meaning in English (user_pet_name is the member's pet, <name>_birthday is that person's birthday). If none of them answers it, say plainly that it is not stored yet and ask the member for it. Never cite privacy for what the member told you about themselves or their own people. Do not list the other facts.${held ? ` ${HELD_REPLY}` : ''}`,
  ].join('\n');
}

/**
 * VTID-04704: nothing usable is stored, but the reply refused on privacy
 * grounds or named a date. "Not stored" was the honest answer; the model is
 * told to give that instead. Intent only, never a sentence to speak.
 */
export function buildNothingStoredNote(reason: 'privacy_refusal' | 'unstored_date' | 'deflected', held = false): string {
  const what =
    reason === 'unstored_date'
      ? 'your answer named a date, but nothing about it is stored — the date was a guess'
      : reason === 'deflected'
        ? 'your answer sent them to look it up in their profile or settings, but it is not there — nothing about it is stored yet'
        : 'your answer refused on privacy grounds, but what the member told you about themselves or their own people is never private from them — and nothing about it is stored yet';
  if (held) {
    return `${REMEMBER_BACKSTOP_MARKER} System result, not said by the member: the member asked about something about themselves and ${what}. Answer now in one short sentence, in the member's language: say plainly that you do not have it yet, and ask the member for it so you can remember it. Never guess, and never cite privacy. ${HELD_REPLY}`;
  }
  return `${REMEMBER_BACKSTOP_MARKER} System result, not said by the member: the member asked about something about themselves and ${what}. Correct your answer now in one short sentence, in the member's language: say plainly that you do not have it yet, and ask the member for it so you can remember it. Never guess, and never cite privacy.`;
}
