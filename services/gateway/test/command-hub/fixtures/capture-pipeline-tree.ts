/**
 * VTID-05069: screenshots of the Operator run card for the three mock states, from
 * the server's own views of the fixture sources rendered by the real pipeline-tree.js.
 * Local evidence only (no network, no staging, no production).
 *
 *   PLAYWRIGHT=/opt/node22/lib/node_modules/playwright npx tsx test/command-hub/fixtures/capture-pipeline-tree.ts <out-dir>
 *
 * Writes desktop-s{1,2,3}.png (1400x900) and mobile-s{1,2,3}.png (390x844) and fails
 * when a page scrolls horizontally at 390 px.
 */
import * as path from 'path';
import { buildRunViewWith, resetRunViewCaches } from '../../../src/services/operator-runs/run-view';
import { fixtureDeps, STATE_RUNNING, STATE_FIXING, STATE_GATE2, THREAD, T0 } from '../../fixtures/operator-runs-fixtures';

async function main(): Promise<void> {
  const out = path.resolve(process.argv[2] || 'outputs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
  const views: Record<string, unknown> = {};
  for (const [k, s] of [['1', STATE_RUNNING], ['2', STATE_FIXING], ['3', STATE_GATE2]] as const) {
    resetRunViewCaches();
    const r = await buildRunViewWith(fixtureDeps(s), s.vtid, { threadId: THREAD });
    if (!r.ok) throw new Error('view');
    views[k] = r.view;
  }
  const now = T0 + 6 * 60_000 + 12_000;
  const page = path.join(__dirname, 'pipeline-tree-harness.html');
  const browser = await chromium.launch();
  const problems: string[] = [];
  for (const [name, viewport] of [['desktop', { width: 1400, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    const ctx = await browser.newContext({ viewport, timezoneId: 'UTC' });
    await ctx.addInitScript(`window.__PT_VIEWS__ = ${JSON.stringify(views)}; window.__PT_NOW__ = ${now};`);
    const p = await ctx.newPage();
    for (const k of ['1', '2', '3']) {
      await p.goto(`file://${page}?state=${k}`);
      await p.waitForSelector('.pt-run');
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) problems.push(`${name} state ${k}: horizontal overflow ${overflow}px`);
      await p.screenshot({ path: path.join(out, `${name}-s${k}.png`), fullPage: name === 'mobile' || k !== '1' ? true : false });
      console.log(`${name}-s${k}.png overflow=${overflow}`);
    }
    await ctx.close();
  }
  await browser.close();
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
