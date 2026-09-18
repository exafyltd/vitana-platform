# VTID-04086 — T11: conservative dead-CSS-class removal in styles.css

## Context

Command Hub cleanup program, task T11. `services/gateway/src/frontend/command-hub/styles.css`
has no build step and was ~20,337 lines, with no way for an orphaned rule
(left behind when T1a/T1c/T1d deleted the JS render functions that used it)
to ever get flagged. New `scripts/find-dead-css-classes.mjs` conservatively
detects and removes CSS rules whose entire selector list is simple
(single class, optional pseudo-class/attribute suffix) and confirmed dead
(zero whole-word occurrence anywhere in the command-hub JS/HTML corpus,
excluding classes built via runtime string concatenation).

## Acceptance Criteria

AC-1 — `collectCssClassNames()` extracts every class name referenced in
styles.css, ignoring text inside CSS comments.
TEST: services/gateway/test/scripts/find-dead-css-classes.test.ts

AC-2 — `findDynamicClassAffixes()`/`isDynamicallyBuilt()` detect classes
built via runtime string concatenation (`'status-' + state`, `` `badge-${kind}` ``)
so they are never flagged as dead even with zero literal occurrence.
TEST: services/gateway/test/scripts/find-dead-css-classes.test.ts

AC-3 — A rule is only removed when its ENTIRE comma-separated selector
list consists of simple selectors (single class, optionally with
pseudo-class/pseudo-element/attribute suffixes) that are ALL confirmed
dead. A rule mixing a dead class with a live one is left untouched.
TEST: services/gateway/test/scripts/find-dead-css-classes.test.ts

AC-4 — A rule with a compound or descendant selector (`.dead .child`,
`.dead.other`) is never removed, even if its class is dead.
TEST: services/gateway/test/scripts/find-dead-css-classes.test.ts

AC-5 — `parseTopLevel()`/`stripDeadRules()`/`serialize()` correctly
recurse into `@media` (and other `@`-rule) blocks, removing a dead rule
nested inside one and dropping the whole block once it is empty, while
keeping a block that still has a live sibling rule.
TEST: services/gateway/test/scripts/find-dead-css-classes.test.ts

AC-6 — A class mentioned only inside a CSS comment is never treated as
live (the comment text itself is left untouched, only the real rule is
removed); a class only ever built from a template-literal prefix is kept.
TEST: services/gateway/test/scripts/find-dead-css-classes.test.ts

AC-7 — `--check` exits 0 ("in sync") once `--fix` has already been
applied, and exits 1 ("out of sync") against a still-dirty file — this is
the CI-usable drift guard.
TEST: services/gateway/test/scripts/find-dead-css-classes.test.ts

AC-8 — Report-only mode (no flags) never writes the file.
TEST: services/gateway/test/scripts/find-dead-css-classes.test.ts

AC-9 — Running the real generator against the actual repo
`services/gateway/src/frontend/command-hub/styles.css` in `--fix` mode
followed by `--check` reports "in sync" (idempotent) and the file is
still non-empty/well-formed.
TEST: services/gateway/test/scripts/find-dead-css-classes.test.ts

AC-10 — Applying `--fix` against the real repo styles.css removes 550
dead rules with no regressions in any Command Hub test suite (tsc, build,
and the full `test/command-hub/`, `test/scripts/`, and operator-console
suites that reference styles.css content all pass unmodified).
TEST: services/gateway/test/command-hub/ (291 tests), services/gateway/test/scripts/ (19 suites)
CURL: n/a — static asset content change only, no route change.

## Verification narrative

- Built the matcher with a comment/string-aware top-level CSS parser
  (`parseTopLevel`) so removal never risks corrupting a `@media` block or
  a `content: "..."` string.
- Ran `--fix` against the real `styles.css`: removed 550 rules
  (20,337 → ~18,105 lines). Manually spot-checked 5 removed classes
  (`header-bar`, `header-title`, `multimodal-controls`, `mm-btn`,
  `header-button`) confirming zero occurrence anywhere in command-hub
  JS/HTML. Many removed classes (`admin-dev-users-*`, `admin-plan-*`,
  `admin-role-*`) are confirmed orphans of the already-deleted
  `renderAdminDevUsersView` function (T1d/VTID-04063).
- Confirmed idempotency: re-running `--check` after `--fix` reports "in
  sync", 0 further removable rules, 189 remaining non-auto-removable
  candidates (share a rule with a live class, or a compound selector —
  left for a human read, per the tool's own conservative design).
- Confirmed the pre-existing off-by-one brace-count quirk in the original
  file (a `content:` string containing an unbalanced brace character) is
  identical before and after the fix — not introduced by the tool.
- `tsc --noEmit`: clean.
- `npm run build`: clean (tsc + copy-frontend + copy-data all succeed).
- Full `test/command-hub/` + `test/scripts/` suites: 19 suites, 291 tests,
  0 failures.
- 14 additional suites across the repo that read `styles.css` content in
  their assertions (operator console, cache-bust, backup-file-denylist
  tests): 242 tests, 0 failures — confirms the 550-rule removal did not
  break any test that depends on specific CSS class presence.

## Deliberately NOT done

- The 189 remaining dead-class candidates that share a rule with a live
  class, or use a compound/descendant selector, are left untouched by
  design — the tool's conservative removal criterion exists specifically
  to avoid misjudging those shapes. A human read of `styles.css` could
  clean more, but that is a separate, lower-confidence pass.
