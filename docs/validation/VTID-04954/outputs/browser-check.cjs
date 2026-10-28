const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs'), path = require('path');
const DIR = '/home/user/vitana-platform/services/gateway/src/frontend/command-hub';
const OUT = process.argv[2];
const ORG = { id: 'org-1', display_name: 'Exafy ltd', legal_name: 'EXAFY LTD', partner_type: 'service_provider', country: 'AE', website: 'https://www.exafy.io/', vat_id: null, lifecycle_state: 'needs_action', trust_level: 0, created_at: '2026-10-02T12:49:00Z' };
const steps = ['account','company','verification','catalogue','mapping','terms'].map((k) => ({ key: k, required: true, status: ['verification'].includes(k) ? 'todo' : 'done' })).concat([{ key: 'tracking_test', required: false, status: 'not_required' }, { key: 'billing_mandate', required: false, status: 'not_required' }, { key: 'team', required: false, status: 'todo' }]);
const products = Array.from({ length: 6 }, (_, i) => ({ id: 'p-' + i, title: 'Offering ' + (i + 1), kind: 'service', price_cents: 15000, currency: 'EUR', listing: i === 0 ? 'kept_offline' : 'waiting_for_go_live', admin_listing: i === 0 ? { reason: 'Controlled test record' } : null }));
const events = Array.from({ length: 15 }, (_, i) => ({ created_at: '2026-10-07T13:3' + (i % 10) + ':00Z', topic: 'partner_org.lifecycle_changed', message: 'event ' + i }));
(async () => {
  const browser = await chromium.launch();
  const results = [];
  for (const [name, vp] of [['desktop', { width: 1400, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    for (const mode of ['signed-in', 'expired', 'missing']) {
      const ctx = await browser.newContext({ viewport: vp });
      const page = await ctx.newPage();
      let approveCalls = 0;
      await page.route('**/*', async (route) => {
        const u = new URL(route.request().url());
        if (u.pathname === '/command-hub/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>hub</body></html>' });
        if (u.pathname.startsWith('/command-hub/')) {
          const f = path.join(DIR, u.pathname.replace('/command-hub/', ''));
          const type = f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : 'text/html';
          return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(f) });
        }
        if (u.pathname.startsWith('/api/v1/admin/partner-review')) {
          if (mode === 'expired') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'UNAUTHENTICATED' }) });
          if (route.request().method() === 'POST') { approveCalls++; await new Promise((r) => setTimeout(r, 600)); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, lifecycle_state: 'needs_action', open_steps: [] }) }); }
          if (u.pathname.endsWith('/org-1')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, organization: ORG, checklist: { steps }, verification: null, products, terms_acceptances: [{ terms_version: '2026-10', shown_locale: 'en', accepted_at: '2026-10-06T15:05:17Z' }], events }) });
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, organizations: [{ ...ORG, product_count: 6, open_steps: ['verification'] }] }) });
        }
        return route.abort();
      });
      await page.goto('http://hub.local/command-hub/');
      if (mode !== 'missing') await page.evaluate(() => localStorage.setItem('vitana.authToken', 'local-test-token'));
      await page.goto('http://hub.local/command-hub/partner-review.html');
      await page.waitForTimeout(400);
      const r = { name, mode };
      if (mode === 'signed-in') {
        await page.click('.pr-card');
        await page.waitForSelector('.pr-btn-approve');
        r.scrollable = await page.evaluate(() => document.scrollingElement.scrollHeight > window.innerHeight);
        await page.keyboard.press('End');
        await page.waitForTimeout(300);
        r.scrolledY = await page.evaluate(() => window.scrollY);
        r.approveInView = await page.evaluate(() => { const b = document.querySelector('.pr-btn-approve').getBoundingClientRect(); return b.top >= 0 && b.bottom <= window.innerHeight; });
        await page.screenshot({ path: `${OUT}/${name}-scrolled.png` });
        page.on('dialog', (d) => d.accept());
        await page.click('.pr-btn-approve');
        r.disabledDuring = await page.evaluate(() => Array.from(document.querySelectorAll('#pr-detail button')).every((b) => b.disabled));
        await page.click('.pr-btn-approve', { force: true, timeout: 500 }).catch(() => {});
        await page.waitForTimeout(1200);
        r.approveCalls = approveCalls;
        r.status = await page.textContent('#pr-status');
        r.statusInView = await page.evaluate(() => { const b = document.querySelector('#pr-status').getBoundingClientRect(); return b.height > 0 && b.top >= -1 && b.bottom <= window.innerHeight; });
        await page.screenshot({ path: `${OUT}/${name}-after-approve.png` });
      } else {
        r.list = (await page.textContent('#pr-list')).trim();
        r.link = await page.getAttribute('#pr-list a', 'href');
        await page.screenshot({ path: `${OUT}/${name}-${mode}.png` });
      }
      results.push(r);
      await ctx.close();
    }
  }
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
})();
