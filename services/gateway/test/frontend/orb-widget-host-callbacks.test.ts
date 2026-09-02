/**
 * VTID-03799 — every host callback the widget READS must be wired from
 * `opts` in `init()`.
 *
 * Why this suite exists, found live rather than by testing:
 *
 * `vitana-v1`'s `useOrbVoiceWidget.ts` passes `onGuidedTopicTeachingEnd`
 * inside `navOpts` to `orb.init(navOpts)` — it dispatches the
 * `vitana:guided-topic-teaching-complete` event that `GuidedJourneyCatalog`
 * listens for to open the Well Done drawer and credit the step. `init()`
 * never copied it into `_cfg`, so `_cfg.onGuidedTopicTeachingEnd` was
 * permanently `undefined` and BOTH fire sites were dead:
 *
 *   - VTID-03762/03763's teaching-end signal (model tool call / backstop)
 *   - VTID-03799's own close-after-delivery crediting
 *
 * So "no Well Done drawer" had a second, independent cause underneath the
 * replay loop, and every unit test in this directory passed the whole time.
 * That is the point: the widget is a plain IIFE with no export surface, so
 * its suites are STATIC SOURCE CHECKS — they can assert that a fire site
 * exists, and are structurally incapable of noticing that nothing ever
 * populates the thing it fires. A per-key assertion would have the same
 * blind spot for the next callback, so this guard is written as a DIFF:
 * read every `_cfg.onX` the widget consumes, read every `opts.onX` that
 * `init()` assigns, and require the first set to be covered by the second.
 *
 * Confirmed against the DEPLOYED bundle before fixing, not just this source
 * (`preview-aws-gateway.vitanaland.com/command-hub/orb-widget.js`).
 */
import * as fs from 'fs';
import * as path from 'path';

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);
const source = fs.readFileSync(WIDGET_PATH, 'utf8');

function uniq(matches: RegExpMatchArray | null, strip: string): string[] {
  return [...new Set((matches ?? []).map((m) => m.replace(strip, '')))].sort();
}

const read = uniq(source.match(/_cfg\.on[A-Za-z]+/g), '_cfg.');
const assigned = uniq(source.match(/opts\.on[A-Za-z]+/g), 'opts.');

describe('VTID-03799 host callbacks are wired from init(opts) into _cfg', () => {
  it('every callback the widget reads is assignable from opts', () => {
    const dropped = read.filter((k) => !assigned.includes(k));
    // A dropped callback is invisible at runtime: the host passes a function,
    // the widget silently ignores it, and the feature is simply dead.
    expect(dropped).toEqual([]);
  });

  it('wires the three that were dropped, by name', () => {
    // Named explicitly so the fix cannot be reverted while the diff above
    // still passes for some unrelated reason.
    expect(source).toMatch(/if \(typeof opts\.onGuidedTopicTeachingEnd === 'function'\) _cfg\.onGuidedTopicTeachingEnd = opts\.onGuidedTopicTeachingEnd;/);
    expect(source).toMatch(/if \(typeof opts\.onTeachingSessionEnd === 'function'\) _cfg\.onTeachingSessionEnd = opts\.onTeachingSessionEnd;/);
    expect(source).toMatch(/if \(typeof opts\.onTurnComplete === 'function'\) _cfg\.onTurnComplete = opts\.onTurnComplete;/);
  });

  it('still reads onGuidedTopicTeachingEnd at both fire sites', () => {
    // The teaching-end signal (VTID-03762/03763) and the close-after-delivery
    // crediting (VTID-03799). Wiring init() is only half of the path.
    const fireSites = source.match(/_cfg\.onGuidedTopicTeachingEnd\(/g) || [];
    expect(fireSites.length).toBe(2);
    expect(source).toMatch(/_cfg\.onGuidedTopicTeachingEnd\(_completedTopicId, 'overlay_closed_after_delivery'\)/);
  });

  it('guards each assignment on typeof === function, so a non-function opt cannot poison _cfg', () => {
    for (const key of ['onGuidedTopicTeachingEnd', 'onTeachingSessionEnd', 'onTurnComplete']) {
      const bare = new RegExp(`_cfg\\.${key} = opts\\.${key};`);
      const guarded = new RegExp(`if \\(typeof opts\\.${key} === 'function'\\) _cfg\\.${key} = opts\\.${key};`);
      expect(source).toMatch(guarded);
      // no unguarded copy anywhere
      const all = source.match(new RegExp(`[^)] _cfg\\.${key} = opts\\.${key};`, 'g')) || [];
      expect(all.filter((s) => !bare.test(s.trim()) === false && !/typeof/.test(s)).length).toBe(0);
    }
  });

  it('the host (vitana-v1) really does pass onGuidedTopicTeachingEnd — this is not a hypothetical', () => {
    // Documented here because the wiring only matters because a host uses it.
    // vitana-v1/src/hooks/useOrbVoiceWidget.ts declares it in navOpts and
    // calls orb.init(navOpts). Kept as a comment-level fact rather than a
    // cross-repo file read, which this suite cannot do.
    expect(read).toContain('onGuidedTopicTeachingEnd');
  });
});
