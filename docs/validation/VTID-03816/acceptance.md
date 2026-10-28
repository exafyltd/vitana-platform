# VTID-03816 — Migrate DeepSeek call sites off retired chat/reasoner aliases to deepseek-flash

## Report

DeepSeek retired its two-tier `deepseek-chat` (V3) / `deepseek-reasoner`
(R1) naming; both are now retired aliases already silently served by
**DeepSeek-V4.1-Flash** under the hood, on a ~3-month discontinuation clock
from DeepSeek's own 2026-07-24 announcement. Verified against DeepSeek's
live API documentation (not assumed, not guessed from the display name)
that the real API model identifier for the current model is `deepseek-flash`
— "DeepSeek-V4.1-Flash" is the marketing/display name, not a literal string
the API accepts, the same relationship every other provider in this
codebase already has between a model's display name and its wire id (e.g.
`eu.anthropic.claude-sonnet-4-6` vs. "Claude Sonnet 4.6").

Every real DeepSeek call site (not test fixtures, not historical
validation-log artifacts, not already-applied migrations) was updated to
target `deepseek-flash` directly instead of waiting for the legacy aliases
to actually break: the gateway LLM router's compiled-in safe defaults and
cost table, the self-healing `architecture-investigator` agent, the
autopilot `worker-runner` execution plane's Claude→DeepSeek fallback, the
`cognee-extractor` memory/entity-extraction pipeline, the `conductor`
service's own llm-router pricing branch, and (companion PR in
`exafyltd/vitana-v1`) the i18n translation/audit tooling's
`--provider=deepseek` path.

Deliberately **not** touched: the ACTIVE row(s) in `llm_routing_policy`.
That table is normally mutated through the Command Hub, not migrations, and
this session had no live access to read its current stored JSON before
writing to it — see "Deliberately NOT attempted" below.

## Acceptance Criteria

AC-1 — Every hardcoded DeepSeek model-id literal in live gateway code now
reads `deepseek-flash`, not `deepseek-chat`/`deepseek-reasoner` (the compiled
routing defaults, the provider flagship, the recommended-models table).

TEST: `test/llm-router.test.ts` — "contains an entry for every supported
provider" now asserts `PROVIDER_FLAGSHIPS.deepseek === 'deepseek-flash'`.
See `outputs/jest-targeted-deepseek.txt`.

AC-2 — The retired `deepseek-chat`/`deepseek-reasoner` cost-table entries
are kept (not deleted), so a stored `llm_routing_policy` row still pointed
at either old literal name does not silently cost-estimate to $0.

TEST: manual read of `services/gateway/src/constants/llm-defaults.ts`
`MODEL_COSTS` in the PR diff — both retired entries present alongside the
new `deepseek-flash` entry; no existing test exercises `estimateCost()`
against these specific keys, so this is a diff-review acceptance criterion,
not an automated one — flagged rather than silently asserted as covered.

AC-3 — The autopilot execution plane (`worker-runner`) and the self-healing
root-cause agent (`architecture-investigator`) both default to
`deepseek-flash` when their fallback env vars are unset — the two processes
the platform owner specifically named mid-session as "using deepseek".

TEST: `outputs/worker-runner-tests.txt` (full 3/3-suite, 33/33-test
worker-runner run, unaffected by the default-value change since no test
pins the literal string) plus manual diff review of
`services/worker-runner/src/services/execution-service.ts` and
`services/gateway/src/services/architecture-investigator.ts`.

AC-4 — The `conductor` service's DeepSeek cost calculation prices
`deepseek-flash` correctly instead of silently falling through to the V3
rate now that "reasoner" no longer appears in the model string.

TEST: `python3 -m py_compile` (syntax only — no Python unit-test harness
exists for `services/agents/conductor` in this repo); see
`outputs/syntax-checks.txt`. The pricing branch itself
(`if "reasoner" ... elif "chat" ... else: deepseek-flash rate`) was verified
by manual read of the diff, not an automated assertion — flagged, not
silently claimed as tested.

AC-5 — `tsc --noEmit` clean for the gateway service.

TEST: `outputs/tsc-noemit.txt`.

AC-6 — Full gateway suite green.

TEST: `outputs/jest-full-suite.txt` — 737/738 suites (1 pre-existing skip),
13,673/13,708 tests passing, 0 failures.

AC-7 — The companion i18n tooling fix in `exafyltd/vitana-v1`
(`scripts/translate-keys.mjs`, `scripts/i18n-audit-llm.mjs`) is syntactically
valid.

TEST: `outputs/syntax-checks.txt` (`node --check` on both files). That
repo's own Vitest suite is unaffected — verified separately in PR
exafyltd/vitana-v1#1060, not duplicated here.

## Deliberately NOT attempted

- **Rewriting the ACTIVE `llm_routing_policy` row in Supabase.** This
  session has no live Supabase/gateway credential that would let it safely
  read the row's current JSON before writing to it (only the anonymous
  `/api/v1/vtid/allocate` endpoint was confirmed reachable, and only after
  the platform owner correctly pushed back on an earlier wrong assumption
  that no gateway endpoint was reachable at all — see commands.log). Blindly
  rewriting jsonb fields on an unverified row risks clobbering an operator's
  own Command Hub change. If any active policy row still stores a literal
  `deepseek-chat`/`deepseek-reasoner` string, an operator needs to flip it
  via the Command Hub dropdown, now offering `deepseek-flash` via the
  migration in this PR.
- **A live invocation of `deepseek-flash`** against `api.deepseek.com`. No
  `DEEPSEEK_API_KEY`/outbound network path from this sandbox. Correctness
  rests on DeepSeek's own API documentation (cited in commands.log), not a
  live response — this repo's own §2b standard ("verify a model is actually
  invokable, not just that it's listed") is not fully met here for that
  reason, and is called out explicitly rather than glossed over.
- **Forcing VTID-03816's ledger `status`/`spec_status` to `in_progress`/
  `approved` via the spec-generation pipeline.** Every exposed gateway route
  that could move those fields (`/api/v1/vtid/lifecycle/start`,
  `/api/v1/specs/:vtid/approve`) is gated on a spec already existing and
  having passed quality-check/validation first. Authoring a spec document
  after the fact, purely to satisfy that gate for already-completed,
  already-tested work, would be governance theater rather than a real
  spec review — left to an operator via the Command Hub instead of
  fabricated.
