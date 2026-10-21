# Sparring round 1 — in_progress

Session: `d1ebba9d-5a1b-4acb-ab2f-de219d1c4ec7` · plan hash `4f2e53aee69edc9611cd108a4c49ae65701f50b17c152174596840fed5e1f89f`

## Summary

The plan concerns only files in `exafyltd/vitana-v1` (apps/mobile/**, packages/core/**, the parity ledger, and all web sources), but this review session is pinned solely to `exafyltd/vitana-platform@84fc0ca6a0d116f4e41dfd77c5125cb329b95f15` with NO `vitana-v1` companion ref. I could not read a single load-bearing artifact the plan depends on: the parity ledger (`apps/mobile/parity/ledger.json`), the 22 web source files, `scripts/native/*`, `packages/core/manifest.json`, or the `App.tsx` routes. The plan's central premises (22 rows / 12+4+6 partition with 0 overlap & orphan; class-A vs class-B helper determination; same-release cross-lane `depends_on: []` on shared generated files) are therefore unverifiable against code in this round. I verified the workflow mechanism (extra_refs / spar_refs) and prior Wave 2 plan and found the tooling that SHOULD have forwarded vitana-v1, but it did not for this session. In addition to that environmental blocker, I raised concrete finding-level concerns about the events-meetups lane (12 rows) carrying public/game exclusion routes across three distinct web files, and the date/de locale-helper premise, none of which I could confirm.

## Findings

### R1-F1 [blocker]

This plan's entire deliverable lives in `exafyltd/vitana-v1` (apps/mobile/**, packages/core/**, apps/mobile/parity/ledger.json, and every web source cited: src/App.tsx, src/pages/community/EventsAndMeetups.tsx, src/components/calendar/vcal/**, etc.), but the review session is pinned only to `exafyltd/vitana-platform@84fc0ca6a0d116f4e41dfd77c5125cb329b95f15` with no vitana-v1 companion ref forwarded. Consequently none of the plan's load-bearing premises can be verified against code, and the plan's own evidence rule ('every finding cites a file it read') is unsatisfiable for the actual subject matter.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:312` — session = await client.create({ plan_text: planText, producer: `ci-plan-spar.${slug}`, change_class: changeClass, base_ref: baseSha, repo, approval_policy: POLICY, ...(extraRefs ? { extra_refs: extraRefs } : {}) })
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:290` — if (!PLAN_SPARRING_REPOS.includes(r)) throw new Usage(`spar_refs: ${r} is not an allowed sparring repo`); ... (extraRefs ??= {})[r] = await resolveRef(r, ref, { token, fetchImpl });
- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:131` — PLAN-SPAR forwards extra_refs: { 'exafyltd/vitana-v1': <sha> } and a session created from this branch ... can read exafyltd/vitana-v1 to verify this plan's apps/mobile/** and web screen premises.

Suggestion: The plan must declare a companion ref (`spar_refs: - exafyltd/vitana-v1: <40-hex-sha>`) in its handoff.md front matter, or the PLAN-SPAR workflow must resolve the always-on `--extra-ref-vitana-v1` arg for this session, so the partner can actually read `vitana-v1` and verify the ledger partition, the class-A/class-B closures, and the web sources. Without that pin, this plan cannot be meaningfully reviewed and should not converge.

### R1-F2 [major]

The `events-meetups` lane (12 rows) bundles three distinct web source pages for the public/game landing exclusion routes — `EventGamePage.tsx` (134 lines), `EventGamePublicLanding.tsx` (162 lines), and `PublicEventLanding.tsx` (514 lines), plus three dialogs — while decision 3 grants lanes 'their own core re-export files' and claims disjoint subtrees, yet decision 4 declares `depends_on: []` for all three lanes even though core-closure regenerates shared-by-line files (packages/core/closure.generated.json, scripts/native/mobile-ci-paths.generated.json, packages/core/manifest.json) that all three lanes commit in the same release, producing guaranteed merge conflicts on main regardless of disjoint source trees.

- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:105` — core-closure.mjs --write and commit the regenerated packages/core/closure.generated.json and scripts/native/mobile-ci-paths.generated.json in the SAME PR ... Without the --write+commit, --check fails in NATIVE-CI with 'stale generated file'
- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:92` — news and community-hub run in parallel; home waits for news (the card twin)

Suggestion: Reconsider the `depends_on: []` claim for any two lanes that both add `@vitana/core` entries (per decision 2, all three lanes extract pure helpers). Because the closure/manifest/mobile-ci-paths generated files are shared-by-line and each lane must commit the regenerated output, three parallel PRs will collide on those three files. Either serialize the lanes that extract core entries (add `depends_on`), or assign the core-extraction ownership to a single lane (as the home-feed-news plan did for its home lane) so the other lanes only consume core and never touch the shared generated files.

### R1-F3 [major]

Decision 7 asserts as a load-bearing premise that the repo has an ESLint rule `i18n/no-raw-locale-call` at ERROR level and that the pure date helpers already route through `fmtTime`/`fmtDate` at `vcal/time.ts:6` and `adapters/liveRoom.ts:8`; these are vitana-v1 files I cannot read at the pinned commit, so the rule's existence, its ERROR severity, and the premise that extracted helpers already satisfy it cannot be confirmed, and a wrong premise here would make every calendar-reminders/events time rendering defect invisible to CI.

- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/requirements.md:10` — Counted with node -e over the committed ledger JSON (the --report command needs typescript, which is not installed in this worktree)

Suggestion: Verify against the actual vitana-v1 sources: (a) confirm the `i18n/no-raw-locale-call` rule is actually ERROR (not warn) and is enabled for `apps/mobile/**`, and (b) read `src/components/calendar/vcal/time.ts` and `src/components/ui/vcard/adapters/liveRoom.ts` at the pinned commit to confirm they already route through the locale-format helpers and contain no raw `toLocaleDateString`/`toLocaleTimeString`/`date-fns format` in any path (including error/empty branches) before treating this as a safety guarantee.

### R1-F4 [minor]

The plan repeatedly cites the prior plan's mechanism for reading vitana-v1 (the 're-spar note' in home-feed-news plan.md) but does not itself declare a `spar_refs` block, so even though the `spar_refs` machinery is implemented in plan-spar.mjs, this plan did not opt in to forward a vitana-v1 pin for the current session — the producer line shows the session was created with only the vitana-platform base ref.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:290` — if (r === repo) throw new Usage(`spar_refs: ${r} is the plan's own repo; it is pinned by --base-sha`); (extraRefs ??= {})[r] = await resolveRef(r, ref, { token, fetchImpl });

Suggestion: Add `spar_refs: - exafyltd/vitana-v1: <40-hex-sha>` to the events-calendar handoff front matter and re-create the sparring session against the pinned vitana-v1 commit, so the partner can actually exercise read_file/list_dir on the app's source. This is the concrete fix for R1-F1.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
