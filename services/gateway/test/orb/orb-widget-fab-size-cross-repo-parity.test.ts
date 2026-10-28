/**
 * BOOTSTRAP-ORB-WIDGET-CONSISTENCY-AUDIT — cross-repo literal-mirroring guard.
 *
 * Investigated a live worry: "check the code if you are creating chaos by
 * just changing preview desktop, but missing to change preview device."
 * The architecture answer is reassuring — `orb-widget.js` is served by the
 * gateway and loaded via a single `<script src="%VITE_GATEWAY_BASE%/
 * command-hub/orb-widget.js">` tag in exafyltd/vitana-v1's index.html, so
 * desktop/mobile/staging/prod/Command Hub all execute byte-identical widget
 * code fetched at page load — there is no separate per-surface copy to
 * "miss." Confirmed via the existing full-duplex-session-gate.widget-parity
 * test (DUPLEX_GATE mirrored into this same orb-widget.js + orb-voice-
 * bench.js, guarded there).
 *
 * The one real, still-open drift class found during that audit: this file's
 * FAB base sizes (64px desktop, 56px under a 600px breakpoint) are silently
 * duplicated as `WIDGET_BASE_DESKTOP`/`WIDGET_BASE_MOBILE` constants in
 * exafyltd/vitana-v1's `src/pages/IntroExperience.orb-placement.test.ts`,
 * with no test on EITHER side that would catch the two drifting apart —
 * unlike DUPLEX_GATE, which has exactly that guard. Today's values match
 * (verified by hand); nothing stopped a future edit here from silently
 * invalidating that assumption in the other repo.
 *
 * A single automated test cannot span two separate git repositories/CI
 * runners the way full-duplex-session-gate.widget-parity.test.ts spans two
 * files in ONE repo — there is no shared checkout to read across. So this
 * pins the values FROM THIS SIDE and says explicitly, in the failure
 * message, what has to change in vitana-v1 if this ever legitimately moves
 * — the same "read the source, assert the numbers, fail loudly" remedy this
 * codebase has already reached for twice (VTID-03644's language-map drift,
 * VTID-03696's workflow paths: drift), applied to the one direction that
 * actually is checkable.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WIDGET_PATH = join(__dirname, '../../src/frontend/command-hub/orb-widget.js');
const widget = readFileSync(WIDGET_PATH, 'utf8');

const CROSS_REPO_POINTER =
  'exafyltd/vitana-v1: src/pages/IntroExperience.orb-placement.test.ts ' +
  '(WIDGET_BASE_DESKTOP / WIDGET_BASE_MOBILE) must be updated to match.';

describe('BOOTSTRAP-ORB-WIDGET-CONSISTENCY-AUDIT — FAB size literals vitana-v1 depends on', () => {
  it(`desktop FAB is 64px — if this changes, update ${CROSS_REPO_POINTER}`, () => {
    expect(widget).toContain('width: 64px; height: 64px; border-radius: 50%; border: none; cursor: pointer;');
  });

  it(`the sub-600px breakpoint sets the FAB to 56px — if this changes, update ${CROSS_REPO_POINTER}`, () => {
    const mqIndex = widget.indexOf('@media (max-width: 600px)');
    expect(mqIndex).toBeGreaterThan(-1);
    const mqBlock = widget.slice(mqIndex, mqIndex + 300);
    expect(mqBlock).toContain('.vtorb-fab { width: 56px; height: 56px;');
  });

  it(`the mobile breakpoint itself is 600px — if this changes, update ${CROSS_REPO_POINTER}`, () => {
    expect(widget).toContain('@media (max-width: 600px)');
  });
});
