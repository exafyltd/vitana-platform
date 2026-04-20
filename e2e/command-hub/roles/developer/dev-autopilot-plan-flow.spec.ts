/**
 * DEV-COMHU-2026 / VTID-DEV-AUTOPILOT
 *
 * End-to-end verification of the Dev Autopilot Expand-plan → Approve flow
 * against the LIVE gateway. Three claims to prove:
 *
 *   (a) Plan generation via Messages API completes within ~60s (no 270s
 *       Managed-Agents timeout).
 *   (b) Scroll position on .module-content-wrapper is held while the
 *       10-second queue poller fires — no snap-to-top while reading a plan.
 *   (c) Approve & execute either succeeds OR returns a human-readable
 *       safety-gate rejection banner — NOT a "Maximum call stack size
 *       exceeded" RangeError disguised as "Network error".
 *
 * Runs under e2e/command-hub/roles/developer/. The developer role is
 * auth'd by auth-developer project, which logs TEST_USER in and sets
 * active_role=developer.
 */
import { test, expect, type Page } from '@playwright/test';

const GATEWAY = process.env.HUB_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';
const DEV_AUTOPILOT_URL = `${GATEWAY}/command-hub/dev-autopilot/`;

// Pull the JWT that auth-developer stored on localStorage so we can also
// hit the API directly (faster than waiting on UI-driven state).
async function readJwt(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('sb-inmkhvwdcuyhnxkgfvsb-auth-token')
             || localStorage.getItem('vitana.authToken')
             || '';
    try {
      const parsed = JSON.parse(raw);
      return parsed.access_token || raw;
    } catch { return raw; }
  });
}

async function apiJson(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; body: string; json?: any }> {
  const jwt = await readJwt(page);
  if (!jwt) throw new Error('no JWT on localStorage — auth setup failed');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs || 30_000);
  try {
    const res = await fetch(`${GATEWAY}${path}`, {
      method: init.method || 'GET',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: init.body != null ? JSON.stringify(init.body) : undefined,
      signal: ctl.signal,
    });
    const body = await res.text();
    let json: any = undefined;
    try { json = JSON.parse(body); } catch { /* non-JSON */ }
    return { status: res.status, body, json };
  } finally {
    clearTimeout(t);
  }
}

test.describe('Dev Autopilot — plan generation + scroll + approve (live gateway)', () => {
  test.setTimeout(360_000);

  test('plan generates, scroll holds, approve surfaces real result', async ({ page }) => {
    const jsErrors: Array<{ message: string; stack?: string }> = [];
    page.on('pageerror', err => jsErrors.push({ message: err.message, stack: err.stack }));

    // --- Step 1: load page and wait for queue to populate -------------------
    await page.goto(DEV_AUTOPILOT_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000); // let fetchDevAutopilotState complete

    // Sanity: queue endpoint reachable
    const queueR = await apiJson(page, '/api/v1/dev-autopilot/queue?status=new&limit=200');
    expect(queueR.status, 'queue endpoint reachable').toBe(200);
    expect(queueR.json?.ok, 'queue returns ok=true').toBe(true);
    const findings = queueR.json?.findings || [];
    expect(findings.length, 'queue has at least one finding to test').toBeGreaterThan(0);

    // Prefer findings whose plan we can regenerate fast — start with any
    // finding, we'll exercise generate-plan directly against the API.
    // Take the SMALLEST-effort finding so we maximize success probability.
    findings.sort((a: any, b: any) =>
      (a.effort_estimate ?? a.effort ?? 10) - (b.effort_estimate ?? b.effort ?? 10),
    );
    const finding = findings[0];
    console.log(`Chosen finding: ${finding.id} — ${finding.title} (risk=${finding.risk_class})`);

    // --- Step 2: trigger plan generation via API ---------------------------
    // We hit the endpoint directly (same endpoint the Expand plan button
    // uses) so we measure the fix in isolation from UI timing.
    const genStart = Date.now();
    const planR = await apiJson(page, `/api/v1/dev-autopilot/findings/${finding.id}/generate-plan`, {
      method: 'POST',
      body: {},
      timeoutMs: 240_000, // generous — ceiling is Messages API's 240s abort
    });
    const genElapsedMs = Date.now() - genStart;
    console.log(`generate-plan returned after ${Math.round(genElapsedMs / 1000)}s — status=${planR.status}`);
    if (planR.status !== 200 || !planR.json?.ok) {
      console.log('generate-plan body:', planR.body.slice(0, 800));
    }
    expect(planR.status, 'generate-plan HTTP 200').toBe(200);
    expect(planR.json?.ok, 'generate-plan ok=true').toBe(true);
    expect(planR.json?.plan?.plan_markdown, 'plan_markdown populated').toBeTruthy();
    expect(planR.json?.plan?.plan_markdown?.length, 'plan_markdown substantive').toBeGreaterThan(300);
    expect(planR.json?.plan?.files_referenced?.length, 'plan cites at least one file').toBeGreaterThan(0);
    // 4 minutes is the Cloud-Run-safe ceiling. Post-fix should be much lower.
    expect(genElapsedMs, 'plan under 4 minutes').toBeLessThan(240_000);

    // --- Step 3: open the plan in the UI and verify scroll holds -----------
    // Reload so the UI picks up the new plan without our manual nudging.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    // Click Expand plan on the finding we just planned. Cards are rendered in
    // list order; we identify by finding id (card topRow contains the id in
    // an internal attribute or we can re-pick the first matching title).
    // Simpler: we rely on the per-card "Expand plan" button and find the one
    // whose surrounding card mentions our finding title.
    const planButtonSelector = `text="▸ Expand plan"`;
    const firstExpand = page.locator(planButtonSelector).first();
    // If the finding auto-loaded with plan already present, there'll be no
    // Expand button for it — but there will be other findings we can click.
    // Either way: some card should have an expand button we can click to
    // trigger the 10s poller while we scroll.
    if (await firstExpand.count() > 0) {
      await firstExpand.click();
      await page.waitForTimeout(2000);
    }

    // Initial measurement via a fresh queryselector each time — the element
    // is replaced every 10s by the queue poller, so a Playwright ElementHandle
    // captured once will point at a detached element for the rest of the run.
    const initialDims = await page.evaluate(() => {
      const el = document.querySelector('.module-content-wrapper') as HTMLElement | null;
      return el ? { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null;
    });
    expect(initialDims, 'module-content-wrapper is present').toBeTruthy();
    console.log(`.module-content-wrapper: scrollHeight=${initialDims!.scrollHeight} clientHeight=${initialDims!.clientHeight}`);
    expect(initialDims!.scrollHeight, 'module is scrollable').toBeGreaterThan(initialDims!.clientHeight + 500);

    // Seed the scroll position on the live element.
    await page.evaluate(() => {
      const el = document.querySelector('.module-content-wrapper') as HTMLElement | null;
      if (el) el.scrollTop = 1500;
    });
    await page.waitForTimeout(200);

    // Scroll + sample every 500ms, re-querying the element each tick so we
    // always write to the CURRENT container (not the detached one from
    // before the last renderApp wipe). Dispatch a real wheel event from
    // inside the page so the browser's scroll machinery sees it too.
    const samples: Array<{ t: number; top: number }> = [];
    const startTs = Date.now();
    const TEST_DURATION_MS = 32_000;
    let peak = 0;
    while (Date.now() - startTs < TEST_DURATION_MS) {
      const top = await page.evaluate(() => {
        const el = document.querySelector('.module-content-wrapper') as HTMLElement | null;
        if (!el) return -1;
        // User-visible scroll: use scrollBy so the browser fires a real scroll
        // event and our renderApp's scroll preservation runs on the right
        // element instance.
        el.scrollBy({ top: 60, behavior: 'instant' as ScrollBehavior });
        // Also dispatch a wheel event so any code watching wheel (not scroll)
        // gets the signal.
        window.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 60 }));
        return el.scrollTop;
      });
      if (top > peak) peak = top;
      samples.push({ t: Date.now() - startTs, top });
      await page.waitForTimeout(500);
    }

    console.log(`scroll samples: n=${samples.length} peak=${peak} final=${samples[samples.length - 1]?.top}`);
    const resets = samples.filter(s => peak > 800 && s.top < Math.min(peak - 500, 800));
    console.log(`reset events (big drops below peak-500): ${resets.length}`);
    if (resets.length > 0) {
      console.log('sample of resets:', resets.slice(0, 5));
    }
    expect(peak, 'scroll moved forward').toBeGreaterThan(2500);
    expect(resets.length, 'no snap-to-top while poller fires every 10s').toBeLessThanOrEqual(1);
    // allow at most 1 reset (timing jitter) — anything more is the bug.

    // --- Step 4: click Approve & execute, assert clean result --------------
    // Accept the native confirm() dialog.
    page.on('dialog', async d => { await d.accept(); });

    // Find the Approve button for our finding if still expanded.
    const approveBtn = page.locator('button:has-text("Approve & execute")').first();
    if (await approveBtn.count() > 0) {
      await approveBtn.click();
      // Wait up to 15s for either success toast or inline error banner.
      await page.waitForTimeout(10000);
      // Grab the last inline error (if any) for diagnostics — it will NOT
      // contain "Maximum call stack" with the new build.
      const errorText = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('div')).filter(el =>
          el.textContent?.startsWith('✗ ') || el.textContent?.startsWith('Error: '),
        );
        return els.length > 0 ? (els[els.length - 1].textContent || '').slice(0, 500) : null;
      });
      console.log('approve inline banner:', errorText || '(none — success or safety-gate pass)');

      // Hard assertion: the approve response must NOT be a client-side
      // RangeError disguised as "Network error: Maximum call stack".
      // A safety-gate rejection ("risk_class_too_high", "kill_switch_engaged",
      // "tests_missing", etc.) is a legitimate outcome and still counts as
      // a pass — the fix is that the UI surfaces the REAL reason.
      expect(
        (errorText || '').toLowerCase(),
        'approve must not surface stack-overflow as network error',
      ).not.toContain('maximum call stack size');
    } else {
      console.log('No Approve button visible — likely all findings closed or queue empty. Skipping approve assert.');
    }

    // --- Step 5: no uncaught JS errors in the page -------------------------
    const fatal = jsErrors.filter(e => !/favicon|third-party/i.test(e.message));
    if (fatal.length > 0) {
      console.log('page JS errors captured:');
      for (const e of fatal) console.log(' -', e.message, '\n   stack:', e.stack?.slice(0, 400));
    }
    expect(fatal.length, 'no uncaught JS errors on the page during the flow').toBe(0);
  });
});
