# Sparring round 2 — in_progress

Session: `eeb01b78-c4df-41bb-ada3-6e3da60094c1` · plan hash `074659c76bcb08563d38e2701cd54ac032dc67e64cf14da6535eb16722c37497`

## Summary

Round 2. All four round-1 findings were ACCEPTED, and their fixes are largely reflected in the revised plan. I verified the central technical claim behind R1-F3's fix — that a `design-allow-next-line` reason suppresses the ESLint report and therefore is not counted by `countDesign` — and it holds (`_shared.js:35-44` returns without reporting; `lib.mjs:112-121` counts only reported severity-2 `design/*` messages). The per-lane zero-assertion in the revised Test plan is a real machine-checkable gate and addresses R1-F1. Two new/outstanding ownership and no-op issues remain unresolved against the manifest file I read: (1) the manifest `screen-manifest.json` appears to be edited by more than one lane (public-profile for `/u/:identifier`, remaining-screens for `/redeem` etc.), which Decision 6's "no two PRs edit one file" does not list as shared; (2) `/shop` is already `immersive`+`migrated`, so Decision 4's flip is a no-op whose scope needs clarifying.

## Findings

### R2-F1 [major]

Decision 4 flips the archetype/status of `/u/:identifier` and `/me/profile` to `detail` (public profile pages, owned by the `public-profile` lane) while `remaining-screens` owns the manifest generator/test and flips `/redeem`, `/tickets/success`, `/tickets/demo`, `/delete-account`. All of these changes edit the single file `src/design/screen-manifest.json`. Decision 6 lists only the two ratchet baselines and `docs/SCREEN_INVENTORY.md` as shared across lanes and otherwise mandates 'no two PRs edit one file'. The manifest is not listed as shared, so `public-profile` (flipping `/u/:identifier`) and `remaining-screens` (flipping `/redeem`, `/tickets/*`, `/delete-account`) would each edit the same manifest file in separate PRs, recreating the exact two-lane ownership conflict R1-F2 was raised to prevent, now at the manifest level: a status flip race, merge conflict, and un-auditable 'every non-chrome entry at 0' ownership.

- `exafyltd/vitana-v1:src/design/screen-manifest.json:2469` — "path": "/redeem", "archetype": "form", ... "status": "legacy"
- `exafyltd/vitana-v1:src/design/screen-manifest.json:2709` — "path": "/tickets/demo", "archetype": "collection" ... "status": "legacy"
- `exafyltd/vitana-v1:src/design/screen-manifest.json:2725` — "path": "/u/:identifier", "archetype": "detail", ... "status": "legacy"

Suggestion: Make one lane the sole owner of all `src/design/screen-manifest.json` archetype/status edits (e.g. `remaining-screens`, which already depends on public-profile and goes last), and have `public-profile` scope cover only the profile *page/component* code, not the manifest entry. Alternatively, list the manifest as an explicit shared file with a documented ordering so both lanes' manifest diffs cannot collide. Confirm the manifest generator/test ownership in that same single lane.

### R2-F2 [minor]

Decision 4 says `/shop` → `immersive` inside the app shell, but the manifest already records `/shop` as `archetype: "immersive"`, `status: "migrated"`. The flip is a no-op at the manifest level, so either the plan is describing work already done (and should drop the item) or there is a code-level shell change (Commerce portal → app shell) that does not involve the manifest but is lumped under Decision 4 with route flips. As written the `/shop` clause is ambiguous and risks an un-owned/incomplete scope claim.

- `exafyltd/vitana-v1:src/design/screen-manifest.json:2621` — "path": "/shop", "archetype": "immersive", ... "status": "migrated"

Suggestion: Drop the `/shop` manifest flip from Decision 4 (already `immersive`/`migrated`) or restate it as the Commerce-portal app-shell code change only, and assign that code change to the `commerce-shell` lane's explicit scope rather than under the route-flip bullet.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
