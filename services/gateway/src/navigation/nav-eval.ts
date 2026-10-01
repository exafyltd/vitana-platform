/**
 * VTID-04517 — leave-one-out evaluation of a registry index.
 *
 * Every phrasing in the registry is a question someone could ask. Hold each
 * one out, resolve it against everything else, and check the screen it was
 * written for comes back. Needs no extra embedding calls — the phrasings'
 * own vectors are already in the index — so it runs in unit tests on the
 * bundled data and on a live gateway against the registry it serves.
 *
 * This is the regression contract for "we added a screen": a new screen
 * whose phrasings cannot be told apart from an existing screen's fails here.
 */
import { pageOf } from './nav-registry';
import { decide, NavIndex, rankScreens } from './nav-resolver';

/** Share of a screen's held-out phrasings that must rank it in the top five. */
export const MIN_SCREEN_TOP5 = 0.6;

export interface ScreenEvalRow {
  screen_id: string;
  phrasings: number;
  top1: number;
  top5: number;
  /** Held-out phrasings confidently resolved to another page. */
  confident_wrong_page: number;
}

export interface RegistryEval {
  signature: string;
  phrasings: number;
  top1: number;
  top5: number;
  confident: number;
  confident_wrong_page: number;
  by_lang: Record<string, { phrasings: number; top1: number; top5: number; confident_wrong_page: number }>;
  screens: ScreenEvalRow[];
  /** Screens below MIN_SCREEN_TOP5 — each one is a registry fix to make. */
  weak_screens: string[];
  /** Up to 50 confident wrong-page resolutions, for the report. */
  wrong_page_examples: Array<{ lang: string; text: string; screen_id: string; resolved_to: string }>;
}

export function evaluateRegistryIndex(index: NavIndex): RegistryEval {
  const ctx = { authenticated: true };
  const rows = new Map<string, ScreenEvalRow>();
  const byLang: RegistryEval['by_lang'] = {};
  const examples: RegistryEval['wrong_page_examples'] = [];
  let top1 = 0, top5 = 0, confident = 0, wrongPage = 0, n = 0;
  const page = (id: string) => pageOf(index.screens.get(id)!.route);

  // Evaluation assumes a signed-in member on any device: every voice screen is reachable.
  const phrasings = index.docs.filter((d) => d.kind === 'phrasing');
  // About 5,000 queries over 7,600 rows: ~35 s of arithmetic on a CI runner.
  phrasings.forEach((d) => {
    n++;
    const ranked = rankScreens(index, d.vec, { ...ctx, ignoreText: d.text });
    const r = decide(index, ranked, ctx);
    const pos = ranked.findIndex(([id]) => id === d.screenId);
    const row = rows.get(d.screenId) || { screen_id: d.screenId, phrasings: 0, top1: 0, top5: 0, confident_wrong_page: 0 };
    const lang = (byLang[d.lang] ||= { phrasings: 0, top1: 0, top5: 0, confident_wrong_page: 0 });
    row.phrasings++; lang.phrasings++;
    if (pos === 0) { row.top1++; lang.top1++; top1++; }
    if (pos >= 0 && pos < 5) { row.top5++; lang.top5++; top5++; }
    if (r.kind === 'match') {
      confident++;
      if (page(r.screen.screen_id) !== page(d.screenId)) {
        row.confident_wrong_page++; lang.confident_wrong_page++; wrongPage++;
        if (examples.length < 50) examples.push({ lang: d.lang, text: d.text, screen_id: d.screenId, resolved_to: r.screen.screen_id });
      }
    }
    rows.set(d.screenId, row);
  });
  const screens = [...rows.values()].sort((a, b) => a.top5 / a.phrasings - b.top5 / b.phrasings);
  return {
    signature: index.signature,
    phrasings: n,
    top1,
    top5,
    confident,
    confident_wrong_page: wrongPage,
    by_lang: byLang,
    screens,
    weak_screens: screens.filter((s) => s.top5 / s.phrasings < MIN_SCREEN_TOP5).map((s) => s.screen_id),
    wrong_page_examples: examples,
  };
}
