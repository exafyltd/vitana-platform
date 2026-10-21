# Sparring round 3 — escalated

Session: `80ec8512-302f-4261-8134-3f8a34b0cc3b` · plan hash `7773a0dfccb89e5e58594404609b66761d8c72a1aae06a90f25a4d22ef91b506`

## Summary

Both R2-F1 and R2-F2 are properly incorporated in the revised plan text: no re-export PRs for matchReason/post-attachment, and feed hooks explicitly excluded from core. One new major finding (R3-F1) is introduced by the revised plan's attempt to fix R1-F2: it now incorrectly claims the three `/home/*` deep-link paths carry "no dedicated parity row" and are "covered under HOME.OVERVIEW" by parity-ledger.mjs --check. The committed ledger contradicts this on both counts. The correct home-lane row count is 9, not 6; the community-hub count is 16, not 19.

## Findings

### R3-F1 [major]

The revised plan incorrectly states that `/home/compose`, `/home/comments`, `/home/notif` 'carry no dedicated parity row' and are 'covered under HOME.OVERVIEW' by `parity-ledger.mjs --check`. In fact each has its own dedicated ledger row (source: 'exclusion', scope: 'in', lane: 'home-feed', status: 'not_started'). Additionally, the `check()` function uses exact `shapeOf()` matching, not prefix matching, so `/home/compose` is never matched to `/home`. As a result the plan's home-lane partition of 6 rows is wrong (should be 9: 4 HOME.* screens + 2 overlays + 3 `/home/*` exclusion routes) and the community-hub partition of 19 is wrong (should be 16). An implementer following the plan will create native route files for all three paths (correctly) but will not flip those three rows from `not_started` to `native`, leaving the parity ledger reporting the home lane as incomplete. The CI gate (`parity-ledger.mjs --check`) will not catch this: check (d) passes because the shapes `/home/compose`, `/home/comments`, `/home/notif` are already in `rowShapes` via the exclusion rows, and check (c) is not triggered because the rows stay `not_started` (only fires when status is `native` or `in_progress` but no file exists). The ledger silently shows 3 home-lane rows permanently stuck at `not_started` while their native files exist.

- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:2585` — {
        "key": "/home/comments",
        "web_path": "/home/comments",
        "kind": "route",
        "source": "exclusion",
        "scope": "in",
        "lane": "home-feed",
        "status": "not_started"
      },
      {
        "key": "/home/compose",
        "web_path": "/home/compose",
        "kind": "route",
        "source": "exclusion",
        "scope": "in",
        "lane": "home-feed",
        "status": "not_started"
      },
      {
        "key": "/home/notif",
        "web_path": "/home/notif",
        "kind": "route",
        "source": "exclusion",
        "scope": "in",
        "lane": "home-feed",
        "status": "not_started"
      }
- `exafyltd/vitana-v1:scripts/native/parity-ledger.mjs:234` — const nativeShapes = new Set(native.map((n) => shapeOf(n.route)));
    for (const r of rows) {
      if (!STATUSES.includes(r.status)) fail('e', ...);
      if ((r.status === 'native' || r.status === 'in_progress') && !nativeShapes.has(shapeOf(r.web_path))) {
        fail('c', ...);
      }
    ...
    for (const n of native) {
      const s = shapeOf(n.route);
      if (!rowShapes.has(s) && !nativeOnly.has(s)) fail('d', ...);
    }
- `exafyltd/vitana-v1:scripts/native/parity-ledger.mjs:60` — export function shapeOf(path) {
  const p = stripQuery(path).replace(/\/+$/, '') || '/';
  return p.replace(/:[^/]+/g, ':');
}
- `exafyltd/vitana-v1:src/navigation/registry/exclusions.json:138` — {
        "path": "/home/compose",
        "reason": "Push-notification deep link into the Home feed composer."
      },
      {
        "path": "/home/comments",
        "reason": "Announcement-card deep link into the Home feed comments sheet."
      },
      {
        "path": "/home/notif",
        "reason": "Push-notification deep link rendering the Home feed."
      }
- `exafyltd/vitana-v1:scripts/native/parity-ledger.mjs:84` — const excludedPaths = new Set(exclusions.paths.map((p) => p.path));
    for (const p of exclusions.paths) add({ key: p.path, web_path: p.path, kind: 'route', source: 'exclusion' });
- `exafyltd/vitana-v1:scripts/native/parity-scope.json:59` — "/home/compose": { "scope": "in", "reason": "Push deep link into the Home composer." },
      "/home/comments": { "scope": "in", "reason": "Deep link into the Home comments sheet." },
      "/home/notif": { "scope": "in", "reason": "Push deep link rendering the Home feed." }

Suggestion: Correct Decision 1 and the lane table: the home lane has 9 status-flippable parity rows — 4 HOME.* screen rows, 2 overlay rows (LIFE_COMPASS.OVERLAY, OVERLAY.MASTER_ACTION), and the 3 exclusion route rows `/home/compose`, `/home/comments`, `/home/notif`. The community-hub lane has 16 rows (27 − 9 − 2), not 19. Remove the claim 'they carry no dedicated parity row'. Replace 'parity-ledger.mjs --check covers them under HOME.OVERVIEW' with the accurate description: the three exclusion rows already exist in the ledger with scope=in, lane=home-feed; the implementer must flip all three rows to `native` (alongside the 6 registry rows) when their native route files are created. The '6+2+19=27' partition must read '9+2+16=27'.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — The revised plan correctly drops the re-export PRs for matchReason and post-attachment. Decision 2 now explicitly states 'matchReason and post-attachment get no core PR (type alias covers them)' and explains the BFS/class-B risk. The fix is complete and accurate.
- R2-F2: acknowledged — The revised plan correctly removes 'feed-hook modules' from the core extraction scope. Decision 2 now explicitly states the hooks are NOT moved into core and the home lane re-implements fetching natively. The fix is complete and accurate.
