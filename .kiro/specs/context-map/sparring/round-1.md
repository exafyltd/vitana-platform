# Sparring round 1 — in_progress

Session: `f98b0fe9-6651-4cac-a46d-cba0f846121d` · plan hash `5f6691098aada1bcfcb79b4761070ef16f540308523fb314f3c995301f7600e2`

## Summary

The plan is well-scoped, read-only and has no deploy risk. All governance-sensitive premises verified against the pinned commit hold: gateway mount at :787, domain-atlas structure, resume-vtid.sh token guard, kiro-web-session.mjs detached spawn, UNIT.yml test runner, .claude/CLAUDE.md stale stamp, CODEINTEL-SESSION-SETUP.md stale citation, CI-SCRIPTS-TEST.yml path-filter (no conflict). One premise in §2.5 is demonstrably false — live-session-controller.ts exists — and this creates an unspecified design gap in the check command's path-resolution semantics. One structural risk in the live test design warrants a minor flag.

## Findings

### R1-F1 [major]

The plan's §2.5 premise that `.claude/rules/backend.md:769` names a file that 'exists in neither checkout' is false. `live-session-controller.ts` exists at `services/gateway/src/orb/live/session/live-session-controller.ts` (3 363 lines confirmed). The backend.md reference uses a short form `session/live-session-controller.ts`; the underlying file is real and current. This false premise flows directly into the `check` command's design: the plan specifies `check` detects 'dead paths in the rule files sessions load' but never specifies how it resolves partial/relative paths embedded in markdown prose. A naive `existsSync(path)` from repo root yields a false-positive warning for this path. Under `--strict` that warning becomes exit-1, breaking any caller that relies on `check --strict` for gating. Even in non-strict mode, a spurious warning trains sessions to dismiss `check` output. By contrast, `.claude/rules/backend.md:1302` (`services/gateway/src/services/cognee-extractor-client.ts`) is a confirmed true dead reference: that file is absent from the gateway services tree. The design needs to distinguish full absolute-style paths from short prose-embedded references.

- `exafyltd/vitana-platform:services/gateway/src/orb/live/session/live-session-controller.ts:1` — /**
 * Session lifecycle controller for the ORB voice path.
- `exafyltd/vitana-platform:.claude/rules/backend.md:768` — gateway's own session reapers (`cleanupExpiredSessions()` in
`session/live-session-controller.ts`, and the `wsClientSessions` sweep in
`routes/orb-live.ts`)
- `exafyltd/vitana-platform:.claude/rules/backend.md:1300` — | File | Purpose |
|------|---------|
| `services/gateway/src/services/cognee-extractor-client.ts` | Cognee extraction + persistence |

Suggestion: Before implementation: (1) Strike `session/live-session-controller.ts` from the §2.5 stale-pointer list — it is a short-form reference to a live file, not a dead one. (2) Add a one-paragraph spec to §3 `check` defining path-resolution for rule-file scanning: e.g. 'A backtick-quoted token containing `/` is treated as a candidate path. It is resolved first as repo-root-relative; if that fails, a filename-only glob (`**/<basename>`) is tried. Only tokens for which neither match exists are reported as dead.' This prevents false positives for short-form prose references while still catching fully-qualified paths to deleted files. Update the test fixtures to cover both cases explicitly.

### R1-F2 [minor]

UNIT.yml runs on every PR with no path filter (`on: { pull_request: {} }`). The plan adds a live test 'CONTEXT-MAP has no dead link' via `context.test.mjs`, which will be discovered by `find scripts ... -name '*.test.mjs'` and executed on every PR. If any file that CONTEXT-MAP.md links to is renamed in an unrelated PR, UNIT.yml fails for that PR even though it has nothing to do with context tooling — blocking its merge until `context.mjs` or CONTEXT-MAP.md is patched. The plan's 'stable, canonical files' rationale is reasonable today, but the gateway test directory is large (hundreds of files, actively extended), and a future rename of e.g. `routes/vtid.ts` would create a UNIT.yml outage across all concurrent open PRs.

- `exafyltd/vitana-platform:.github/workflows/UNIT.yml:1` — name: unit
on: { pull_request: {} }
...
- name: Script unit tests (node:test, no install)
  run: |
    FILES=$(find scripts -path '*/node_modules' -prune -o \( -name '*.test.cjs' -o -name '*.test.mjs' \) -print | sort)
    echo "$FILES"
    node --test $FILES
- `exafyltd/vitana-platform:scripts/dev/resume-vtid.sh:1` — #!/bin/bash
# VTID-05060 — print where one VTID stands

Suggestion: Add a `--fixtures-only` flag (or a `CONTEXT_CHECK_SKIP_LIVE` env guard) to `context.test.mjs` so the file-existence assertions can be bypassed without disabling the whole suite. Set this flag in UNIT.yml so CI only runs fixture-based tests, and run the live checks in a path-filtered workflow (e.g. triggered only when `scripts/dev/**` or `docs/CONTEXT-MAP.md` changes) or as part of the existing `STAGING-VERIFY` suite. This keeps UNIT.yml blast-radius-free for unrelated PRs.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
