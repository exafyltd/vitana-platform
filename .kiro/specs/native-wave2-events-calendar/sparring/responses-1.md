```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Correct: the session was pinned only to exafyltd/vitana-platform@84fc0ca6 with no vitana-v1 companion ref, so none of the plan's load-bearing premises against apps/mobile/parity/ledger.json, the 22 web source files, scripts/native/*, packages/core/manifest.json or the src/App.tsx routes could be verified. The plan's handoff.md now declares `spar_refs:\n  - exafyltd/vitana-v1: main`, which plan-spar.mjs resolves and forwards as extra_refs (plan-spar.mjs:290,312), so the next round reads vitana-v1@main and verifies the ledger partition, the class-A/class-B closures and the web sources on the merits. This is the recovery path by which the sibling plan native-wave2-home-feed-news converged after PR #4201 fixed PLAN-SPAR.yml to forward the vitana-v1 ref.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "A real concern, partially pre-addressed and now tightened in the coordinator plan. The plan already recognized (Decision 3) that packages/core/manifest.json, packages/core/closure.generated.json and scripts/native/mobile-ci-paths.generated.json are shared-by-line across the three lanes. Edited plan.md Decision 3 to make the handling precise: the two *.generated.json files are produced WHOLESALE by core-closure.mjs, so a second lane does not text-merge them — it rebases on updated main, re-runs `core-closure.mjs --write`, and commits the freshly regenerated output (now containing both lanes' closures); manifest.json is append-only, keep-both. Edited Decision 4 to name the serialized fallback explicitly: if regenerate-on-rebase does not keep the three conflict-free, calendar-reminders and live-rooms take `depends_on: [events-meetups]`. That `depends_on` change edits lanes/<id>.md files, which a _plan commit may not do, so it is NOT applied here — it is recorded as the named lane-build fallback. The partner can verify these edits against the revised plan.md Decisions 3 and 4 and against the real generated-file behavior (core-closure.mjs) once vitana-v1 is readable next round.",
    "deferred_to": "lane-build step (lanes/*.md depends_on), only if regenerate-on-rebase proves insufficient"
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Accepted as the correct verification for the next round. Decision 7's premises — that the ESLint rule i18n/no-raw-locale-call exists at ERROR level and is enabled for apps/mobile/**, and that the extracted pure date helpers already route through fmtTime/fmtDate (vcal/time.ts:6, adapters/liveRoom.ts:8) with no raw toLocaleDateString/toLocaleTimeString/date-fns format in any branch — are load-bearing for the calendar-reminders lane and were confirmed on the worktree by the planner but could not be independently verified because vitana-v1 was inaccessible. With spar_refs now declaring exafyltd/vitana-v1: main, the next round can and must read the ESLint config and src/components/calendar/vcal/time.ts plus src/components/ui/vcard/adapters/liveRoom.ts to confirm both. No plan edit is required: the plan already mandates the locale-format helpers and bans raw calls; the next round verifies the premise against source.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Accepted and already done — this is the concrete fix for R1-F1. The events-calendar handoff.md front matter now declares `spar_refs:\n  - exafyltd/vitana-v1: main` among its other front-matter keys, before the closing ---, so PLAN-SPAR forwards the vitana-v1 pin and the next sparring session can exercise read_file/list_dir on the app's source. Verifiable at .kiro/specs/native-wave2-events-calendar/handoff.md.",
    "deferred_to": ""
  }
]
```
