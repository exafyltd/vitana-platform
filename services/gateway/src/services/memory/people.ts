/**
 * VTID-04766: the people in a member's life, read from their facts.
 *
 * Production, 2026-09-29: the member said "ihr Vater heißt Viktor und die
 * Mutter heißt Tatjana" about his wife's parents. The model stored them as
 * `maria_maksina_father` / `maria_maksina_mother`; the remember backstop
 * stored them again as `father_name` / `mother_name` — his own parents — and
 * his own parents then replaced them. Asked "wie heißt der Vater meiner
 * Ehefrau", Vitana did not know: a fact key was free text, and nothing knew
 * that `maria_maksina_father` and `spouse_father_name` are the same person.
 *
 * A relative is a relation PATH from the member plus an attribute:
 *   spouse_name           → [spouse]          name
 *   spouse_father_name    → [spouse, father]  name
 *   maria_maksina_father  → [spouse, father]  name   (Maria Maksina is the spouse)
 *   schwiegervater_name   → [spouse, father]  name
 *   hunde_name            → [dog]             name
 *
 * The facts stay the only store (one write API, the Memory Garden shows
 * them, forget and erasure work unchanged). This module only reads keys:
 *   - relationKey() gives a new relative's fact its one canonical key, so a
 *     correction replaces the old value instead of sitting next to it;
 *   - sameRelative() says whether two keys name the same relative, so a
 *     wife's father is never matched against the member's own father;
 *   - formatPeopleBlock() lists who is who for the model.
 */

// Same normalisation as remember-fact-tool's normalizeFactKey (not imported:
// that module imports this one).
function normalizeKey(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Words that are also ordinary English in a key ("kind_of_music", "chef",
// "sin", "brat") are left out on purpose.
const RELATION_WORDS: Record<string, string[]> = {
  spouse: ['spouse'], wife: ['spouse'], husband: ['spouse'], ehefrau: ['spouse'], ehemann: ['spouse'],
  frau: ['spouse'], mann: ['spouse'], partner: ['spouse'], partnerin: ['spouse'],
  fiancee: ['spouse'], fiance: ['spouse'], verlobte: ['spouse'], verlobter: ['spouse'],
  supruga: ['spouse'], suprug: ['spouse'], esposa: ['spouse'], esposo: ['spouse'],
  father: ['father'], vater: ['father'], dad: ['father'], papa: ['father'], otac: ['father'], padre: ['father'],
  mother: ['mother'], mutter: ['mother'], mom: ['mother'], mama: ['mother'], majka: ['mother'], madre: ['mother'],
  son: ['son'], sohn: ['son'], hijo: ['son'],
  daughter: ['daughter'], tochter: ['daughter'], cerka: ['daughter'], hija: ['daughter'],
  child: ['child'], kids: ['child'], children: ['child'], kinder: ['child'],
  brother: ['brother'], bruder: ['brother'], hermano: ['brother'],
  sister: ['sister'], schwester: ['sister'], sestra: ['sister'], hermana: ['sister'],
  sibling: ['sibling'], geschwister: ['sibling'],
  grandfather: ['grandfather'], opa: ['grandfather'], grossvater: ['grandfather'], grandpa: ['grandfather'],
  grandmother: ['grandmother'], oma: ['grandmother'], grossmutter: ['grandmother'], grandma: ['grandmother'],
  grandchild: ['grandchild'], enkel: ['grandchild'], enkelin: ['grandchild'],
  uncle: ['uncle'], onkel: ['uncle'], aunt: ['aunt'], tante: ['aunt'], cousin: ['cousin'], cousine: ['cousin'],
  friend: ['friend'], freund: ['friend'], freundin: ['friend'],
  colleague: ['colleague'], kollege: ['colleague'], kollegin: ['colleague'], boss: ['boss'],
  schwiegervater: ['spouse', 'father'], schwiegermutter: ['spouse', 'mother'],
  pet: ['pet'], haustier: ['pet'], haustiers: ['pet'],
  dog: ['dog'], hund: ['dog'], hunde: ['dog'], hundes: ['dog'],
  cat: ['cat'], katze: ['cat'], katzen: ['cat'],
};

// "father_in_law" / "mother_in_law" read as a pair of words.
const IN_LAW: Record<string, string[]> = { father: ['spouse', 'father'], mother: ['spouse', 'mother'] };

const LEADING_NOISE = new Set(['user', 'my', 'mein', 'meine', 'meiner', 'meines', 'own']);

const ATTRIBUTE_WORDS: Record<string, string> = {
  name: 'name', namen: 'name', vorname: 'first_name', first: 'first', nickname: 'nickname', spitzname: 'nickname',
  birthday: 'birthday', geburtstag: 'birthday', geburtsdatum: 'birthday', bday: 'birthday', dob: 'birthday',
  age: 'age', alter: 'age', job: 'job', beruf: 'job', occupation: 'job',
  city: 'city', wohnort: 'city', residence: 'city', phone: 'phone', email: 'email',
  spelling: 'spelling', schreibweise: 'spelling',
};

export interface RelationKey {
  path: string[];
  attribute: string;
}

export interface KeyedFact {
  fact_key: string;
  fact_value: string;
}

function tokensOf(text: string): string[] {
  return normalizeKey(
    String(text || '')
      .toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'),
  ).split('_').filter(Boolean);
}

function attributeOf(tokens: string[]): string {
  if (tokens.length === 0) return 'name';
  return tokens.map((t) => ATTRIBUTE_WORDS[t] ?? t).join('_');
}

/** Relation path of a key with no person names in it, or null. */
function parsePlain(tokens: string[]): RelationKey | null {
  const path: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (IN_LAW[t] && tokens[i + 1] === 'in' && tokens[i + 2] === 'law') {
      path.push(...IN_LAW[t]);
      i += 3;
      continue;
    }
    const rel = RELATION_WORDS[t];
    if (!rel) break;
    path.push(...rel);
    i++;
  }
  if (path.length === 0) return null;
  return { path, attribute: attributeOf(tokens.slice(i)) };
}

/**
 * The relatives already known by name, so a key that names one of them
 * ("maria_maksina_father") resolves to their path. Keys whose own path is
 * unknown are skipped.
 */
function knownNames(facts: KeyedFact[]): Array<{ tokens: string[]; path: string[] }> {
  const out: Array<{ tokens: string[]; path: string[] }> = [];
  for (const f of facts) {
    const rel = parsePlain(stripNoise(tokensOf(f.fact_key)));
    if (!rel || rel.attribute !== 'name') continue;
    const tokens = tokensOf(f.fact_value);
    if (tokens.length > 0) out.push({ tokens, path: rel.path });
  }
  // Longest names first, so "maria_maksina" wins over a bare "maria".
  return out.sort((a, b) => b.tokens.length - a.tokens.length);
}

function stripNoise(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length - 1 && LEADING_NOISE.has(tokens[i])) i++;
  return tokens.slice(i);
}

// A general relation word covers its specific ones: the member says
// "Bruder" about the person stored as sibling_name.
const COVERS: Record<string, Set<string>> = {
  sibling: new Set(['brother', 'sister']),
  child: new Set(['son', 'daughter']),
  pet: new Set(['dog', 'cat']),
};

function stepsMatch(a: string, b: string): boolean {
  return a === b || !!COVERS[a]?.has(b) || !!COVERS[b]?.has(a);
}

function pathsMatch(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((step, i) => stepsMatch(step, b[i]));
}

// Joining words between an attribute and a trailing relation
// ("geburtstag_meiner_frau", "birthday_of_my_wife").
const JOINERS = new Set(['of', 'my', 'the', 'von', 'meiner', 'meines', 'meinem', 'der', 'des', 'dem', 'mein', 'meine']);

/** "geburtstag_meiner_frau" → [spouse] birthday. */
function parseTrailing(tokens: string[]): RelationKey | null {
  let end = tokens.length;
  const path: string[] = [];
  while (end > 0 && RELATION_WORDS[tokens[end - 1]]) {
    path.unshift(...RELATION_WORDS[tokens[end - 1]]);
    end--;
  }
  if (path.length === 0 || end === tokens.length) return null;
  const head = tokens.slice(0, end).filter((t) => !JOINERS.has(t));
  if (head.length === 0 || head.length === end) return null;  // needs a joiner: "dog_food" is not "food of the dog"
  if (!head.every((t) => ATTRIBUTE_WORDS[t])) return null;
  return { path, attribute: attributeOf(head) };
}

/**
 * The relation a fact key names, or null when it names no relative.
 * `facts` lets a key that starts with a relative's name resolve through them.
 */
export function parseRelationKey(factKey: string, facts: KeyedFact[] = []): RelationKey | null {
  const tokens = stripNoise(tokensOf(factKey));
  if (tokens.length === 0) return null;
  const plain = parsePlain(tokens);
  if (plain) {
    // "bruder_paul_geburtstag": the relative's own name inside the key.
    const attrTokens = plain.attribute.split('_');
    for (const known of knownNames(facts)) {
      if (!pathsMatch(known.path, plain.path)) continue;
      for (const len of [known.tokens.length, 1]) {
        const name = known.tokens.slice(0, len);
        if (attrTokens.length >= name.length && name.every((t, i) => attrTokens[i] === t)) {
          return { path: plain.path, attribute: attributeOf(attrTokens.slice(name.length)) };
        }
      }
    }
    return plain;
  }
  const trailing = parseTrailing(tokens);
  if (trailing) return trailing;
  // A key that starts with a known relative's full or first name.
  for (const known of knownNames(facts)) {
    for (const len of [known.tokens.length, 1]) {
      const name = known.tokens.slice(0, len);
      if (tokens.length <= name.length) continue;
      if (name.every((t, i) => tokens[i] === t)) {
        const rest = tokens.slice(name.length);
        const tail = parsePlain(rest);
        if (tail) return { path: [...known.path, ...tail.path], attribute: tail.attribute };
        return { path: known.path, attribute: attributeOf(rest) };
      }
    }
  }
  return null;
}

/**
 * The one key a relative's fact is stored under ("spouse_father_name"), or
 * null when the key already says it that way: "user_pet_name" keeps its
 * prefix, the extractor's own vocabulary.
 */
export function relationKey(factKey: string, facts: KeyedFact[] = []): string | null {
  const rel = parseRelationKey(factKey, facts);
  if (!rel) return null;
  const canonical = [...rel.path, rel.attribute].join('_');
  return canonical === stripNoise(tokensOf(factKey)).join('_') ? null : canonical;
}

/**
 * Whether two keys are about relatives and, if so, the same relative and
 * attribute. null when either key names no relative (the caller's ordinary
 * matching applies).
 */
export function sameRelative(a: string, b: string, facts: KeyedFact[] = []): boolean | null {
  const ra = parseRelationKey(a, facts);
  const rb = parseRelationKey(b, facts);
  if (!ra || !rb) return null;
  return ra.attribute === rb.attribute && pathsMatch(ra.path, rb.path);
}

const ATTRIBUTE_ORDER = ['name', 'first_name', 'nickname', 'spelling', 'birthday', 'age', 'job', 'city'];

/**
 * Who is who, for the model: one line per relative, by their relation to the
 * member. Data for the model, never a sentence to speak.
 */
export function formatPeopleBlock(facts: KeyedFact[]): string {
  const people = new Map<string, { path: string[]; attrs: Map<string, string> }>();
  for (const f of facts) {
    const value = String(f.fact_value ?? '').trim();
    if (!value) continue;
    const rel = parseRelationKey(f.fact_key, facts);
    if (!rel) continue;
    const id = rel.path.join('.');
    const entry = people.get(id) ?? { path: rel.path, attrs: new Map<string, string>() };
    if (!entry.attrs.has(rel.attribute)) entry.attrs.set(rel.attribute, value);
    people.set(id, entry);
  }
  if (people.size === 0) return '';
  const rank = (a: string) => {
    const i = ATTRIBUTE_ORDER.indexOf(a);
    return i < 0 ? ATTRIBUTE_ORDER.length : i;
  };
  const lines = [...people.values()]
    .sort((x, y) => x.path.length - y.path.length || x.path.join('.').localeCompare(y.path.join('.')))
    .map((p) => {
      const attrs = [...p.attrs.entries()]
        .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
        .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`)
        .join('; ');
      return `- ${p.path.join(' › ')}: ${attrs}`;
    });
  return (
    `<people>\n` +
    `The member's own people, by their relation to the member ("spouse › father" is the father of the member's spouse). ` +
    `Answer questions about a relative from the line with that exact relation; a relative of the spouse is never the member's own relative.\n` +
    `${lines.join('\n')}\n` +
    `</people>\n\n`
  );
}
