# Sparring round 3 — escalated

Session: `eeb01b78-c4df-41bb-ada3-6e3da60094c1` · plan hash `7409f05696376d5faff1fdbfe4e5afd13ec9f1bd0bfd5d8d5fceb8997a73fb86`

## Summary

The revised plan has cleanly resolved R2-F1 (single-owner screen-manifest.json) and R2-F2 (/shop non-manifest scope), and added an explicit per-lane zero-assertion that addresses R1-F1's "ratchet != done" gap. However, the plan's new justification for the 5 "action-in-progress" spinners (Decision 3) is factually wrong about the code: at least RedeemVoucher, CreatorOnboarded, and TicketPurchaseSuccess show spinners gated on data-loading flags (isLoading/voucherLoading/loading), not on a user-triggered action. This re-opens R1-F3 at higher severity: the plan marks these routes "migrated" while leaving them non-compliant with SR-20 and relying on a design-allow-next-line whose stated reason ("action in progress, not a data-load spinner") is false for the actual code paths.

## Findings

### R3-F1 [major]

Decision 3 recharacterises the 5 kept spinners as 'action-in-progress' (a submit/redeem/delete is running, 'not data-load spinners', so SR-20 does not apply). The actual code contradicts this: RedeemVoucher's Loader2 spinner is gated on authLoading || voucherLoading, a data fetch; CreatorOnboarded's animate-spin is gated on isLoading || isRefetching (a creator-status fetch) and ALREADY renders ArchetypeSkeleton in the Spotlight branch, so its residual spinner is on the legacy/flag-off path, not an action-spinner; TicketPurchaseSuccess's Loader2 is gated on loading || verifying, where 'loading' is useTicketPurchase's data fetch. These are data-load spinners — precisely what SR-20/'no-page-spinner' forbids (the rule flags 'Loader2' or 'animate-spin' on any /src/pages/** file that is not inside a Button). The plan's rationale for keeping them while marking the routes 'migrated' is therefore unsupported by the code, and the design-allow-next-line reason it will apply is false for the actual report sites.

- `exafyltd/vitana-v1:src/pages/RedeemVoucher.tsx:76` — if (authLoading || voucherLoading) { ... <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto mb-4" />
- `exafyltd/vitana-v1:src/pages/CreatorOnboarded.tsx:123` — {(isLoading || isRefetching) && ( ... <div className="w-16 h-16 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
- `exafyltd/vitana-v1:src/pages/CreatorOnboarded.tsx:40` — const loadingStatus = isLoading || isRefetching; ... {loadingStatus ? ( <ArchetypeSkeleton archetype="form" /> )
- `exafyltd/vitana-v1:src/pages/TicketPurchaseSuccess.tsx:64` — if (loading || verifying) { ... <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto" />
- `exafyltd/vitana-v1:eslint-rules/design/no-page-spinner.js:31` — if ((jsxName(node) === 'Loader2' || hasSpinClass(node)) && !insideButton(node)) { reportUnlessAllowed(...)

Suggestion: Re-derive the actual spinner classification from the code, not the plan's assertion. For each of the 5 kept spinners, determine whether the reported site is gated on a data fetch (isLoading/voucherLoading/loading/refetching) or genuinely on a user action (claimMutation.isPending, verifyPayment completing a write). Data-load-gated spinners must become ArchetypeSkeleton/VCardSkeleton to be 'migrated', or the route must be left legacy. Only genuinely action-gated spinners may keep a design-allow-next-line whose reason matches the code. If the plan intends these to reach baseline 0 while migrated, at minimum the RedeemVoucher loading branch and TicketPurchaseSuccess loading branch and the CreatorOnboarded data-load path need skeleton conversion in the Spotlight branch, not an allow comment.

### R1-F3 [major]

RE-RAISED: The core contradiction R1-F3 raised — migrated screens keeping a page spinner — is now justified by a claim that is false in the code. no-page-spinner flags any Loader2/animate-spin on a page file (isPageFile = /src/pages/**) that is not inside a Button, regardless of why it spins. So a migrated route that still renders a data-load spinner remains non-compliant with SR-20 and must carry a permanent design-allow-next-line, which means the 'every non-chrome entry at 0' done-criterion is met only via the allow-comment suppression (ALLOW_RX), not by actually satisfying SR-20. The plan asserts the allow reason is legitimate ('action in progress'), but for RedeemVoucher/CreatorOnboarded/TicketPurchaseSuccess the reason is factually a data-load spinner.

- `exafyltd/vitana-v1:eslint-rules/design/_shared.js:84` — export const isPageFile = (f) => /\/src\/pages\//.test(f) && !/\.test\.[jt]sx?$/.test(f);
- `exafyltd/vitana-v1:eslint-rules/design/_shared.js:35` — if (c) { const reason = ALLOW_RX.exec(c.value)?.[1]; if (reason && reason.trim()) return; ...
- `exafyltd/vitana-v1:src/pages/RedeemVoucher.tsx:76` — if (authLoading || voucherLoading) { ... <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto mb-4" />

Suggestion: Resolve the migrated-vs-spinner contradiction honestly: either (a) convert the data-load-gated spinner sites in these pages to skeletons in the Spotlight branch (making the routes genuinely SR-20 compliant and migrated), keeping only truly action-gated spinners with an accurate allow reason, or (b) leave the routes 'legacy' until their data-load spinners are gone. Do not mark a route 'migrated' while a data-load spinner remains suppressed only by design-allow-next-line.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Addressed by the new 'per-lane zero assertion' step: each lane greps its own files out of the regenerated baseline/design.json and asserts each is absent/0, with the reviewer recording the result rather than relying on the repo-wide ratchet total.
- R1-F2: acknowledged — Resolved: DeleteAccount/RedeemVoucher/TicketPurchaseSuccess are owned solely by remaining-screens, with LiveRoomViewer/CreatorOnboarded in skeletons.
- R1-F3: disputed — The plan's new 'action-spinner' justification is contradicted by the code (RedeemVoucher/CreatorOnboarded/TicketPurchaseSuccess spinners are data-load gated). See R3-F1 and re-raised R1-F3.
- R1-F4: acknowledged — Consolidated into the action-spinner/data-spinner classification now under R1-F3/R3-F1.
- R2-F1: acknowledged — Addressed: screen-manifest.json + generator + test declared single-owner (remaining-screens), public-profile frames routes in code only, remaining-screens depends_on the framing lanes.
- R2-F2: acknowledged — Addressed: /shop manifest flip dropped; only the code-level commerce-shell change remains, owned by commerce-shell lane.
