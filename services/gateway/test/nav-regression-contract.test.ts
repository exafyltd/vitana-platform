/**
 * Navigation Route Integrity — regression / contract suite.
 *
 * Encodes the design doc's PERMANENT regression cases and a subset of the
 * required contrastive pairs, run against the REAL synchronous scorer
 * (searchCatalog) over the static catalog. No DB / network — deterministic.
 *
 * This is the measurable backbone the design calls for: each case asserts the
 * top-ranked screen for a phrasing, in EN and DE, and the family-separation
 * cases assert the wrong family never wins. Entity-resolution and continuation
 * cases (named-person, "Yes, show me") are intentionally NOT here — they need
 * the orchestrator/entity registry from later phases and are tracked as TODO.
 */
process.env.NODE_ENV = 'test';

import { searchCatalog } from '../src/lib/navigation-catalog';

type Lang = 'en' | 'de';
interface Case {
  name: string;
  lang: Lang;
  utterance: string;
  /** Top result must be one of these screen_ids. */
  expectOneOf: string[];
  /** Top result must NOT be any of these (wrong-family guard). */
  expectNotOneOf?: string[];
}

const CASES: Case[] = [
  // ── My Journey ─────────────────────────────────────────────────────────
  { name: 'my journey (EN)', lang: 'en', utterance: 'Open my journey', expectOneOf: ['AUTOPILOT.MY_JOURNEY'], expectNotOneOf: ['LIFE_COMPASS.OVERLAY', 'PROFILE.ME', 'HEALTH.VITANA_INDEX'] },
  { name: 'my journey (DE)', lang: 'de', utterance: 'Öffne meine Journey', expectOneOf: ['AUTOPILOT.MY_JOURNEY'], expectNotOneOf: ['LIFE_COMPASS.OVERLAY', 'PROFILE.ME'] },
  // ── Life Compass ───────────────────────────────────────────────────────
  { name: 'life compass (EN)', lang: 'en', utterance: 'Open my Life Compass', expectOneOf: ['LIFE_COMPASS.OVERLAY'], expectNotOneOf: ['HEALTH.VITANA_INDEX', 'OVERLAY.VITANA_INDEX'] },
  { name: 'life compass (DE)', lang: 'de', utterance: 'Öffne meinen Life Compass', expectOneOf: ['LIFE_COMPASS.OVERLAY'] },
  // ── Vitana Index (must NOT degrade to Life Compass) ──────────────────────
  { name: 'vitana index (EN)', lang: 'en', utterance: 'Open my Vitana Index', expectOneOf: ['HEALTH.VITANA_INDEX', 'OVERLAY.VITANA_INDEX'], expectNotOneOf: ['LIFE_COMPASS.OVERLAY'] },
  { name: 'vitana index (DE)', lang: 'de', utterance: 'Öffne meinen Vitana Index', expectOneOf: ['HEALTH.VITANA_INDEX', 'OVERLAY.VITANA_INDEX'], expectNotOneOf: ['LIFE_COMPASS.OVERLAY'] },
  // ── Community events (collection, never a profile) ───────────────────────
  { name: 'community events (EN)', lang: 'en', utterance: 'Show me community events', expectOneOf: ['COMM.EVENTS', 'COMM.EVENTS_UPCOMING', 'COMM.EVENTS_HOT', 'COMM.EVENTS_TODAY'], expectNotOneOf: ['PROFILE.PUBLIC', 'PROFILE.ME', 'DISCOVER.PROVIDER_PROFILE'] },
  { name: 'community events (DE)', lang: 'de', utterance: 'Zeig mir Community-Events', expectOneOf: ['COMM.EVENTS', 'COMM.EVENTS_UPCOMING', 'COMM.EVENTS_HOT', 'COMM.EVENTS_TODAY'], expectNotOneOf: ['PROFILE.PUBLIC', 'PROFILE.ME'] },
];

function topScreen(utterance: string, lang: Lang): { screen_id: string; score: number } | null {
  const ranked = searchCatalog(utterance, lang);
  const top = ranked[0];
  return top ? { screen_id: top.entry.screen_id, score: top.score } : null;
}

describe('Navigation Route Integrity — regression/contract suite (scorer)', () => {
  // Emit a human-readable report regardless of pass/fail so CI logs show the
  // full baseline picture.
  const report: string[] = [];
  afterAll(() => {
    // eslint-disable-next-line no-console
    console.log('\n=== NAV REGRESSION REPORT (scorer baseline) ===\n' + report.join('\n') + '\n');
  });

  for (const c of CASES) {
    it(`${c.name}: "${c.utterance}"`, () => {
      const top = topScreen(c.utterance, c.lang);
      const got = top?.screen_id ?? '(none)';
      const okExpect = !!top && c.expectOneOf.includes(top.screen_id);
      const okNot = !top || !c.expectNotOneOf || !c.expectNotOneOf.includes(top.screen_id);
      report.push(`${okExpect && okNot ? 'PASS' : 'FAIL'}  ${c.name.padEnd(22)} got=${got} (score ${top?.score ?? '-'}) expect∈[${c.expectOneOf.join('|')}]`);
      expect({ case: c.name, top: got }).toEqual({ case: c.name, top: expect.stringMatching(new RegExp(`^(${c.expectOneOf.join('|').replace(/\./g, '\\.')})$`)) });
      if (c.expectNotOneOf && top) expect(c.expectNotOneOf).not.toContain(top.screen_id);
    });
  }
});
