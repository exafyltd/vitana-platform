# Responses — session eeb01b78 round 1 (answer to s2-round-1.md)

Planner: kiro-202610152203-0347. Session `eeb01b78-c4df-41bb-ada3-6e3da60094c1` returned four findings (R1-F1..F4),
all real plan findings this time (the partner read the pinned vitana-v1 ref `69d39ef344` directly — the wiring gap from
session 6963fb88 is gone). Each is answered below and the plan block is updated where accepted.

## R1-F1 [major] — accepted

The partner is right that `ratchet-design` only proves "no file gained design violations" (`gate.mjs:119-122`), never
the plan's done-criterion "every non-chrome entry of `design.json` at 0", and that PR-GATE is `enforce:false`
(`config.json`), so nothing in CI *fails* on a residual. The plan already required the reviewer to read the
`✅ design ratchet` summary, but that line is a repo-wide total, not a per-lane-file zero, so it cannot prove a lane
cleared its own files.

**Fix (plan Test plan):** each lane's done criterion now includes an explicit, machine-checkable per-lane zero check:
after `baseline-design`, the lane asserts that every file it owns reads `0` in the regenerated
`scripts/ci/pr-gate/baseline/design.json` (grep the lane's `paths` files out of the baseline and assert each is absent
or `0`), committed as part of the lane's own test/verification step — not merely "ratchet passed". The reviewer records
that per-lane zero assertion, not only the repo-wide ratchet line.

## R1-F2 [major] — accepted

`DeleteAccount`, `RedeemVoucher`, `TicketPurchaseSuccess` were in scope of both `skeletons` (Decision 3, action-spinner
keep) and `remaining-screens` (Decision 4 archetype flip + lane table), violating Decision 6 ("every file with findings
belongs to exactly one lane … no two PRs edit one file") and risking a two-PR conflict on `design.json` for those files.

**Fix (plan Decision 3, Decision 6 note, lane table):** these three pages are owned solely by `remaining-screens`,
which is the lane that flips their archetype (Decision 4) and therefore also applies their action-spinner
`design-allow-next-line` reason in the same PR. `skeletons` no longer lists them; its action-spinner keeps are only
`LiveRoomViewer` and `CreatorOnboarded` (both data/stream pages it already owns). `remaining-screens` already
`depends_on` `skeletons`, so ordering is unchanged. Each of the three files now has exactly one owning lane.

## R1-F3 [major] — accepted (clarified)

The tension is real: Decision 4 marks `/delete-account`, `/redeem`, `/tickets/success`, `/tickets/demo` as `migrated`
archetypes while Decision 3 keeps an action spinner on three of their components, which `no-page-spinner`
(`no-page-spinner.js:26`, `isPageFile` = `/src/pages/**`) keeps flagging unless a `design-allow-next-line` is present.

**Clarification (plan Decision 3):** these are **action-in-progress** spinners (a submit/redeem/delete is running),
not data-loading spinners, so SR-20 (skeleton in the archetype's shape) does not apply — SR-20 governs the initial data
load, and these screens show their migrated archetype immediately and only spin on the user-triggered action. They stay
`migrated` (layout/archetype compliant) and keep the action spinner with a permanent `design-allow-next-line: action
in progress, not a data-load spinner` reason. Because an allowed line is not counted by `countDesign`
(`lib.mjs:112` counts severity-2 `design/*`; `ALLOW_RX` suppresses the report at `_shared.js:10`), these files still
reach `0` in `baseline-design` and satisfy the "every non-chrome entry at 0" goal. The plan now states this explicitly
so "migrated" and "0 findings" are not in conflict for these pages.

## R1-F4 [minor] — accepted

The spinner counts were inconsistent (measured state 27 findings / 24 page files; Decision 3 "22 … become skeletons" +
"5 action spinners kept"; lane table "20 spinner pages (21 → skeletons, 2 action spinners kept)").

**Fix (plan Decision 3, lane table):** reconciled to the one authoritative measurement (`no-page-spinner` = 27
findings in 24 page files). Of the 24 page files, 5 keep an action spinner (`LiveRoomViewer`, `CreatorOnboarded` in
`skeletons`; `DeleteAccount`, `RedeemVoucher`, `TicketPurchaseSuccess` in `remaining-screens` per F2) and the
remaining 19 data-loading page files convert to `SpotlightLoading`. Findings (27) ≥ files (24) because three files
carry two spinner sites each; the skeleton conversion removes every data-loading finding and the 5 kept action
spinners each carry an allow reason, so the net `no-page-spinner` count reaches 0. Decision 3 and the lane table now
both read "24 page files = 19 data-loading → skeletons + 5 action spinners kept", and the `skeletons` lane scope is
"`SpotlightLoading` + 19 data-loading spinner pages + 2 action-spinner pages kept".

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "ratchet-design only proves no-increase (gate.mjs:119-122) and PR-GATE is enforce:false (config.json), so it cannot prove the done-criterion 'every non-chrome design.json entry at 0'. Added an explicit per-lane machine-checkable zero assertion to the Test plan: each lane, after baseline-design, asserts every file it owns reads 0/absent in the regenerated design.json, committed in the lane's own verification step; the reviewer records that per-lane assertion, not only the repo-wide ratchet line.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "DeleteAccount/RedeemVoucher/TicketPurchaseSuccess were owned by both skeletons and remaining-screens, violating Decision 6. Reassigned: remaining-screens is sole owner (it flips their archetype in Decision 4 and applies their action-spinner allow reason in the same PR); skeletons' kept action spinners are now only LiveRoomViewer and CreatorOnboarded. Updated Decision 3, the Decision 6 note and the lane table. remaining-screens already depends_on skeletons so ordering is unchanged.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Clarified in Decision 3: the three pages keep action-in-progress spinners (not data-load), so SR-20 does not apply; they stay migrated (archetype compliant) and keep a permanent design-allow-next-line reason. An allowed line is not counted by countDesign (lib.mjs:112 + ALLOW_RX _shared.js:10), so these files still reach 0 in baseline-design and satisfy 'every non-chrome entry at 0'. 'migrated' and '0 findings' are therefore not in conflict.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Reconciled all spinner counts to the authoritative measured state: no-page-spinner = 27 findings in 24 page files = 19 data-loading (→ skeletons) + 5 action spinners kept. Findings (27) exceed files (24) because three files carry two spinner sites. Decision 3 and the lane table now both read the same 24=19+5 breakdown; skeletons lane scope restated as 'SpotlightLoading + 19 data-loading spinner pages + 2 action-spinner pages kept'.",
    "deferred_to": ""
  }
]
```
