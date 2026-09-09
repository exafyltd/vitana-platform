// VTID-03808 — real-browser proof. Reproduces react-remove-scroll's modal lock
// (the exact CSS vaul injects) and asks the browser, via real hit-testing,
// whether the ORB close button is reachable — before and after the fix.
import { chromium } from 'playwright';

const page = await (await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })).newPage();

const build = (overlayPointerEvents) => `
  <style>
    /* verbatim shape of react-remove-scroll's injected rules */
    .block-interactivity-1 { pointer-events: none; }
    .allow-interactivity-1 { pointer-events: all; }
  </style>
  <body class="block-interactivity-1">
    <div id="drawer" class="allow-interactivity-1">vaul drawer (modal)</div>
    <div id="orb" style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:9500;
         display:flex;align-items:center;justify-content:center;${overlayPointerEvents}">
      <button id="close" style="width:56px;height:56px;">X</button>
    </div>
  </body>`;

async function probe(label, css) {
  await page.setContent(build(css));
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
const before = await probe('BEFORE (no pointer-events on overlay root — shipped behaviour):', '');
const after  = await probe('AFTER  (pointer-events:auto on overlay root — the fix):', 'pointer-events:auto;');

console.log('VERDICT');
console.log('  reproduces the report (X unreachable before) :', before.closeHandlerRan === false);
console.log('  fix makes the X reachable (handler runs)     :', after.closeHandlerRan === true);
process.exit(before.closeHandlerRan === false && after.closeHandlerRan === true ? 0 : 1);
