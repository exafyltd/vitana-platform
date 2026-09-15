// VTID-03808 — real-browser proof. Reproduces react-remove-scroll's modal lock
// (the exact CSS vaul injects) and asks the browser, via real hit-testing,
// whether the ORB close button is reachable — before and after the fix.
//
// The AFTER case reproduces the SHIPPED form of the fix: `pointer-events: auto`
// in the injected `.vtorb-overlay` stylesheet rule, matching the overlay root
// by class — NOT an inline style on the element. The two are equivalent for
// this defect (what is blocked is INHERITANCE from document.body, not a
// specificity contest on this element), but the probe should exercise what
// actually deploys. The declaration lives in the stylesheet because the repo's
// CSP gate rejects new inline-style manipulation on the browser-served surface.
import { chromium } from 'playwright';

const page = await (await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })).newPage();

const build = (overlayRule) => `
  <style>
    /* verbatim shape of react-remove-scroll's injected rules */
    .block-interactivity-1 { pointer-events: none; }
    .allow-interactivity-1 { pointer-events: all; }

    /* the widget's own injected stylesheet, as _injectStyles() writes it */
    .vtorb-overlay {
      position: fixed; inset: 0; z-index: 9500;
      display: flex; align-items: center; justify-content: center;
      ${overlayRule}
    }
  </style>
  <body class="block-interactivity-1">
    <div id="drawer" class="allow-interactivity-1">vaul drawer (modal)</div>
    <div id="orb" class="vtorb-overlay">
      <button id="close" style="width:56px;height:56px;">X</button>
    </div>
  </body>`;

async function probe(label, overlayRule) {
  await page.setContent(build(overlayRule));
  const r = await page.evaluate(() => {
    const btn = document.getElementById('close');
    const b = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    let clicked = false;
    btn.addEventListener('click', () => { clicked = true; });
    hit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return {
      effective: getComputedStyle(btn).pointerEvents,
      hitTarget: hit ? (hit.id || hit.tagName) : null,
      closeHandlerRan: clicked,
    };
  });
  console.log(`${label}\n  computed pointer-events on X : ${r.effective}\n  element at the X's centre    : ${r.hitTarget}\n  close handler actually ran   : ${r.closeHandlerRan}\n`);
  return r;
}

console.log('=== VTID-03808: is the ORB close button reachable behind a modal drawer? ===\n');
const before = await probe('BEFORE (.vtorb-overlay declares no pointer-events — shipped behaviour):', '');
const after  = await probe('AFTER  (.vtorb-overlay { pointer-events: auto } — the fix, as shipped):', 'pointer-events: auto;');

console.log('VERDICT');
console.log('  reproduces the report (X unreachable before) :', before.closeHandlerRan === false);
console.log('  fix makes the X reachable (handler runs)     :', after.closeHandlerRan === true);
process.exit(before.closeHandlerRan === false && after.closeHandlerRan === true ? 0 : 1);
