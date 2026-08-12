/**
 * VTID-03595 reproduction — real production catalog rows, real scorer.
 *
 * Prod session live-8ca8d4b0 (2026-08-09), German, authenticated:
 *   "wo ich meine Schritte eintragen kann"        -> decision: unknown,   0 alternatives
 *   "Zeig mir, wo ich meine Schritte eintragen kann" -> decision: ambiguous,
 *      candidates = Erinnerungen / Vitana-Index-Sheet / Meine Reise
 *
 * None of those is where you log activity. HEALTH.TRACKER is — its own
 * when_to_visit says "ein Gesundheitsverhalten loggen, Wasser/Schlaf/Bewegung
 * verfolgen". It is in the catalog, on the right platform, with the right role.
 * It simply never reaches the candidate list.
 *
 * The rows below are copied verbatim from production `nav_catalog` +
 * `nav_catalog_i18n` (lang='de', platform='mobile', is_active).
 */
import { searchCatalogEntries } from '../../src/lib/nav-catalog-db';
import type { NavCatalogEntry } from '../../src/lib/nav-catalog-db';
import { expandQueryTokens, expansionLexiconSize } from '../../src/lib/nav-query-expansion';

function entry(o: Record<string, unknown>): NavCatalogEntry {
  return {
    screen_id: o.screen_id,
    route: o.route,
    category: o.category,
    access: 'authenticated',
    anonymous_safe: false,
    priority: o.priority ?? 0,
    role: 'community',
    is_active: true,
    platform: 'mobile',
    i18n: {
      de: {
        title: o.title,
        description: o.description,
        when_to_visit: o.when_to_visit,
      },
    },
  } as unknown as NavCatalogEntry;
}

const PROD_ROWS: NavCatalogEntry[] = [
  entry({
    screen_id: 'HEALTH.TRACKER',
    route: '/health',
    category: 'health',
    title: 'Gesundheits-Tracker',
    description: 'Verfolge dein tägliches Gesundheitsverhalten und Vitana-Index-Bewegungen.',
    when_to_visit:
      'Wenn der Nutzer den Gesundheits-Tracker öffnen, ein Gesundheitsverhalten loggen, Wasser/Schlaf/Bewegung verfolgen oder den heutigen Tracker sehen möchte.',
  }),
  entry({
    screen_id: 'REMINDERS.OVERVIEW',
    route: '/reminders',
    category: 'inbox',
    title: 'Erinnerungen',
    description:
      'Deine geplanten Erinnerungen — die vollständige Liste, mit Steuerung zum Hinzufügen, Bearbeiten und Verwerfen.',
    when_to_visit:
      'Wenn der Nutzer nach der Erinnerungsliste, allen Erinnerungen, "zeig mir meine Erinnerungen" fragt oder geplante Erinnerungen verwalten möchte.',
  }),
  entry({
    screen_id: 'HEALTH.VITANA_INDEX',
    route: '/health/vitana-index',
    category: 'health',
    priority: 2,
    title: 'Vitana Index',
    description:
      'Dein Vitana-Index-Score — die 5-Säulen-Longevity-Kennzahl (Ernährung, Hydration, Bewegung, Schlaf, Mentale).',
    when_to_visit:
      'Wenn der Nutzer nach seinem Vitana Index, seinem Longevity-Score, seinem Gesundheitsscore, den 5 Säulen oder dem Gesundheitstrend fragt.',
  }),
  entry({
    screen_id: 'AUTOPILOT.MY_JOURNEY',
    route: '/autopilot',
    category: 'autopilot',
    title: 'Meine Reise',
    description:
      'Dein Autopilot-Dashboard — die 90-Tage-Reise, die für dich vorbereitet wurde: Wellen, Meilensteine und empfohlene Aktionen, abgestimmt auf deinen Kalender.',
    when_to_visit:
      'Wenn der Nutzer meine Reise öffnen, meine Reise sehen, die Autopilot-Reise, meine 90-Tage-Reise, den 90-Tage-Plan, das Autopilot-Dashboard, meinen Plan, oder was heute auf seiner Reise ansteht, anfragt. Das sind die Schritt-für-Schritt-Gespräche INNERHALB seiner eigenen 90-Tage-Reise.',
  }),
  entry({
    screen_id: 'MEMORY.DIARY',
    route: '/memory/diary',
    category: 'memory',
    title: 'Tagesbuch',
    description:
      'Deine täglichen Tagebucheinträge — halte Gedanken, Stimmungen und Reflexionen fest.',
    when_to_visit:
      'Wenn der Nutzer einen Tagebucheintrag schreiben, festhalten wie er sich fühlt, seinen Tag journaling oder sein Tagebuch öffnen möchte.',
  }),
];

const OPTS = { role: 'community', anonymous_only: false } as const;

const scoreOf = (results: Array<{ entry: NavCatalogEntry; score: number }>, id: string) =>
  results.find(r => (r.entry as { screen_id: string }).screen_id === id)?.score ?? 0;

describe('VTID-03595 — user vocabulary now reaches catalog vocabulary', () => {
  test('the reported query surfaces the RIGHT screen, not Erinnerungen/Reise', () => {
    const results = searchCatalogEntries(PROD_ROWS, 'wo ich meine Schritte eintragen kann', 'de', OPTS);

    // The bug: HEALTH.TRACKER scored 0 and was dropped entirely, because
    // `score > 0` is the admission test. Anything the lexical scorer drops is
    // invisible to every later stage — so the consult had nothing correct to
    // choose from and guessed.
    expect(scoreOf(results, 'HEALTH.TRACKER')).toBeGreaterThan(0);
    expect((results[0].entry as { screen_id: string }).screen_id).toBe('HEALTH.TRACKER');
  });

  test('"Zeig mir, wo ..." — the retry the user actually made — resolves the same way', () => {
    const results = searchCatalogEntries(
      PROD_ROWS,
      'Zeig mir, wo ich meine Schritte eintragen kann',
      'de',
      OPTS,
    );
    expect((results[0].entry as { screen_id: string }).screen_id).toBe('HEALTH.TRACKER');
  });

  test('a singular query still works — the fix must not trade one form for the other', () => {
    const results = searchCatalogEntries(PROD_ROWS, 'Gesundheits-Tracker öffnen', 'de', OPTS);
    expect((results[0].entry as { screen_id: string }).screen_id).toBe('HEALTH.TRACKER');
  });

  test('an unrelated query is not dragged to HEALTH.TRACKER by looser matching', () => {
    const results = searchCatalogEntries(PROD_ROWS, 'zeig mir meine Erinnerungen', 'de', OPTS);
    expect((results[0].entry as { screen_id: string }).screen_id).toBe('REMINDERS.OVERVIEW');
  });

  test('"meine Reise" still wins its own query — no regression from stemming', () => {
    const results = searchCatalogEntries(PROD_ROWS, 'öffne meine Reise', 'de', OPTS);
    expect((results[0].entry as { screen_id: string }).screen_id).toBe('AUTOPILOT.MY_JOURNEY');
  });
});

describe('VTID-03595 — expansion weighting and hygiene', () => {
  test('a literal match outranks an inferred one', () => {
    // "Tracker" is HEALTH.TRACKER's literal title word. "Schritte" only reaches
    // it by inference. The literal question must score strictly higher, or a
    // screen full of inferred synonyms could beat the screen the user named.
    const literal = searchCatalogEntries(PROD_ROWS, 'Tracker', 'de', OPTS);
    const inferred = searchCatalogEntries(PROD_ROWS, 'Schritte', 'de', OPTS);
    expect(scoreOf(literal, 'HEALTH.TRACKER')).toBeGreaterThan(
      scoreOf(inferred, 'HEALTH.TRACKER'),
    );
  });

  test('expansion never re-scores a word the user already said', () => {
    // 'schritte' expands to include 'tracker'. Saying BOTH must not award
    // 'tracker' twice — once literally and again at expansion weight.
    expect(expandQueryTokens(['schritte', 'tracker'])).not.toContain('tracker');
    expect(expandQueryTokens(['schritte'])).toContain('tracker');
  });

  test('an unknown word expands to nothing (no accidental catch-all)', () => {
    expect(expandQueryTokens(['zzzquux'])).toEqual([]);
  });

  test('a user word belonging to two concepts keeps both — union, not overwrite', () => {
    // 'wasser' is a hydration word; the lexicon must not lose coverage when a
    // later concept mentions the same user word.
    expect(expandQueryTokens(['wasser']).length).toBeGreaterThan(0);
  });

  test('the lexicon is non-empty and stays small enough to review by hand', () => {
    expect(expansionLexiconSize()).toBeGreaterThan(20);
    expect(expansionLexiconSize()).toBeLessThan(120);
  });
});
