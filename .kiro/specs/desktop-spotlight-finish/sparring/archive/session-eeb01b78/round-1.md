# Sparring round 1 — in_progress

Session: `eeb01b78-c4df-41bb-ada3-6e3da60094c1` · plan hash `8f6e0e36b9a149237005f7381f5b7daedaf7bd8e5d227b7a61c8fe6646bbd366`

## Summary

The plan is thorough and its central premises (enforce:false, error-level design rules, BASE-commit ratchet baseline, page-only spinner rule, skeleton primitives existing) all verify against the pinned vitana-v1 ref. The main risks are internal contradictions in the plan's own counts/ownership and a structural gap: the automated ratchet can only prove "no increase", never the plan's actual done-criterion ("every non-chrome entry at 0"), so the terminal state is enforced purely by human reviewer diligence. Three lane-ownership/count contradictions (skeleton counts; DeleteAccount/RedeemVoucher/TicketPurchaseSuccess touched by two lanes; spinner-vs-archetype conflict on routes that decision 4 flips to form/detail) must be reconciled before lanes get VTIDs.

## Findings

### R1-F1 [major]

The ratchet (`ratchet-design`) can only prove "no file gained design violations", never the plan's stated done-criterion "every non-chrome entry of design.json at 0". A lane could merge with its own files still carrying residual design errors (just not higher than the BASE baseline) and the `✅ design ratchet` line would still print — `gate.mjs:122` literally appends "(N legacy in M file(s))". The per-lane commitment in Decision 6 ("clears every design/* rule") has no machine check; the only consumer is a human reviewer reading a PR-GATE summary that PR-GATE itself does not fail (enforce:false).

- `exafyltd/vitana-v1:scripts/ci/pr-gate/gate.mjs:119` — if (!r.ok) {...done(false, '❌ **design ratchet**...')} done(true, `✅ **design ratchet** (baseline: ${source}) — no file gained design violations (${total} legacy in ${Object.keys(current).length} file(s))${better}`);
- `exafyltd/vitana-v1:scripts/ci/pr-gate/config.json:1` — "enforce": false,

Suggestion: Add an explicit, machine-checkable done gate for each lane: assert (e.g. in the lane's PR body or a script) that every file the lane owns reaches 0 in its own `baseline-design` output, not merely that the ratchet passed. Alternatively require the reviewer to confirm the "(N legacy…)" count shows 0 for the lane's assigned files, and encode that as the recorded done-condition.

### R1-F2 [major]

The `skeletons` lane keeps action spinners on `DeleteAccount`, `RedeemVoucher`, `TicketPurchaseSuccess` (Decision 3), while the `remaining-screens` lane also claims `redeem, tickets, delete-account ... tickets/voucher components` (Decision 4 + lane table). This is a two-lane ownership of the same page files, contradicting Decision 6's hard rule "every file with findings belongs to exactly one lane ... no two PRs edit one file", and creates a merge/ratchet conflict risk on `scripts/ci/pr-gate/baseline/design.json` for those shared files.

- `exafyltd/vitana-v1:src/design/screen-manifest.json:1` — "screens": [ { "path": "/", ... "status": "migrated" ... } ]

Suggestion: Reconcile ownership: either move the spinner-keeping for those three pages into `remaining-screens` (which also changes their archetype/status), or make `skeletons` depend on / be last for those pages. Ensure exactly one lane owns each of `DeleteAccount`, `RedeemVoucher`, `TicketPurchaseSuccess` so the baseline-design diff for those files lands in a single PR.

### R1-F3 [major]

Decision 4 flips `/delete-account` → `form`, `/tickets/success` and `/tickets/demo` → `detail`, and `/redeem` → `form` (i.e. these routes become `migrated` with a real archetype). But Decision 3 keeps a `Loader2`/`animate-spin` page spinner on `DeleteAccount`, `RedeemVoucher`, `TicketPurchaseSuccess`. `no-page-spinner` (via `isPageFile` = `/src/pages/**`) will keep flagging those pages, so they must carry a permanent `design-allow-next-line` even after being marked `migrated`. A migrated screen showing a spinner while loading contradicts SR-20 (skeleton in the shape of the archetype), so the plan both marks these screens done and leaves them non-compliant.

- `exafyltd/vitana-v1:eslint-rules/design/no-page-spinner.js:26` — create(context) { if (!isPageFile(filenameOf(context))) return {}; return { JSXElement(node) { if ((jsxName(node) === 'Loader2' || hasSpinClass(node)) && !insideButton(node)) { reportUnlessAllowed(...)
- `exafyltd/vitana-v1:eslint-rules/design/_shared.js:84` — export const isPageFile = (f) => /\/src\/pages\//.test(f) && !/\.test\.[jt]sx?$/.test(f);
- `exafyltd/vitana-v1:eslint-rules/design/_shared.js:10` — export const ALLOW_RX = /design-allow-next-line(?:\s*(\S.*))?/;

Suggestion: Clarify whether these three pages are "action-in-progress" spinners (kept with allow reasons and NOT counted as migrated/done) or data-loading pages that must show ArchetypeSkeleton. If they are meant to reach the done state, they cannot keep a page spinner; if they keep a spinner, exclude them explicitly from the "every non-chrome entry at 0" goal and reconcile with the `migrated` status.

### R1-F4 [minor]

The plan's spinner counts are internally inconsistent and unexplained: Measured state says `design/no-page-spinner` has 27 findings in 24 page files; Decision 3 says "22 data-loading page spinners become skeletons" plus "5 action spinners kept"; the lane table says the `skeletons` lane covers "20 spinner pages (21 → skeletons, 2 action spinners kept)". 24 files ≠ 22+5=27 findings, and the lane cell's own arithmetic (21 vs 2 kept, and "20 spinner pages") does not match either Decision 3 or the measured state.

- `exafyltd/vitana-v1:eslint-rules/design/no-page-spinner.js:26` — create(context) { if (!isPageFile(filenameOf(context))) return {}; return { JSXElement(node) { if ((jsxName(node) === 'Loader2' || hasSpinClass(node)) && !insideButton(node)) { reportUnlessAllowed(...)

Suggestion: Reconcile the exact count of page files / spinner findings (24 files vs 27 findings vs 22 vs 20 vs 5) and state the final file ownership list for the `skeletons` lane explicitly, so the self-check "0 files outside every lane" is actually auditable.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
