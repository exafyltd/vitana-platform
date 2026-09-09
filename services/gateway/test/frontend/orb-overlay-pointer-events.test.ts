/**
 * VTID-03808 — the ORB overlay must stay clickable while a modal dialog is
 * open behind it.
 *
 * Reported: "I cannot close the Orb when Vitana is teaching, providing
 * guided-topic content. It should be enabled!" — and pressing the X did
 * NOTHING AT ALL: no close, no audio stop, no error.
 *
 * The mechanism, and why there was nothing to debug in _hide():
 *
 *   GuidedJourneyCatalog.handleTopicClick / handleSessionClick do
 *     activateOrb(topic.topicId);   // this overlay -> document.body
 *     setOpenTopic(topic);          // vaul <Drawer>, modal by DEFAULT
 *
 *   so a modal drawer is open BEHIND the ORB for the whole lesson. vaul's
 *   modal mode uses react-remove-scroll, which injects
 *     .block-interactivity-<id> { pointer-events: none; }  -> document.body
 *     .allow-interactivity-<id> { pointer-events: all;  }  -> the drawer only
 *   This root is appended to document.body, OUTSIDE the drawer's portal, so it
 *   inherits `none` and the browser swallows every tap before any listener
 *   runs. _hide() was never reached; the handler was never the problem.
 *
 * `pointer-events` is inherited but a descendant may opt back in — the same
 * escape Radix's own dialog overlay uses (`pointerEvents: "auto"`).
 *
 * Static source checks — the widget is a plain IIFE with no export surface.
 * The behavioural proof (a real browser, real hit-testing via
 * document.elementFromPoint) is in outputs/pointer-events-hit-test.txt; jsdom
 * does not implement pointer-events hit-testing, so it cannot be asserted here.
 */
import * as fs from 'fs';
import * as path from 'path';

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);
const source = fs.readFileSync(WIDGET_PATH, 'utf8');

/** The overlay root's inline style declaration. */
function overlayRootStyle(): string {
  const marker = '_root.style.cssText = ';
  const idx = source.indexOf(marker);
  expect(idx).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n', idx);
  return source.slice(idx, end);
}

describe('VTID-03808 ORB overlay survives a modal dialog behind it', () => {
  it('declares pointer-events:auto on the overlay root', () => {
    expect(overlayRootStyle()).toMatch(/pointer-events:auto;/);
  });

  it('declares it on the ROOT, not on an inner element', () => {
    // Re-enabling deeper down would leave the backdrop dead and make only
    // some taps land — the root is the one element that covers the viewport.
    const style = overlayRootStyle();
    expect(style).toMatch(/position:fixed/);
    expect(style).toMatch(/z-index:9500/);
    expect(style).toMatch(/pointer-events:auto/);
  });

  it('keeps the close button wired unconditionally — it was never disabled', () => {
    // Pinning this so a future reader does not "fix" a recurrence by adding a
    // guard here: the handler was always correct, the element was unreachable.
    expect(source).toMatch(/closeBtn\.addEventListener\('click', _hide\);/);
    expect(source).not.toMatch(/closeBtn\.disabled/);
  });

  it('does not gate the overlay on any guided-topic state', () => {
    // The overlay must be closeable during teaching exactly as at any other
    // time. If a future change makes interactivity conditional, this fails.
    const style = overlayRootStyle();
    expect(style).not.toMatch(/guidedTopic/);
    expect(style).not.toMatch(/pointer-events:none/);
  });
});
