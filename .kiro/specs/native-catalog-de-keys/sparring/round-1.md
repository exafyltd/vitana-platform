# Sparring round 1 — in_progress

Session: `627840e7-2cf0-42dd-8a2b-8b9176c91076` · plan hash `8fcafd2b6f32aa4e99c3b79f039e7f5e0533fd8084ca6f84c7c680424d7c9193`

## Summary

The plan proposes removing `_pending_review` marker objects from three i18n namespace shards in vitana-v1 to fix 25 failing tests. The plan is clearly scoped, limited to JSON data files, and declares no deployment or migration. However, **vitana-v1 is not pinned in this review session**, so I cannot directly verify any of the core factual premises about the files being changed (test logic, marker structure, German key existence, marker counts). I verified governance constraints from vitana-platform and found one structural risk and one scope concern that must be addressed.

## Findings

### R1-F1 [major]

The plan does not verify that no code path outside the three test files reads or depends on the `_pending_review` marker objects. If any translation management script, CI workflow, build step, or runtime i18n loader in either repo consumes these markers (e.g., to flag strings needing human review, to filter untranslated content, or to generate review reports), removing them silently changes behaviour beyond the test suite. The plan says 'about 1,500 shards carry them' repo-wide, implying a systematic convention — systematic conventions usually have tooling that reads them.

- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:1` — Kiro has no gateway credential, so a plan's sparring runs here.
- `exafyltd/vitana-platform:CLAUDE.md:99` — 1. **Always treat OASIS as the single source of truth** for task state, lifecycle, and governance.

Suggestion: Before implementation, grep vitana-v1 for every code path that references `_pending_review` (scripts, CI workflows, app code, i18n loaders, build tooling). Document the result in the plan: either 'no consumer found outside the test assertion' with the search evidence, or list consumers and assess impact. If a translation-management tool writes these markers, removing them without updating that tool risks them being silently re-added on the next translation pass.

### R1-F2 [minor]

The owner instruction says 'Translate them in the same PR' but the plan explicitly performs zero translation: 'No value is changed' (Decision 2), the 113 machine-translated leaves are accepted as-is (Decision 3). The plan calls this out but frames it as 'known consequence (owner-visible)'. If the owner intended actual human review or correction of the machine translations, the plan under-delivers. The risk is the owner rejects the implementation for not doing what was asked.

- `exafyltd/vitana-platform:CLAUDE.md:51` — - *Unsure of intent inside the approved plan* → choose the most conservative option (smaller change, existing pattern, nothing deleted) and list it under "Decisions taken" in Gate 2.

Suggestion: The plan already records this in Decision 3, which is good. Strengthen it: explicitly list the 113 accepted leaves (or a summary by locale × namespace) in the evidence so the owner can review the scope of what is being marked 'accepted' and make an informed decision at Gate 1. If any machine translation is obviously wrong (placeholder left in source language, garbled text), that should be flagged now, not after merge.

### R1-F3 [major]

All core premises of this plan (test assertion logic, marker object structure, German key coverage, en locale empty markers, marker counts) reference files exclusively in vitana-v1, which is not pinned in this review session and returns 'no pinned ref' on every read_file attempt. I cannot verify any of the 3+ required premises. The plan's factual basis may be correct but is currently unauditable by the sparring partner.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:6` — Owner decision 2026-10-13: Claude Code and Kiro IDE work as one team across hundreds of sessions... This file is identical in `exafyltd/vitana-platform` and `exafyltd/vitana-v1`

Suggestion: If the sparring infrastructure supports declaring a companion repo pin (the PLAN-SPAR workflow references `spar_refs`), the plan PR should declare vitana-v1 as a spar_ref so the sparring partner can read the referenced files. Alternatively, inline the critical file snippets (test assertion code, example marker JSON, German shard excerpt) directly in the plan so the partner can at least audit the logic against quoted content.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
