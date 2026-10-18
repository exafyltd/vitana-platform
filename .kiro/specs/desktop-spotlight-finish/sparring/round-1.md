# Sparring round 1 — in_progress

Session: `0291f464-87b6-4fdc-a464-8150ed38b087` · plan hash `16a15d0424ba52590cd354da4d6a61e6c5da9592b00babe65132ee87f820919a`

## Summary

The plan's factual premises about CI tooling and repository structure cannot be verified against the pinned commit. Three key issues: (1) the `ratchet-design` gate subcommand the test plan depends on does not exist in `gate.mjs`; (2) the `baseline/design.json` file the plan references does not exist and cannot be created by the current baseline tooling; (3) the `.kiro/specs/desktop-spotlight/` spec directory, `src/design/screen-manifest.json`, `docs/design-system/SPOTLIGHT_RULES.md`, and all `src/components`/`src/pages` paths referenced in the plan do not exist in vitana-platform at the pinned commit — they presumably live in vitana-v1, which is not pinned for verification. The PR-GATE is also currently report-only (`enforce: false`), so ratchet checks would not actually block merges.

## Findings

### R1-F1 [blocker]

The test plan references `gate.mjs ratchet-design` as the CI ratchet check, but no such subcommand exists in gate.mjs. The available subcommands are: scope, sparring, weakening, ratchet-tsc, ratchet-eslint, red-green, migrations, baseline-tsc, baseline-eslint. The plan's per-lane done criterion ('gate.mjs ratchet-design vs base') cannot execute.

- `exafyltd/vitana-platform:scripts/ci/pr-gate/gate.mjs:50` — const checks = { scope() {...}, sparring() {...}, weakening() {...}, 'ratchet-tsc'() {...}, 'ratchet-eslint'() {...}, 'baseline-tsc'() {...}, 'baseline-eslint'() {...}, 'red-green'() {...},
- `exafyltd/vitana-platform:scripts/ci/pr-gate/gate.mjs:192` — if (!checks[check]) {
    console.error(`unknown check "${check}". Known: ${Object.keys(checks).join(', ')}`);
    process.exit(2);

Suggestion: Clarify whether the plan intends to (a) add a new `ratchet-design` subcommand to gate.mjs (which would be new CI scope and should be declared), or (b) use the existing `ratchet-eslint` command with a filtered ESLint output containing only `design/*` rules. Either way, the plan must specify the actual command and any required changes to gate.mjs.

### R1-F2 [blocker]

The plan references `scripts/ci/pr-gate/baseline/design.json` as the ratchet baseline file (stating it carries 3,705 errors), but the `baseline` directory does not exist at the pinned commit. The gate.mjs baseline mechanism only creates `tsc.json` and `eslint.json` via `writeBaseline()`, never `design.json`. The plan's error-count target and ratchet mechanism have no functioning anchor.

- `exafyltd/vitana-platform:scripts/ci/pr-gate/gate.mjs:185` — function writeBaseline(kind, counts) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(join(BASELINE_DIR, `${kind}.json`), ...);
- `exafyltd/vitana-platform:scripts/ci/pr-gate/gate.mjs:25` — const BASELINE_DIR = 'scripts/ci/pr-gate/baseline';

Suggestion: Either the plan must create the baseline directory and `design.json` as a prerequisite step (and add the `ratchet-design` subcommand), or specify how the existing `eslint.json` baseline accommodates design-rule-specific ratcheting. This prerequisite must be explicit in the plan.

### R1-F3 [major]

The PR-GATE is currently in report-only mode (`enforce: false` in config.json). The plan relies on 'PR-GATE design ratchet' as a per-lane done criterion and a merge-blocking quality gate, but in report-only mode these checks will not actually block any PR merge. A lane could regress the baseline and still merge.

- `exafyltd/vitana-platform:scripts/ci/pr-gate/config.json:1` — {
  "enforce": false,
  "note": "VTID-04950: PR-GATE starts report-only (plan rollout: 3 days on real PRs). Set enforce=true by PR to block on failures; set it back to false as the owner's kill switch.",
  "report_only_since": "2026-10-07",

Suggestion: The plan should declare a dependency on `enforce: true` being set (at least for the ratchet checks) before any lane merges, or explain how ratchet regression is prevented when the gate is report-only.

### R1-F4 [blocker]

The plan's spec directory `.kiro/specs/desktop-spotlight/` (containing lane definitions, tasks.md, etc.) does not exist in vitana-platform at the pinned commit. The `.kiro/specs/` directory contains only: claude-sessions-handover, health-native, life-timeline, multi-tenant, new-member-welcome, pm-agent, profile-vitana-cards. Similarly, `src/design/screen-manifest.json`, `docs/design-system/SPOTLIGHT_RULES.md`, `src/components/layout/spotlight/skeletons/`, and all `src/pages`/`src/components` paths referenced in the plan do not exist in this repository. The plan appears to target vitana-v1 (the frontend app), but is pinned to vitana-platform (the backend/infrastructure repo), making it impossible to verify any premise about the codebase being changed.

- `exafyltd/vitana-platform:scripts/ci/pr-gate/config.json:5` — "red_green": {
    "test_pattern": "^services/gateway/test/.*\\.test\\.ts$",
    "cwd": "services/gateway",
    "cmd": ["npx", "jest"]
  }

Suggestion: The plan must be pinned to the correct repository (likely vitana-v1) where the frontend code, screen manifest, ESLint design rules, and Kiro specs actually live. Without this, no premise about the existing codebase can be verified. If the work spans both repos, both must be pinned and the cross-repo dependency made explicit.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
