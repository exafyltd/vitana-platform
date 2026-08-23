/**
 * VTID-03595 — domain query expansion for the ORB Navigator's catalog scorer.
 *
 * ## The problem this exists to solve
 *
 * `searchCatalogEntries` scores a screen purely on word/substring overlap
 * between the user's question and the entry's title / description /
 * when_to_visit. That works whenever the user happens to use the catalog's own
 * words, and fails completely when they don't — and users mostly don't.
 *
 * Measured on production (session `live-8ca8d4b0`, 2026-08-09, de):
 *
 *   "wo ich meine Schritte eintragen kann"  -> decision: unknown,   0 alternatives
 *   "Zeig mir, wo ich meine Schritte ..."   -> decision: ambiguous,
 *       Erinnerungen / Vitana-Index / Meine Reise
 *
 * The right screen is `HEALTH.TRACKER`. It is active, on the right platform,
 * with the right role, and its own `when_to_visit` reads *"ein
 * Gesundheitsverhalten loggen, Wasser/Schlaf/Bewegung verfolgen"* — semantically
 * an exact answer. Lexically it shares **not one substring** with "Schritte
 * eintragen", so it scored 0, and `score > 0` is the scorer's admission test.
 * An entry that scores 0 is dropped before any later stage — the LLM consult
 * never sees it, so it cannot pick it, and it guesses from what survived.
 *
 * That is the whole bug: not a ranking problem, an admission problem.
 *
 * ## Why a shared lexicon, and not the alternatives
 *
 * - **Not per-screen keyword lists.** There are 545 catalog entries. Hand-
 *   maintaining a keyword array on each is precisely the engineer-only,
 *   grows-forever data debt CLAUDE.md §13c warns about, and it would leave
 *   every screen added tomorrow broken until someone remembered.
 * - **Not embeddings.** This runs on the ORB voice turn — the path users
 *   already experience as too slow. An embedding round-trip per consult adds
 *   latency to exactly that, and needs a 545-entry backfill kept in sync with
 *   every catalog edit. A semantic index may well be right eventually; it is
 *   not a bug fix.
 * - **Not editing the one catalog row.** It fixes this sentence and nothing
 *   else.
 *
 * One lexicon of ~40 concepts covers the whole catalog at once, costs nothing
 * at runtime, and is deterministic — the same question always resolves the same
 * way, which is what makes the navigator testable at all.
 *
 * ## Two properties that are load-bearing
 *
 * 1. **Expansion is one-directional: the QUERY expands, the catalog never
 *    does.** Expanding catalog text would make all 545 entries match more
 *    things simultaneously — every entry gets noisier, and the entries that
 *    gain the most are the long ones, which are already the broadest. Expanding
 *    the query moves only the one thing the user actually said.
 *
 * 2. **An expanded token scores at reduced weight.** A word the user literally
 *    said is stronger evidence than a word we inferred they meant, so a literal
 *    match must always outrank an inferred one. Without this, a screen whose
 *    text happens to contain three inferred synonyms would beat the screen the
 *    user named outright.
 */

/** Weight applied to an inferred (expanded) token relative to a literal one.
 *  Deliberately below 1: an inferred match admits an entry into the candidate
 *  pool — which is the entire point — but must never outrank a word the user
 *  actually said. */
export const EXPANSION_WEIGHT = 0.5;

/**
 * User vocabulary → catalog vocabulary.
 *
 * Read each entry as: "when the user says any of these words, also look for
 * these catalog words." Keys are what people say out loud; values are what the
 * catalog actually contains — every value below was taken from live
 * `nav_catalog_i18n` text, not invented, so an expansion can only ever point at
 * words some real entry uses.
 *
 * Keep this list SHORT and evidence-led. A synonym added on a hunch is a
 * permanent, silent bias in every future consult; the cost of a wrong entry is
 * paid on questions nobody is looking at.
 */
const EXPANSIONS: ReadonlyArray<{ when: readonly string[]; look_for: readonly string[] }> = [
  // --- logging / recording an observation -----------------------------------
  // The reported failure. Users say "eintragen"; the catalog says "loggen",
  // "verfolgen", "erfassen", "tracker".
  {
    when: ['eintragen', 'eintrag', 'einträge', 'notieren', 'erfassen', 'festhalten', 'protokollieren'],
    look_for: ['loggen', 'verfolgen', 'tracker', 'erfassung', 'tagebuch'],
  },
  {
    when: ['log', 'logging', 'record', 'enter', 'track', 'tracking', 'journal'],
    look_for: ['tracker', 'log', 'diary', 'track'],
  },

  // --- physical activity ----------------------------------------------------
  // "Schritte" appears nowhere in the catalog; "Bewegung" is its word for the
  // same pillar.
  {
    when: ['schritte', 'schritt', 'laufen', 'gehen', 'sport', 'training', 'workout', 'fitness'],
    look_for: ['bewegung', 'aktivität', 'tracker', 'gesundheitsverhalten'],
  },
  {
    when: ['steps', 'walk', 'walking', 'exercise', 'workout'],
    look_for: ['movement', 'activity', 'tracker'],
  },

  // --- the other four Vitana Index pillars, same asymmetry ------------------
  { when: ['essen', 'mahlzeit', 'mahlzeiten', 'kalorien'], look_for: ['ernährung', 'tracker'] },
  { when: ['trinken', 'wasser'], look_for: ['hydration', 'tracker'] },
  { when: ['schlafen', 'geschlafen'], look_for: ['schlaf', 'tracker'] },
  { when: ['stimmung', 'gefühl', 'gefühle', 'stress'], look_for: ['mentale', 'tagebuch'] },

  // --- people / messaging ---------------------------------------------------
  { when: ['schreiben', 'nachricht', 'nachrichten', 'chatten'], look_for: ['chat', 'unterhaltung', 'nachrichten'] },
  { when: ['freunde', 'leute', 'mitglieder', 'kontakte'], look_for: ['mitglieder', 'community', 'partner'] },

  // --- money ----------------------------------------------------------------
  { when: ['geld', 'guthaben', 'bezahlen', 'zahlung'], look_for: ['wallet', 'transaktion', 'zahlungen'] },

  // --- time -----------------------------------------------------------------
  { when: ['termin', 'termine', 'verabredung'], look_for: ['kalender', 'event', 'veranstaltung'] },
];

/** Reverse index built once at module load: user word -> catalog words. */
const INDEX: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const { when, look_for } of EXPANSIONS) {
    for (const w of when) {
      const existing = m.get(w);
      if (existing) {
        // A user word can belong to more than one concept; union rather than
        // overwrite, so adding a concept can never silently delete coverage
        // an earlier one provided.
        for (const t of look_for) if (!existing.includes(t)) existing.push(t);
      } else {
        m.set(w, [...look_for]);
      }
    }
  }
  return m;
})();

/**
 * Catalog words to also look for, given the user's literal query tokens.
 *
 * Returns only NEW words — anything the user already said is excluded, so a
 * literal token is never also scored at the reduced expansion weight (which
 * would make saying the right word *cost* you points relative to not saying it).
 */
export function expandQueryTokens(tokens: readonly string[]): string[] {
  const literal = new Set(tokens);
  const out = new Set<string>();
  for (const tok of tokens) {
    const extra = INDEX.get(tok);
    if (!extra) continue;
    for (const t of extra) if (!literal.has(t)) out.add(t);
  }
  return [...out];
}

/** Test/diagnostic surface: how many user words the lexicon knows. */
export function expansionLexiconSize(): number {
  return INDEX.size;
}
