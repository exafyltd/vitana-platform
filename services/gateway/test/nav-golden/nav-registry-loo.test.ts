/**
 * VTID-04517 — every registry phrasing, held out, must lead back to its
 * screen (src/navigation/nav-eval.ts). Runs on the bundled registry snapshot
 * and its stored vectors.
 *
 * Ratchets against baseline.loo.json; regenerate after a legitimate
 * improvement with NAV_GOLDEN_WRITE_BASELINE=1.
 */
import * as fs from 'fs';
import * as path from 'path';
import { evaluateRegistryIndex, MIN_SCREEN_TOP5, RegistryEval } from '../../src/navigation/nav-eval';
import { loadBundledEmbeddings } from '../../src/navigation/nav-embedder';
import { loadSnapshotRegistry } from '../../src/navigation/nav-registry';
import { registryDocTexts } from '../../src/navigation/nav-resolver';
import { GOLDEN_SET } from './golden-set';
import { loadRegistryFixture } from './registry-fixture';

const BASELINE_FILE = path.join(__dirname, 'baseline.loo.json');

describe('VTID-04517 bundled vectors', () => {
  it('has a stored vector for every registry text and golden sentence', () => {
    const stored = loadBundledEmbeddings();
    const texts = [
      ...registryDocTexts(loadSnapshotRegistry()).map((d) => d.text),
      ...GOLDEN_SET.map((g) => g.utterance.trim()),
    ];
    const missing = [...new Set(texts.filter((t) => !stored.has(t)))];
    // Fix: BEDROCK_ROLE_ARN=local npx tsx test/nav-golden/build-embeddings.ts (needs AWS credentials).
    expect(missing.slice(0, 20)).toEqual([]);
  });
});

describe('VTID-04517 registry leave-one-out', () => {
  let ev: RegistryEval;

  beforeAll(async () => {
    ev = evaluateRegistryIndex((await loadRegistryFixture()).index);
    const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`;
    const lines = [
      `phrasings ${ev.phrasings}  top1 ${pct(ev.top1, ev.phrasings)}  top5 ${pct(ev.top5, ev.phrasings)}  confident ${pct(ev.confident, ev.phrasings)}  confident-wrong-page ${ev.confident_wrong_page}`,
      ...Object.entries(ev.by_lang).map(([l, m]) => `  ${l}  top1 ${pct(m.top1, m.phrasings)}  top5 ${pct(m.top5, m.phrasings)}  wrong-page ${m.confident_wrong_page}`),
      'weakest screens (top5 share):',
      ...ev.screens.slice(0, 8).map((s) => `  ${s.screen_id} ${(s.top5 / s.phrasings).toFixed(2)}`),
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    if (process.env.NAV_GOLDEN_WRITE_BASELINE === '1') {
      const { screens: _s, wrong_page_examples: _w, ...numbers } = ev;
      fs.writeFileSync(BASELINE_FILE, JSON.stringify(numbers, null, 2) + '\n');
    }
  }, 300_000);

  it(`finds every screen from its own phrasings (top five for at least ${MIN_SCREEN_TOP5 * 100}% of them)`, () => {
    expect(ev.weak_screens).toEqual([]);
  });

  it('covers every voice-reachable screen', async () => {
    const { index } = await loadRegistryFixture();
    const withDocs = new Set(ev.screens.map((s) => s.screen_id));
    const reachable = [...index.screens.values()].filter((s) => !s.disabled && !s.params?.length && !s.overlay?.param);
    expect(reachable.filter((s) => !withDocs.has(s.id)).map((s) => s.id)).toEqual([]);
  });

  it('does not open a different page more often than the baseline', () => {
    const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    // A rate, not a count: adding phrasings adds queries, so the count of
    // confident wrong-page answers can grow while the share falls.
    expect(ev.confident_wrong_page / ev.phrasings).toBeLessThanOrEqual(base.confident_wrong_page / base.phrasings + 0.0005);
    expect(ev.top5 / ev.phrasings).toBeGreaterThanOrEqual(base.top5 / base.phrasings - 0.005);
  });
});
