# Responses — round 1

Planner: kiro-202610182052-5ce2 (took over the `_plan` claim after a stale release of kiro-202610152203-0347).
All four findings come from one root cause: round 1 verified the plan against vitana-platform, but every code path in
the plan is in `exafyltd/vitana-v1`. The plan block now pins `exafyltd/vitana-v1@704b5def4` and cites each file with
its line. The `file:line` refs below are vitana-v1 at that commit.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Plan corrected to name the repo. `ratchet-design` exists in exafyltd/vitana-v1, not vitana-platform: vitana-v1 scripts/ci/pr-gate/gate.mjs:100 ('ratchet-design'() reads an ESLint JSON report, counts design/* via lib.mjs:112 countDesign, compares against lib.mjs:132 chooseDesignBaseline), gate.mjs:124 'baseline-design'; the CI step is vitana-v1 .github/workflows/PR-GATE.yml:150-153 (`node scripts/ci/pr-gate/gate.mjs ratchet-design \"$RUNNER_TEMP/eslint.json\" --base \"$BASE\" --head \"$HEAD\"`), test scripts/ci/pr-gate/__tests__/design-ratchet.test.mjs. The plan block now has a 'Repos and pinned refs' section and the test plan gives the exact local commands (eslint -f json, then ratchet-design --base origin/main --head HEAD, then baseline-design). No new gate subcommand and no vitana-platform CI change is in scope."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Plan corrected to name the repo. The baseline is vitana-v1 scripts/ci/pr-gate/baseline/design.json, written by vitana-v1 gate.mjs:124 baseline-design via writeBaseline('design', ...) (gate.mjs:217-221). At 704b5def4 it holds 544 files / 3,705 errors, the figure the plan cites. The vitana-platform gate has no design baseline because that repo has no design rules. Each lane lowers only its own files' entries with baseline-design; the test plan says so."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Confirmed in vitana-v1 too: scripts/ci/pr-gate/config.json:2 has \"enforce\": false, the Design ratchet step is continue-on-error (PR-GATE.yml:152), and the Verdict step only prints 'report-only — would fail' (PR-GATE.yml:189-190). Flipping enforce is the owner's kill switch, so this plan leaves it alone. The test plan now makes the criterion explicit and checkable without enforce: a lane PR is not marked ready, and its reviewer seat does not pass it, unless the PR-GATE summary shows '✅ design ratchet' and none of design/eslint/tsc/scope/build appear in a 'would fail' line. The reviewer quotes that line in the review. Each lane also runs ratchet-design locally before pushing."
  },
  {
    "finding_id": "R1-F4",
    "disposition": "deferred",
    "rationale": "Accepted in substance: the plan now pins exafyltd/vitana-v1@704b5def4 and lists every premise path with its line (.kiro/specs/desktop-spotlight/, src/design/screen-manifest.json [346 screens: 329 migrated, 17 legacy], docs/design-system/SPOTLIGHT_RULES.md, eslint-rules/design/*.js wired at eslint.config.js:215-220, src/components/layout/spotlight/skeletons/ArchetypeSkeleton.tsx, VCardSkeleton in src/components/ui/vcard). Letting the partner read vitana-v1 is deferred because it needs a change to the sparring tooling: the session is created pinned to vitana-platform only. That fix is the existing governance lane native-g1-wiring/spar-vitana-v1-ref (executor claude; scripts/collab/plan-spar.mjs sends extra_refs {'exafyltd/vitana-v1': <sha>} and PLAN-SPAR.yml resolves the SHA). It is not duplicated here because a second lane would edit the same two files. Refs are pinned when a session is created, so after that lane merges this plan is re-pushed to open a new session that can read vitana-v1. Until a session with that ref has sparred this plan, no lane here moves approved → executing; the plan block records this gate.",
    "deferred_to": "vitana-platform .kiro/specs/native-g1-wiring/lanes/spar-vitana-v1-ref.md (branch kiro/native-g1-wiring/plan, PR #4179)"
  }
]
```
